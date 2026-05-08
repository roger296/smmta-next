/**
 * One-shot bootstrap for the Clothes Shop storefront.
 *
 *   - Inserts the `clothes-shop` channel (slug + STOREFRONT kind) if absent.
 *   - Mints a fresh storefront API key bound to that channel.
 *   - Prints the raw key so the operator can paste it into
 *     `apps/store-clothes/.env` as `SMMTA_API_KEY=...`.
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/bootstrap-clothes-shop.ts
 *
 * Idempotent: re-running just rotates the api-key (revokes the
 * previous one for this channel and prints a new one).
 */
import 'dotenv/config';
import { and, eq, isNull } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { apiKeys, channels } from '../src/db/schema/index.js';
import { ApiKeyService } from '../src/modules/admin/api-keys.service.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';

const SLUG = 'clothes-shop';
const DISPLAY_NAME = 'Clothes Shop';

async function main() {
  const db = getDb();
  let channel = await db.query.channels.findFirst({
    where: and(eq(channels.slug, SLUG), isNull(channels.deletedAt)),
  });
  if (!channel) {
    const [created] = await db
      .insert(channels)
      .values({ slug: SLUG, kind: 'STOREFRONT', displayName: DISPLAY_NAME, isActive: true })
      .returning();
    channel = created!;
    console.log(`[bootstrap] created channel ${SLUG} (${channel.id})`);
  } else {
    console.log(`[bootstrap] channel ${SLUG} already exists (${channel.id})`);
  }

  const company = getSingletonCompanyId();

  // Revoke any existing live keys for this channel so the rotated key
  // is the only one that works.
  const existing = await db.query.apiKeys.findMany({
    where: and(
      eq(apiKeys.companyId, company),
      eq(apiKeys.channelId, channel.id),
      isNull(apiKeys.deletedAt),
    ),
  });
  for (const k of existing) {
    if (!k.revokedAt) {
      await db
        .update(apiKeys)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(eq(apiKeys.id, k.id));
      console.log(`[bootstrap] revoked previous key ${k.prefix}…`);
    }
  }

  const svc = new ApiKeyService();
  const issued = await svc.issue(company, {
    name: `clothes-shop-${new Date().toISOString().slice(0, 10)}`,
    scopes: ['storefront:read', 'storefront:write'],
  });
  // Bind the new key to the channel.
  await db
    .update(apiKeys)
    .set({ channelId: channel.id, updatedAt: new Date() })
    .where(eq(apiKeys.id, issued.row.id));

  console.log('');
  console.log('Paste into apps/store-clothes/.env:');
  console.log(`  SMMTA_API_KEY=${issued.rawKey}`);
  console.log('');
}

main()
  .catch((err) => {
    console.error('[bootstrap-clothes-shop] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabase();
  });
