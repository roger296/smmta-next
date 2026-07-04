/**
 * Job-failure surface (SPEC §12.3 retry policy, §6 digest, §17.9).
 *
 * pg-boss records failed/dead-lettered jobs in its own schema (`<schema>.job`
 * plus the `<schema>.archive` table once retention kicks in). The daily digest
 * (Prompt 15) and the approval-queue observability read recent failures via
 * `getRecentJobFailures`.
 */
import { getPool } from '../config/database.js';
import { getEnv } from '../config/env.js';

export interface JobFailure {
  id: string;
  name: string;
  state: string;
  retryCount: number;
  output: unknown;
  createdOn: Date;
  completedOn: Date | null;
}

/**
 * Recent failed jobs across the live queue and the archive, newest first.
 * Safe to call before any job has failed (returns []).
 */
export async function getRecentJobFailures(limit = 50): Promise<JobFailure[]> {
  const schema = getEnv().PGBOSS_SCHEMA;
  const pool = getPool();
  // pg-boss owns these table names; the schema is our env-configured one. The
  // identifier is interpolated (not a bind param) because it is a schema name,
  // but it comes from server config, never user input.
  const sql = `
    SELECT id, name, state, retry_count AS "retryCount", output,
           created_on AS "createdOn", completed_on AS "completedOn"
    FROM (
      SELECT id, name, state, retry_count, output, created_on, completed_on
      FROM "${schema}".job WHERE state = 'failed'
      UNION ALL
      SELECT id, name, state, retry_count, output, created_on, completed_on
      FROM "${schema}".archive WHERE state = 'failed'
    ) f
    ORDER BY completed_on DESC NULLS LAST
    LIMIT $1
  `;
  try {
    const res = await pool.query(sql, [limit]);
    return res.rows as JobFailure[];
  } catch {
    // Schema/tables not present yet (pg-boss never started) → no failures.
    return [];
  }
}
