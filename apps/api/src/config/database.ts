import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getEnv } from './env.js';
import * as schema from '../db/schema/index.js';

let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;
let _pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!_pool) {
    const env = getEnv();
    _pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return _pool;
}

export function getDb() {
  if (!_db) {
    _db = drizzle(getPool(), { schema });
  }
  return _db;
}

export async function closeDatabase(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
    _db = undefined;
  }
}
