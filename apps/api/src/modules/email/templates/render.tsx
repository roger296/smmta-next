/**
 * Rendering (runbook section 7 step 5). `renderSend` is what the sender
 * calls; `renderTemplate` does the work for a template key, data and contact;
 * `renderForSamples` previews a campaign as three real contacts would see it.
 *
 * After React Email renders the HTML, every shop link is passed through
 * trackLink once more, so a link from markdown or copy gets its UTM tags and
 * send id too. The plain-text part is made from that final HTML.
 */
import * as React from 'react';
import { render, toPlainText } from '@react-email/components';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { getSingletonCompanyId } from '../../../shared/auth/company.js';
import {
  customers,
  emailCampaigns,
  emailContacts,
  emailTemplates,
  storefrontUsers,
  type EmailClass,
} from '../../../db/schema/index.js';
import type { Contact } from '../services/contacts.service.js';
import type { EmailSend } from '../services/sends.service.js';
import { preferencesUrl, unsubscribeUrl } from '../lib/headers.js';
import { OFFER_BLOCKS, renderBlock, type Block } from './blocks.js';
import { Layout } from './layout.js';
import { storeUrl, trackLink, type LinkContext } from './links.js';
import { fillSubject, getTemplate, TEMPLATES, type TemplateData } from './registry.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface RenderInput {
  templateKey: string;
  cls?: EmailClass;
  kind: string;
  data: TemplateData;
  contact: Pick<Contact, 'id' | 'unsubscribeToken' | 'isTrade'>;
  firstName?: string | null;
  sendId: string;
  campaign?: { id: string; subject: string; preheader: string | null; content: Block[]; utmCampaign: string | null } | null;
}

function decodeAttr(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
}
function encodeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Tag every shop link in finished HTML. Unsubscribe and preferences links
 *  are left as they are and marked `clicktracking="off"`, so SendGrid does
 *  not wrap them in its own redirect. */
export function tagLinks(html: string, ctx: LinkContext): string {
  return html.replace(/href="([^"]*)"/g, (_m, raw: string) => {
    const url = decodeAttr(raw);
    if (/\/email\/(u|preferences)\//.test(url)) return `clicktracking="off" href="${encodeAttr(url)}"`;
    return `href="${encodeAttr(trackLink(url, ctx))}"`;
  });
}

export async function renderTemplate(input: RenderInput): Promise<RenderedEmail> {
  const def = getTemplate(input.templateKey);
  const cls = input.cls ?? def.class;
  const campaign = input.campaign ?? null;
  const ctx = {
    cls,
    kind: input.kind,
    sendId: input.sendId,
    campaignId: campaign?.id ?? null,
    utmCampaign: campaign?.utmCampaign ?? null,
    contactId: input.contact.id,
    isTrade: input.contact.isTrade,
  };

  const blocks: Block[] =
    (input.data.blocks?.length ? input.data.blocks : null) ??
    (campaign?.content?.length ? campaign.content : null) ??
    def.blocks?.(input.data) ??
    [];

  // Service mail carries no offers (spec § Sales-maximising improvements).
  if (cls === 'service') {
    const offer = blocks.find((b) => OFFER_BLOCKS.includes(b.type));
    if (offer) throw new Error(`a ${offer.type} block is an offer and cannot go in service mail`);
  }

  const subject = fillSubject(input.data.subject ?? (campaign?.subject || def.subject(input.data)), input.firstName ?? null);
  const preheader = input.data.preheader ?? campaign?.preheader ?? def.preheader?.(input.data) ?? null;

  const element = (
    <Layout
      preheader={preheader}
      cls={cls}
      why={def.why}
      storeUrl={storeUrl('/')}
      unsubscribeUrl={cls === 'marketing' ? unsubscribeUrl(input.contact.unsubscribeToken) : undefined}
      preferencesUrl={cls === 'marketing' ? preferencesUrl(input.contact.unsubscribeToken) : undefined}
    >
      {blocks.map((b, i) => renderBlock(b, ctx, i))}
    </Layout>
  );
  const html = tagLinks(await render(element), ctx);
  const text = toPlainText(html);
  return { subject, html, text };
}

async function firstNameFor(contact: Pick<Contact, 'customerId' | 'storefrontUserId'>): Promise<string | null> {
  const db = getDb();
  if (contact.storefrontUserId) {
    const [u] = await db.select({ name: storefrontUsers.displayName }).from(storefrontUsers).where(eq(storefrontUsers.id, contact.storefrontUserId));
    if (u?.name) return u.name.split(/\s+/)[0] ?? null;
  }
  if (contact.customerId) {
    const [c] = await db.select({ name: customers.name }).from(customers).where(eq(customers.id, contact.customerId));
    // Business customers are named for the business; only take a first name
    // from something that looks like a person's name.
    if (c?.name && /^[A-Z][a-z'-]+ [A-Z][A-Za-z'-]+$/.test(c.name.trim())) return c.name.trim().split(' ')[0]!;
  }
  return null;
}

async function campaignFor(id: string | null) {
  if (!id) return null;
  const [c] = await getDb().select().from(emailCampaigns).where(eq(emailCampaigns.id, id));
  if (!c) return null;
  return { id: c.id, subject: c.subject, preheader: c.preheader, content: c.content as Block[], utmCampaign: c.utmCampaign };
}

/** What the sender calls for each send. */
export async function renderSend(send: EmailSend, contact: Contact): Promise<RenderedEmail> {
  await ensureTemplatesRegistered();
  return renderTemplate({
    templateKey: send.templateKey,
    cls: send.class,
    kind: send.kind,
    data: send.data as TemplateData,
    contact,
    firstName: await firstNameFor(contact),
    sendId: send.id,
    campaign: await campaignFor(send.campaignId),
  });
}

let registered = false;
/** Record every template key at version 1 in `email_templates` (once per
 *  process), so the admin Templates page and reports have a row to name. */
export async function ensureTemplatesRegistered(): Promise<void> {
  if (registered) return;
  const db = getDb();
  for (const def of Object.values(TEMPLATES)) {
    await db
      .insert(emailTemplates)
      .values({
        companyId: getSingletonCompanyId(),
        key: def.key,
        version: 1,
        class: def.class,
        subjectTemplate: def.subject({ items: [], material: 'material:pla' }),
        bodySource: `code:templates/registry.tsx#${def.key}`,
      })
      .onConflictDoNothing();
  }
  registered = true;
}

export interface SamplePreview extends RenderedEmail {
  label: 'with interests' | 'trade' | 'new';
  contactId: string;
}

/** A campaign as three real contacts would see it: one with interests, one
 *  trade, one new. Falls back to a made-up contact when a kind is missing. */
export async function renderForSamples(
  campaign: { id: string; templateKey: string; class: EmailClass; kind: string; subject: string; preheader: string | null; content: Block[]; utmCampaign: string | null },
  n = 3,
  blocksFor?: (contact: Contact) => Promise<Block[] | null>,
): Promise<SamplePreview[]> {
  const db = getDb();
  const pick = async (where: ReturnType<typeof sql>) =>
    (await db.select().from(emailContacts).where(and(where, sql`marketing_status <> 'never'`)).orderBy(desc(emailContacts.updatedAt)).limit(1))[0];
  const chosen: Array<[SamplePreview['label'], Contact | undefined]> = [
    ['with interests', await pick(sql`interests <> '{}'::jsonb`)],
    ['trade', await pick(sql`is_trade`)],
    ['new', await pick(sql`interests = '{}'::jsonb and created_at > now() - interval '30 days'`)],
  ];
  const out: SamplePreview[] = [];
  for (const [label, found] of chosen.slice(0, n)) {
    const contact =
      found ??
      ({ id: '00000000-0000-4000-8000-000000000000', unsubscribeToken: 'preview', isTrade: label === 'trade', customerId: null, storefrontUserId: null } as unknown as Contact);
    const blocks = blocksFor ? await blocksFor(contact) : null;
    const r = await renderTemplate({
      templateKey: campaign.templateKey,
      cls: campaign.class,
      kind: campaign.kind,
      data: blocks ? { blocks } : {},
      contact,
      firstName: found ? await firstNameFor(found) : null,
      sendId: 'preview',
      campaign,
    });
    out.push({ ...r, label, contactId: contact.id });
  }
  return out;
}
