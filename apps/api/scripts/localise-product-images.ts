/**
 * localise-product-images.ts — copy hotlinked catalogue images onto this server.
 *
 * New images are downloaded on the way in (see remote-image.ts), but the
 * catalogue imported before that still points at other people's servers. Those
 * links are one third-party decision away from changing: eBay swapped a batch
 * of listing images for a "no longer available" placeholder and sixteen product
 * pages changed picture, with the URLs still returning 200.
 *
 * This walks products and groups, downloads every remote image once, and
 * rewrites the references to the local copy. Idempotent: a URL already on this
 * server is skipped, so a second run is a no-op and an interrupted run can be
 * resumed by running it again.
 *
 * Runs in-process against the database rather than through the REST API,
 * unlike import-stocktake.ts. There is no endpoint for "re-point this image at
 * a local copy", and unlike stock this carries no accounting consequence — so
 * the audit-trail argument that shapes the stock scripts does not apply. It
 * MUST run inside the API container so UPLOADS_DIR is the mounted volume;
 * anywhere else it writes files that nothing will ever serve.
 *
 * Usage (inside the api container):
 *   npx tsx apps/api/scripts/localise-product-images.ts            # dry run
 *   npx tsx apps/api/scripts/localise-product-images.ts --apply
 *
 * Flags:
 *   --apply           Write. Without it nothing is downloaded or changed.
 *   --limit <n>       Stop after n distinct URLs. Useful for a first pass.
 *   --min-bytes <n>   Treat anything smaller as a placeholder rather than a
 *                     photograph, and leave the reference alone. Default 2048.
 *                     eBay's "no longer available" graphic is 1359 bytes; a
 *                     real product photo is never 1KB. Downloading one of those
 *                     would freeze the broken image in place instead of leaving
 *                     it visible as something to fix.
 *   --include-dead    Store them anyway, if you would rather have a local copy
 *                     of whatever the source currently returns.
 */
import { isNull } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { getDb } from '../src/config/database.js';
import { getEnv } from '../src/config/env.js';
import { products, productGroups, productImages } from '../src/db/schema/index.js';
import {
  RemoteImageError,
  downloadImageToUploads,
  isAlreadyLocal,
} from '../src/modules/products/remote-image.js';
import { uploadsDir } from '../src/modules/products/image-upload.routes.js';
import { statSync } from 'node:fs';
import { join } from 'node:path';

interface Args {
  apply: boolean;
  limit: number;
  minBytes: number;
  includeDead: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false, limit: Infinity, minBytes: 2048, includeDead: false };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--apply') { out.apply = true; continue; }
    if (flag === '--include-dead') { out.includeDead = true; continue; }
    if (flag === '--limit' && value) { out.limit = Number(value); i++; continue; }
    if (flag === '--min-bytes' && value) { out.minBytes = Number(value); i++; continue; }
    if (flag === '--help' || flag === '-h') { printUsage(); process.exit(0); }
    throw new Error(`Unknown argument: ${flag}`);
  }
  if (!Number.isFinite(out.minBytes) || out.minBytes < 0) {
    throw new Error(`--min-bytes must be a non-negative number`);
  }
  return out;
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    'Usage: npx tsx apps/api/scripts/localise-product-images.ts \\\n' +
      '         [--apply] [--limit <n>] [--min-bytes 2048] [--include-dead]',
  );
}

const log = (m: string) => {
  // eslint-disable-next-line no-console
  console.log(m);
};

/** Size on disk of a file we just wrote, by its public URL. */
function storedBytes(publicUrl: string): number {
  const name = publicUrl.split('/').pop()!;
  return statSync(join(uploadsDir(), name)).size;
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const db = getDb();
  const base = getEnv().APP_BASE_URL;
  const isLocal = (u: string | null | undefined) => !u || isAlreadyLocal(u, base);

  const productRows = await db
    .select({
      id: products.id,
      stockCode: products.stockCode,
      hero: products.heroImageUrl,
      gallery: products.galleryImageUrls,
    })
    .from(products)
    .where(isNull(products.deletedAt));

  const groupRows = await db
    .select({
      id: productGroups.id,
      name: productGroups.name,
      hero: productGroups.heroImageUrl,
      gallery: productGroups.galleryImageUrls,
    })
    .from(productGroups)
    .where(isNull(productGroups.deletedAt));

  const imageRows = await db
    .select({ id: productImages.id, imageUrl: productImages.imageUrl })
    .from(productImages)
    .where(isNull(productImages.deletedAt));

  // One download per distinct URL: the same artwork is shared across variants,
  // and fetching it per row would be slower and waste disk on duplicates.
  const remote = new Set<string>();
  for (const p of productRows) {
    if (!isLocal(p.hero)) remote.add(p.hero!);
    for (const g of p.gallery ?? []) if (!isLocal(g)) remote.add(g);
  }
  for (const g of groupRows) {
    if (!isLocal(g.hero)) remote.add(g.hero!);
    for (const u of g.gallery ?? []) if (!isLocal(u)) remote.add(u);
  }
  for (const r of imageRows) if (!isLocal(r.imageUrl)) remote.add(r.imageUrl);

  const urls = Array.from(remote).slice(0, args.limit);
  log(`Products: ${productRows.length}, groups: ${groupRows.length}, image rows: ${imageRows.length}`);
  log(`Distinct remote URLs to copy: ${urls.length}`);
  const byHost = new Map<string, number>();
  for (const u of urls) {
    let host = '(unparseable)';
    try { host = new URL(u).host; } catch { /* keep placeholder */ }
    byHost.set(host, (byHost.get(host) ?? 0) + 1);
  }
  for (const [host, n] of [...byHost].sort((a, b) => b[1] - a[1])) log(`  ${String(n).padStart(4)}  ${host}`);

  if (!args.apply) {
    log('');
    log('DRY RUN — nothing downloaded or changed. Re-run with --apply.');
    return;
  }

  log('');
  const mapping = new Map<string, string>();
  const failures: Array<{ url: string; reason: string }> = [];
  const suspect: Array<{ url: string; bytes: number }> = [];

  for (const url of urls) {
    try {
      const local = await downloadImageToUploads(url);
      const bytes = storedBytes(local);
      if (!args.includeDead && bytes < args.minBytes) {
        // Left pointing at the original on purpose: a visibly broken image is
        // a prompt to replace it, whereas a local copy of a placeholder looks
        // permanent and never gets fixed.
        suspect.push({ url, bytes });
        log(`  skip  ${bytes}b (looks like a placeholder) ${url}`);
        continue;
      }
      mapping.set(url, local);
      log(`  ok    ${bytes}b ${url}`);
    } catch (err) {
      const reason = err instanceof RemoteImageError ? err.message : String(err);
      failures.push({ url, reason });
      log(`  FAIL  ${url}\n          ${reason}`);
    }
  }

  if (mapping.size === 0) {
    log('');
    log('Nothing downloaded; no references changed.');
    reportTail(failures, suspect, args);
    return;
  }

  // Rewrite references only for URLs that actually downloaded. A failed or
  // skipped URL keeps pointing at the original rather than becoming null,
  // which would lose the only record of where the picture came from.
  const swap = (u: string | null) => (u && mapping.has(u) ? mapping.get(u)! : u);
  let changedProducts = 0;
  let changedGroups = 0;
  let changedRows = 0;

  for (const p of productRows) {
    const hero = swap(p.hero);
    const gallery = p.gallery ? p.gallery.map((g) => swap(g)!) : null;
    if (hero === p.hero && JSON.stringify(gallery) === JSON.stringify(p.gallery)) continue;
    await db
      .update(products)
      .set({ heroImageUrl: hero, galleryImageUrls: gallery, updatedAt: new Date() })
      .where(eq(products.id, p.id));
    changedProducts++;
  }

  for (const g of groupRows) {
    const hero = swap(g.hero);
    const gallery = g.gallery ? g.gallery.map((u) => swap(u)!) : null;
    if (hero === g.hero && JSON.stringify(gallery) === JSON.stringify(g.gallery)) continue;
    await db
      .update(productGroups)
      .set({ heroImageUrl: hero, galleryImageUrls: gallery, updatedAt: new Date() })
      .where(eq(productGroups.id, g.id));
    changedGroups++;
  }

  for (const r of imageRows) {
    const next = swap(r.imageUrl);
    if (next === r.imageUrl) continue;
    await db
      .update(productImages)
      .set({ imageUrl: next!, updatedAt: new Date() })
      .where(eq(productImages.id, r.id));
    changedRows++;
  }

  log('');
  log(`Downloaded ${mapping.size} images.`);
  log(`Updated ${changedProducts} products, ${changedGroups} groups, ${changedRows} image rows.`);
  reportTail(failures, suspect, args);
}

function reportTail(
  failures: Array<{ url: string; reason: string }>,
  suspect: Array<{ url: string; bytes: number }>,
  args: Args,
): void {
  if (suspect.length) {
    log('');
    log(`${suspect.length} look like placeholders (under ${args.minBytes} bytes) and were left alone.`);
    log('These need a real photograph uploading — the source no longer has one:');
    for (const s of suspect) log(`    ${s.bytes}b  ${s.url}`);
  }
  if (failures.length) {
    log('');
    log(`${failures.length} could not be downloaded and were left pointing at the original:`);
    for (const f of failures) log(`    ${f.url}\n      ${f.reason}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('localise-product-images failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
