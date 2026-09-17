/**
 * build-google-feed.ts — write a Google Merchant Centre product feed for one
 * storefront channel, by hand.
 *
 * The worker builds both shops' feeds nightly (`google-feed-build`); this is
 * the same code with a command line, for a first run or a check. Write into a
 * directory the API serves so Google can fetch it, i.e. under UPLOADS_DIR:
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/build-google-feed.ts \
 *     --channel=clothes-shop \
 *     --base-url=https://clothes.cleverdeals.net \
 *     --out=/app/uploads/feeds/clothes-shop.xml
 *
 * Flags:
 *   --channel=<slug>        (required) storefront channel, e.g. clothes-shop.
 *   --base-url=<url>        (required) the shop's public origin.
 *   --out=<path>            (required) file to write.
 *   --shop-name=<name>      Feed title. Defaults to the channel's name.
 *   --default-shipping=<n>  Delivery for warehouse items and suppliers with no
 *                           charge of their own. Default 7.00.
 *   --exclude-out-of-stock  Leave out-of-stock items out entirely.
 *   --mode=full|stock       `full` (default) is the whole catalogue; `stock`
 *                           is the supplemental price-and-availability feed.
 *   --limit=<n>             Stop after n products (smoke test).
 *   --dry-run               Report the counts, write nothing.
 *   --help                  This message.
 */
import 'dotenv/config';
import { closeDatabase } from '../src/config/database.js';
import { buildGoogleFeed, type FeedMode } from '../src/modules/catalogue/google-feed.service.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';

interface CliOpts {
  channelSlug: string;
  baseUrl: string;
  outPath: string;
  shopName: string | null;
  defaultShippingGbp: string;
  excludeOutOfStock: boolean;
  limit: number | null;
  dryRun: boolean;
  mode: FeedMode;
}

function parseArgs(argv: string[]): CliOpts {
  let channelSlug = '';
  let baseUrl = '';
  let outPath = '';
  let shopName: string | null = null;
  let defaultShippingGbp = '7.00';
  let excludeOutOfStock = false;
  let limit: number | null = null;
  let dryRun = false;
  let mode: FeedMode = 'full';
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: tsx build-google-feed.ts --channel=<slug> --base-url=<url> --out=<path> ' +
          '[--shop-name=<name>] [--default-shipping=7.00] [--exclude-out-of-stock] [--limit=n] [--dry-run]',
      );
      process.exit(0);
    } else if (arg.startsWith('--channel=')) {
      channelSlug = arg.slice('--channel='.length).trim();
    } else if (arg.startsWith('--base-url=')) {
      baseUrl = arg.slice('--base-url='.length).trim();
    } else if (arg.startsWith('--out=')) {
      outPath = arg.slice('--out='.length).trim();
    } else if (arg.startsWith('--shop-name=')) {
      shopName = arg.slice('--shop-name='.length).trim() || null;
    } else if (arg.startsWith('--default-shipping=')) {
      const n = Number(arg.slice('--default-shipping='.length));
      if (!Number.isFinite(n) || n < 0) {
        console.error(`bad --default-shipping value: ${arg}`);
        process.exit(2);
      }
      defaultShippingGbp = n.toFixed(2);
    } else if (arg === '--exclude-out-of-stock') {
      excludeOutOfStock = true;
    } else if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length));
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`bad --limit value: ${arg}`);
        process.exit(2);
      }
      limit = Math.floor(n);
    } else if (arg === '--mode=stock') {
      mode = 'stock';
    } else if (arg === '--mode=full') {
      mode = 'full';
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('-')) {
      console.error(`unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  const missing = [
    !channelSlug && '--channel=<slug>',
    !baseUrl && '--base-url=<url>',
    !outPath && '--out=<path>',
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(`required: ${missing.join(', ')}`);
    process.exit(2);
  }
  return { channelSlug, baseUrl, outPath, shopName, defaultShippingGbp, excludeOutOfStock, limit, dryRun, mode };
}

async function main() {
  const opts = parseArgs(process.argv);
  const summary = await buildGoogleFeed({
    companyId: getSingletonCompanyId(),
    channelSlug: opts.channelSlug,
    baseUrl: opts.baseUrl,
    outPath: opts.outPath,
    shopName: opts.shopName,
    defaultShippingGbp: opts.defaultShippingGbp,
    excludeOutOfStock: opts.excludeOutOfStock,
    limit: opts.limit,
    dryRun: opts.dryRun,
    mode: opts.mode,
  });
  const skipped = Object.entries(summary.skipped)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason}=${n}`)
    .join(', ');
  console.log('');
  console.log(opts.dryRun ? '=== DRY RUN — nothing written ===' : `=== Wrote ${summary.outPath} ===`);
  console.log(`  channel             ${summary.channelSlug} (${summary.mode})`);
  console.log(`  products considered ${summary.considered}`);
  console.log(`  items in feed       ${summary.written}`);
  console.log(`  not on this channel ${summary.notOffered}`);
  if (opts.excludeOutOfStock) console.log(`  out of stock        ${summary.outOfStockExcluded}`);
  console.log(`  skipped             ${skipped || 'none'}`);
}

main()
  .catch((err) => {
    console.error('[google-feed] FATAL:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabase();
  });
