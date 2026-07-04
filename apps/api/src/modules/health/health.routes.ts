/**
 * Health check (SPEC §6). /healthz verifies the DB (and the pg-boss schema when
 * present) so nginx / Uptime Kuma / systemd can probe liveness. Returns 200 with
 * per-check status, or 503 if a critical check fails.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getEnv } from '../../config/env.js';

export interface HealthResult {
  status: 'ok' | 'degraded';
  checks: { db: boolean; pgboss: boolean };
}

export async function checkHealth(): Promise<HealthResult> {
  const checks = { db: false, pgboss: false };
  try {
    await getDb().execute(sql`SELECT 1`);
    checks.db = true;
  } catch {
    checks.db = false;
  }
  try {
    const schema = getEnv().PGBOSS_SCHEMA;
    const res = await getDb().execute(
      sql`SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schema}`,
    );
    checks.pgboss = (res.rows?.length ?? 0) > 0;
  } catch {
    checks.pgboss = false;
  }
  // DB is critical; pg-boss may legitimately be absent on the API host.
  return { status: checks.db ? 'ok' : 'degraded', checks };
}

export async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', async (_request, reply) => {
    const result = await checkHealth();
    return reply.status(result.status === 'ok' ? 200 : 503).send(result);
  });
}
