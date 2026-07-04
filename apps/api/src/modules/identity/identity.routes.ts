/**
 * Identity/consent routes (SPEC F9). Storefront-facing, gated by the storefront
 * api-key. The storefront calls these for guest capture (interest-flag email
 * form) and consent grant/revoke; the Auth.js signIn callback (apps/store) calls
 * the internal identity resolution via the API when a provider login occurs.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { apiKeyAuth } from '../../shared/middleware/api-key.js';
import { IdentityService } from './identity.service.js';
import { ConsentService, type ConsentType } from './consent.service.js';

const identityService = new IdentityService();
const consentService = new ConsentService();

const guestCaptureSchema = z.object({
  email: z.string().email(),
  source: z.string().max(200).optional(),
});

const consentSchema = z.object({
  userId: z.string().uuid(),
  consentType: z.enum(['flag_updates', 'general_marketing']),
  granted: z.boolean(),
  source: z.string().max(200).default('storefront'),
});

const providerResolveSchema = z.object({
  provider: z.enum(['google', 'facebook', 'email']),
  providerAccountId: z.string().min(1),
  email: z.string().email().optional(),
  emailVerified: z.boolean().optional(),
  displayName: z.string().max(200).optional(),
});

export async function identityRoutes(app: FastifyInstance) {
  app.addHook('preHandler', apiKeyAuth(['storefront:write']));

  // Guest capture — idempotent; never errors on a repeat email.
  app.post('/storefront/identity/guest', async (request, reply) => {
    const input = guestCaptureSchema.parse(request.body);
    const user = await identityService.captureGuest(input.email, input.source);
    return reply.status(200).send({ success: true, data: { id: user.id, kind: user.kind } });
  });

  // Provider resolution (Auth.js signIn callback → API). Returns the resolved
  // storefront user id for the session.
  app.post('/storefront/identity/resolve-provider', async (request, reply) => {
    const input = providerResolveSchema.parse(request.body);
    const user = await identityService.findOrCreateForProvider(input);
    return reply
      .status(200)
      .send({ success: true, data: { id: user.id, kind: user.kind, email: user.email } });
  });

  // Consent grant/revoke (append-only).
  app.post('/storefront/consent', async (request, reply) => {
    const input = consentSchema.parse(request.body);
    const type = input.consentType as ConsentType;
    const row = input.granted
      ? await consentService.grant(input.userId, type, input.source)
      : await consentService.revoke(input.userId, type, input.source);
    return reply.status(201).send({ success: true, data: { id: row.id, granted: row.granted } });
  });

  // Current consent state for a user + type.
  app.get('/storefront/consent/:userId/:consentType', async (request, reply) => {
    const params = z
      .object({ userId: z.string().uuid(), consentType: z.enum(['flag_updates', 'general_marketing']) })
      .parse(request.params);
    const granted = await consentService.currentConsent(params.userId, params.consentType as ConsentType);
    return reply.status(200).send({ success: true, data: { granted } });
  });
}
