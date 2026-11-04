/**
 * What the storefronts tell the email system (runbook section 12 step 10),
 * with their `storefront:write` key:
 *
 *  POST /storefront/email/consent    the checkout's marketing tick box:
 *        ticked → `all` (a form the person submitted; soft opt-in wording),
 *        unticked → `transactional_only`. Both recorded with the form as
 *        evidence. Never moves a `never` contact.
 *  POST /storefront/email/subscribe  the newsletter / footer form: active
 *        opt-in → `all`, with the interests the person picked.
 *  POST /storefront/email/cart       the basket at checkout start, with the
 *        shopper's address, for abandoned-basket emails.
 *
 * Contacts created here are address-verified with Bouncer in the background
 * (sources checkout / signup_form).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { getSingletonCompanyId } from '../../../shared/auth/company.js';
import { emailCarts, emailContacts } from '../../../db/schema/index.js';
import { apiKeyAuth } from '../../../shared/middleware/api-key.js';
import { addInterestPoints, MATERIAL_KEYS } from '../lib/interests.js';
import { ConsentTransitionError, ContactsService } from '../services/contacts.service.js';
import { getEmailSettings } from '../services/settings.service.js';

const who = z.object({ ip: z.string().max(64).optional(), userAgent: z.string().max(500).optional() });

export async function storefrontEmailRoutes(app: FastifyInstance) {
  app.addHook('preHandler', apiKeyAuth(['storefront:write']));
  const contacts = new ContactsService();

  app.post('/storefront/email/consent', async (request, reply) => {
    const b = z
      .object({ email: z.string().email().max(320), granted: z.boolean(), form: z.enum(['checkout', 'signup_form']).default('checkout'), wording: z.string().max(500).optional() })
      .merge(who)
      .parse(request.body);
    const evidence = { form: b.form, wording: b.wording, ip: b.ip, userAgent: b.userAgent, at: new Date().toISOString() };
    try {
      const { contact } = await contacts.findOrCreateByEmail(b.email, {
        source: b.form,
        actor: 'person',
        initialStatus: b.granted ? 'all' : 'transactional_only',
        evidence,
        ip: b.ip,
        userAgent: b.userAgent,
      });
      if (contact.marketingStatus !== 'never') {
        await contacts.setMarketingStatus(contact.id, b.granted ? 'all' : 'transactional_only', {
          source: b.form,
          actor: 'person',
          ip: b.ip,
          userAgent: b.userAgent,
          evidence,
        });
      }
      return { success: true, data: { ok: true } };
    } catch (err) {
      if (err instanceof ConsentTransitionError) return reply.status(422).send({ success: false, error: 'could not record consent' });
      throw err;
    }
  });

  app.post('/storefront/email/subscribe', async (request, reply) => {
    const b = z
      .object({ email: z.string().email().max(320), interests: z.array(z.string()).max(20).default([]), wording: z.string().max(500).optional() })
      .merge(who)
      .parse(request.body);
    const evidence = { form: 'signup_form', wording: b.wording, ip: b.ip, userAgent: b.userAgent, at: new Date().toISOString() };
    try {
      const { contact } = await contacts.findOrCreateByEmail(b.email, { source: 'signup_form', actor: 'person', initialStatus: 'all', evidence, ip: b.ip, userAgent: b.userAgent });
      if (contact.marketingStatus === 'transactional_only') {
        await contacts.setMarketingStatus(contact.id, 'all', { source: 'signup_form', actor: 'person', ip: b.ip, userAgent: b.userAgent, evidence });
      }
      const keys = b.interests.filter((k) => MATERIAL_KEYS.includes(k));
      if (keys.length) {
        const s = await getEmailSettings();
        const fresh = (await contacts.get(contact.id))!;
        await getDb()
          .update(emailContacts)
          .set({ interests: addInterestPoints(fresh.interests, keys, s.interest_decay.interested_threshold + 2, new Date()) })
          .where(eq(emailContacts.id, contact.id));
      }
      // The same answer whether or not the address was new: no enumeration.
      return { success: true, data: { ok: true } };
    } catch (err) {
      if (err instanceof ConsentTransitionError) return reply.status(422).send({ success: false, error: 'could not subscribe' });
      throw err;
    }
  });

  app.post('/storefront/email/cart', async (request, reply) => {
    const b = z
      .object({
        cartId: z.string().min(1).max(100),
        channel: z.string().min(1).max(64).default('storefront'),
        email: z.string().email().max(320),
        lines: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1).max(999), priceGbp: z.string().nullable().optional() })).max(100),
      })
      .parse(request.body);
    try {
      const { contact } = await contacts.findOrCreateByEmail(b.email, { source: 'checkout', actor: 'person' });
      const now = new Date();
      await getDb()
        .insert(emailCarts)
        .values({ companyId: getSingletonCompanyId(), externalCartId: b.cartId, channel: b.channel, contactId: contact.id, lines: b.lines, updatedAt: now })
        .onConflictDoUpdate({ target: [emailCarts.channel, emailCarts.externalCartId], set: { contactId: contact.id, lines: b.lines, updatedAt: now, orderedAt: null } });
      return { success: true, data: { ok: true } };
    } catch (err) {
      if (err instanceof ConsentTransitionError) return reply.status(422).send({ success: false, error: 'invalid address' });
      throw err;
    }
  });
}
