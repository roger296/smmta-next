/**
 * ApiKeyService — issue / list / revoke service api_keys for a company.
 *
 * Raw keys are returned only from `issue()`, exactly once. Other reads
 * never expose the hash.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { apiKeys } from '../../db/schema/index.js';
import { generateApiKey, hashSecret } from '../../shared/auth/api-key.js';
import type { CreateApiKeyInput } from './api-keys.schema.js';

export class ApiKeyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyValidationError';
  }
}

/** A row of `api_keys` with the hash field removed — the safe shape for
 *  any read endpoint. */
export type SafeApiKeyRow = Omit<typeof apiKeys.$inferSelect, 'keyHash'>;

function stripHash(row: typeof apiKeys.$inferSelect): SafeApiKeyRow {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { keyHash, ...rest } = row;
  return rest;
}

export class ApiKeyService {
  private db = getDb();

  /**
   * Create a new key. Returns both the persisted row (without the hash)
   * and the raw key string. The raw key is the *only* moment the secret
   * is recoverable — callers must surface it to the operator and never
   * persist it.
   */
  async issue(
    companyId: string,
    input: CreateApiKeyInput,
  ): Promise<{ row: SafeApiKeyRow; rawKey: string }> {
    const existing = await this.db.query.apiKeys.findFirst({
      where: and(
        eq(apiKeys.companyId, companyId),
        eq(apiKeys.name, input.name),
        isNull(apiKeys.deletedAt),
      ),
    });
    if (existing) {
      throw new ApiKeyValidationError(`An API key named "${input.name}" already exists`);
    }

    const { raw, prefix, secret } = generateApiKey();
    const keyHash = await hashSecret(secret);

    const [row] = await this.db
      .insert(apiKeys)
      .values({
        companyId,
        name: input.name,
        scopes: input.scopes,
        keyHash,
        prefix,
      })
      .returning();
    if (!row) throw new Error('Failed to insert api_keys row');

    return { row: stripHash(row), rawKey: raw };
  }

  /** List all live (non-deleted) keys for a company. Hash is stripped. */
  async list(companyId: string): Promise<SafeApiKeyRow[]> {
    const rows = await this.db.query.apiKeys.findMany({
      where: and(eq(apiKeys.companyId, companyId), isNull(apiKeys.deletedAt)),
      orderBy: (k, { desc }) => [desc(k.createdAt)],
    });
    return rows.map(stripHash);
  }

  /** Revoke a key by setting `revoked_at = now()`. Returns the updated
   *  row, or `null` if no live row matched (so callers can 404). */
  async revoke(id: string, companyId: string): Promise<SafeApiKeyRow | null> {
    const [row] = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, id),
          eq(apiKeys.companyId, companyId),
          isNull(apiKeys.deletedAt),
        ),
      )
      .returning();
    return row ? stripHash(row) : null;
  }
}
