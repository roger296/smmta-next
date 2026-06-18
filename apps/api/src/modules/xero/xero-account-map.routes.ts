/**
 * Xero account/tax map admin API (spec §A8, §A11 — UI-driven setup).
 *
 *   GET  /api/v1/xero/account-map  — every logical GL role with its resolved
 *                                    Xero account code + tax type
 *   PUT  /api/v1/xero/account-map  — upsert per-role overrides
 *
 * Seeded from the LUCA_ACCOUNTS defaults; operators remap to their own Xero
 * chart of accounts here. JWT-gated.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { xeroAccountMap } from '../../db/schema/index.js';
import { requireAuth, getAuthUser } from '../../shared/middleware/auth.js';
import {
  XERO_ACCOUNT_DEFAULTS,
  XERO_ACCOUNT_ROLES,
  ensureXeroAccountMapSeeded,
  resolveXeroAccount,
  type XeroAccountRole,
} from '../../integrations/xero/xero-account-map.js';

const putSchema = z.object({
  entries: z
    .array(
      z.object({
        role: z.enum(XERO_ACCOUNT_ROLES as [string, ...string[]]),
        xeroAccountCode: z.string().min(1).max(20),
        xeroTaxType: z.string().max(40).optional(),
      }),
    )
    .min(1),
});

export async function xeroAccountMapRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/xero/account-map', async (request) => {
    const user = getAuthUser(request);
    await ensureXeroAccountMapSeeded(user.companyId);
    const data = await Promise.all(
      XERO_ACCOUNT_ROLES.map(async (role) => {
        const resolved = await resolveXeroAccount(role, user.companyId);
        return {
          role,
          xeroAccountCode: resolved.code,
          xeroTaxType: resolved.taxType,
          defaultCode: XERO_ACCOUNT_DEFAULTS[role].code,
        };
      }),
    );
    return { success: true, data };
  });

  app.put('/xero/account-map', async (request, reply) => {
    const user = getAuthUser(request);
    const parsed = putSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const db = getDb();
    for (const entry of parsed.data.entries) {
      await db
        .insert(xeroAccountMap)
        .values({
          companyId: user.companyId,
          role: entry.role,
          xeroAccountCode: entry.xeroAccountCode,
          xeroTaxType: entry.xeroTaxType ?? 'NONE',
        })
        .onConflictDoUpdate({
          target: [xeroAccountMap.companyId, xeroAccountMap.role],
          set: {
            xeroAccountCode: entry.xeroAccountCode,
            xeroTaxType: entry.xeroTaxType ?? 'NONE',
            updatedAt: new Date(),
          },
        });
    }
    const data = await Promise.all(
      XERO_ACCOUNT_ROLES.map(async (role: XeroAccountRole) => {
        const resolved = await resolveXeroAccount(role, user.companyId);
        return { role, xeroAccountCode: resolved.code, xeroTaxType: resolved.taxType };
      }),
    );
    return { success: true, data };
  });
}
