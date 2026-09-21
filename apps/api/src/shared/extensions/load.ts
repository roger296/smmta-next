/**
 * Extensions: code a business adds to its own copy of this repo without
 * editing the core.
 *
 * Every folder in apps/api/src/extensions that has an index.ts (index.js once
 * built) is loaded at start-up, by the API and by the worker. The folder is
 * empty upstream. A deployment that needs behaviour of its own — its own
 * sign-off steps before an order reaches the warehouse, say — keeps it in a
 * folder there, in new files, so taking a new upstream release never conflicts.
 *
 * An extension's index default-exports an ApiExtension:
 *   - key               short and unique; also names its migrations table
 *   - migrationsFolder  its own drizzle migrations, run before the API listens,
 *                       recorded in their own table so they can never collide
 *                       with the core's numbered sequence
 *   - setup()           runs in both processes: register order hold checks etc.
 *   - registerApi(app)  its routes, mounted under /api/v1
 *   - registerWorker()  its background handlers
 *
 * See apps/api/src/extensions/README.md.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb } from '../../config/database.js';

export interface ApiExtension {
  key: string;
  /** Absolute path to a drizzle migrations folder (with meta/_journal.json). */
  migrationsFolder?: string;
  setup?: () => void | Promise<void>;
  registerApi?: (app: FastifyInstance) => void | Promise<void>;
  registerWorker?: (logger: Logger) => void | Promise<void>;
}

const EXTENSIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extensions');

let loaded: Promise<ApiExtension[]> | null = null;

/** Every extension present, loaded once per process, in folder-name order. */
export function loadExtensions(dir: string = EXTENSIONS_DIR): Promise<ApiExtension[]> {
  if (dir !== EXTENSIONS_DIR) return importAll(dir);
  loaded ??= importAll(dir);
  return loaded;
}

async function importAll(dir: string): Promise<ApiExtension[]> {
  if (!existsSync(dir)) return [];
  const found: ApiExtension[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const index = ['index.ts', 'index.js'].map((f) => join(dir, entry.name, f)).find((f) => existsSync(f));
    if (!index) continue;
    const mod = (await import(pathToFileURL(index).href)) as { default?: ApiExtension };
    const ext = mod.default;
    if (!ext || typeof ext.key !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(ext.key)) {
      throw new Error(`Extension "${entry.name}" must default-export an object with a key of lower-case letters, digits and underscores`);
    }
    if (found.some((e) => e.key === ext.key)) throw new Error(`Two extensions share the key "${ext.key}"`);
    found.push(ext);
  }
  return found;
}

/** Runs each extension's own migrations. A failure stops the start-up, as a core migration would. */
export async function runExtensionMigrations(extensions: ApiExtension[]): Promise<void> {
  for (const ext of extensions) {
    if (!ext.migrationsFolder) continue;
    await migrate(getDb(), {
      migrationsFolder: ext.migrationsFolder,
      migrationsTable: `__ext_${ext.key}_migrations`,
    });
  }
}

/** For the API: migrations, setup, then routes under /api/v1. */
export async function installApiExtensions(app: FastifyInstance): Promise<void> {
  const extensions = await loadExtensions();
  if (extensions.length === 0) return;
  await runExtensionMigrations(extensions);
  for (const ext of extensions) {
    await ext.setup?.();
    if (ext.registerApi) {
      const register = ext.registerApi;
      await app.register(async (scoped) => register(scoped), { prefix: '/api/v1' });
    }
    app.log.info({ extension: ext.key }, 'extension loaded');
  }
}

/** For the worker: setup and background handlers. The API owns the migrations. */
export async function installWorkerExtensions(logger: Logger): Promise<void> {
  for (const ext of await loadExtensions()) {
    await ext.setup?.();
    await ext.registerWorker?.(logger);
    logger.info({ extension: ext.key }, 'extension loaded');
  }
}
