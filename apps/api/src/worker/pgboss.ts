/**
 * pg-boss instance factory (SPEC §4.2).
 *
 * pg-boss runs the job queue inside the existing Postgres in its own schema,
 * so there is no Redis to run/back-up and a single pg_dump captures pending
 * jobs alongside business data. One cached instance per process.
 */
import PgBoss from 'pg-boss';
import { getEnv } from '../config/env.js';

let _boss: PgBoss | undefined;

export function getBoss(): PgBoss {
  if (!_boss) {
    const env = getEnv();
    _boss = new PgBoss({
      connectionString: env.DATABASE_URL,
      schema: env.PGBOSS_SCHEMA,
      // Keep completed/failed jobs around briefly so the digest + job-failure
      // surface (SPEC §6, §17.9) can read them before archival.
      archiveCompletedAfterSeconds: 60 * 60,
      deleteAfterDays: 7,
    });
  }
  return _boss;
}

/** Start pg-boss (idempotent — safe to call once at worker boot). */
export async function startBoss(): Promise<PgBoss> {
  const boss = getBoss();
  await boss.start();
  return boss;
}

/** Stop pg-boss and drop the cached instance (used at shutdown + in tests). */
export async function stopBoss(): Promise<void> {
  if (_boss) {
    await _boss.stop({ graceful: true, wait: true });
    _boss = undefined;
  }
}
