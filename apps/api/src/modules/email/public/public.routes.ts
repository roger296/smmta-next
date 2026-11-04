/**
 * Public unsubscribe and preferences pages (spec § Sending pipeline →
 * Unsubscribe endpoints). No login: the contact's unsubscribe token in the
 * URL is the key. Served by the API at /email/* (and /api/email/*); the
 * storefront proxies /email/* so the links in emails stay on the shop's own
 * domain.
 *
 *  POST /email/u/:token  body `List-Unsubscribe=One-Click` → transactional_only,
 *                        200 with an empty body. What Gmail and Yahoo call.
 *                        An unknown token also gets 200, so the endpoint never
 *                        says which tokens exist.
 *  GET  /email/u/:token  one-button confirmation page; its form POSTs
 *                        `confirm=1` to the same URL and gets the result page.
 *  GET|POST /email/preferences/:token  tick-box preferences.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { emailContacts } from '../../../db/schema/index.js';
import { ContactsService, type Contact } from '../services/contacts.service.js';
import { getEmailSettings } from '../services/settings.service.js';
import { clientIp, IpRateLimiter } from '../lib/ip-rate-limit.js';
import { effectiveScore, MATERIAL_KEYS } from '../lib/interests.js';
import { storefrontBaseUrl } from '../lib/config.js';
import {
  invalidLinkPage,
  layout,
  preferencesPage,
  unsubscribeConfirmPage,
  unsubscribedPage,
} from './pages.js';

export const publicPageLimiter = new IpRateLimiter(30, 60_000);
const contacts = new ContactsService();

function html(reply: FastifyReply, title: string, body: string, status = 200) {
  return reply
    .status(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('x-robots-tag', 'noindex, nofollow')
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .send(layout(title, body, storefrontBaseUrl()));
}

function form(request: FastifyRequest): URLSearchParams {
  const b = request.body;
  if (b instanceof URLSearchParams) return b;
  if (typeof b === 'string') return new URLSearchParams(b);
  if (b && typeof b === 'object') {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
      for (const one of Array.isArray(v) ? v : [v]) p.append(k, String(one));
    }
    return p;
  }
  return new URLSearchParams();
}

function who(request: FastifyRequest) {
  return {
    ip: clientIp(request.headers as Record<string, unknown>, request.ip),
    userAgent: (request.headers['user-agent'] as string | undefined)?.slice(0, 500),
  };
}

/** The page paths relative to how this request reached us. */
function paths(request: FastifyRequest, token: string) {
  const base = request.url.startsWith('/api/') ? '/api/email' : '/email';
  const t = encodeURIComponent(token);
  return { unsubscribe: `${base}/u/${t}`, preferences: `${base}/preferences/${t}` };
}

async function unsubscribe(contact: Contact, source: 'one_click' | 'link', request: FastifyRequest) {
  if (contact.marketingStatus !== 'all') return;
  await contacts.setMarketingStatus(contact.id, 'transactional_only', {
    source,
    actor: 'person',
    ...who(request),
  });
}

export async function emailPublicRoutes(app: FastifyInstance) {
  // Forms post urlencoded; Fastify has no parser for it by default. Scoped to
  // this plugin.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, new URLSearchParams(body as string)),
  );

  app.addHook('onRequest', async (request, reply) => {
    if (!publicPageLimiter.allow(clientIp(request.headers as Record<string, unknown>, request.ip))) {
      return reply.status(429).header('retry-after', '60').send('Too many requests');
    }
  });

  app.get('/email/u/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const contact = await contacts.getByToken(token);
    const p = paths(request, token);
    return html(
      reply,
      'Unsubscribe',
      unsubscribeConfirmPage({
        email: contact?.email ?? null,
        status: contact?.marketingStatus ?? null,
        action: p.unsubscribe,
        preferencesHref: contact ? p.preferences : null,
      }),
    );
  });

  app.post('/email/u/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const body = form(request);
    const contact = await contacts.getByToken(token);
    const oneClick = body.get('List-Unsubscribe') === 'One-Click';

    if (oneClick || body.get('confirm') !== '1') {
      // RFC 8058 one-click (and anything else that is not the confirm form):
      // act, answer 200 with no body, whether or not the token is known.
      if (contact) await unsubscribe(contact, 'one_click', request);
      else request.log.info({ route: 'email-one-click' }, 'one-click unsubscribe for an unknown token');
      return reply.status(200).send('');
    }

    if (contact) await unsubscribe(contact, 'link', request);
    else request.log.info({ route: 'email-unsubscribe' }, 'unsubscribe confirm for an unknown token');
    return html(reply, 'Unsubscribed', unsubscribedPage(contact ? paths(request, token).preferences : null));
  });

  const showPreferences = async (request: FastifyRequest, reply: FastifyReply, saved = false) => {
    const { token } = request.params as { token: string };
    const contact = await contacts.getByToken(token);
    if (!contact) return html(reply, 'Email preferences', invalidLinkPage(), 404);
    const settings = await getEmailSettings();
    const now = new Date();
    const threshold = settings.interest_decay.interested_threshold;
    const interests = MATERIAL_KEYS.filter((k) => effectiveScore(contact.interests[k], now) >= threshold);
    return html(
      reply,
      'Email preferences',
      preferencesPage({
        email: contact.email,
        status: contact.marketingStatus,
        interests,
        digestEnabled: contact.digestEnabled,
        newProductAlertsEnabled: contact.newProductAlertsEnabled,
        action: paths(request, token).preferences,
        saved,
      }),
    );
  };

  app.get('/email/preferences/:token', (request, reply) => showPreferences(request, reply));

  app.post('/email/preferences/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const contact = await contacts.getByToken(token);
    if (!contact) return html(reply, 'Email preferences', invalidLinkPage(), 404);
    if (contact.marketingStatus === 'never') return showPreferences(request, reply);

    const body = form(request);
    const marketing = body.get('marketing') === '1';
    const digest = body.get('digest') === '1';
    const newProducts = body.get('new_products') === '1';
    const ticked = new Set(body.getAll('interest').filter((k) => MATERIAL_KEYS.includes(k)));
    const settings = await getEmailSettings();
    const threshold = settings.interest_decay.interested_threshold;
    const now = new Date();

    // Unticking everything is an unsubscribe.
    const wantsMarketing = marketing && (digest || newProducts || ticked.size > 0);
    const evidence = { form: 'preferences_page', ...who(request) };
    if (!wantsMarketing && contact.marketingStatus === 'all') {
      await contacts.setMarketingStatus(contact.id, 'transactional_only', {
        source: 'preferences_page',
        actor: 'person',
        ...who(request),
      });
    } else if (wantsMarketing && contact.marketingStatus === 'transactional_only') {
      await contacts.setMarketingStatus(contact.id, 'all', {
        source: 'preferences_page',
        actor: 'person',
        evidence,
        ...who(request),
      });
    }

    const interests = { ...contact.interests };
    for (const key of MATERIAL_KEYS) {
      const score = effectiveScore(interests[key], now);
      if (ticked.has(key) && score < threshold) interests[key] = { score: threshold + 2, at: now.toISOString() };
      if (!ticked.has(key) && interests[key]) delete interests[key];
    }
    await getDb()
      .update(emailContacts)
      .set({ digestEnabled: digest, newProductAlertsEnabled: newProducts, interests, updatedAt: now })
      .where(eq(emailContacts.id, contact.id));

    return showPreferences(request, reply, true);
  });
}
