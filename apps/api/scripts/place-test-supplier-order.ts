/**
 * Place one test order with a drop-ship supplier, through the same connector
 * the order placer uses, and print exactly what was sent and what came back.
 *
 * Use it before turning SUPPLIER_ORDER_PLACING_ENABLED on, to prove the
 * credentials, the order format and the reply handling against the live API.
 *
 *   Ralawise  — always sent with orderReference "APITEST", which Ralawise
 *               records but never fulfils (their documented test mode).
 *   Others    — Uneek's API has no test mode, so any order is REAL and will
 *               be charged and posted. The script refuses unless --real is
 *               given, and by default delivers to our returns address.
 *
 * Usage (inside the api container):
 *
 *   npx tsx apps/api/scripts/place-test-supplier-order.ts --supplier=ralawise --sku=GD057INBLS
 *   npx tsx apps/api/scripts/place-test-supplier-order.ts --supplier=uneek --sku=UC101BKLR --real
 *
 * Flags:
 *   --supplier=<slug>   (required) suppliers.slug
 *   --sku=<code>        (required) the supplier's SKU
 *   --qty=<n>           quantity, default 1
 *   --dry-run           print the request, send nothing
 *   --real              allow a real order with a supplier that has no test mode
 *   --name= --line1= --line2= --city= --postcode=   delivery address overrides
 */
import 'dotenv/config';
import { and, eq, isNull } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { getEnv } from '../src/config/env.js';
import { suppliers } from '../src/db/schema/index.js';
import { resolveConnector } from '../src/integrations/suppliers/registry.js';
import { SupplierError } from '../src/integrations/suppliers/errors.js';
import type { SupplierOrderRequest } from '../src/integrations/suppliers/types.js';

/** Ralawise's documented test reference: recorded, never fulfilled. */
export const RALAWISE_TEST_REFERENCE = 'APITEST';

/**
 * The order reference for a test order, or an error when a real order was not
 * asked for. Only Ralawise has a test mode.
 */
export function testOrderReference(
  connectorKind: string,
  real: boolean,
  now: Date = new Date(),
): { reference: string; isReal: boolean } {
  if (connectorKind === 'RALAWISE') return { reference: RALAWISE_TEST_REFERENCE, isReal: false };
  if (!real) {
    throw new Error(
      `${connectorKind} has no test mode, so this would be a REAL order that is charged and posted. ` +
        'Add --real to place it anyway.',
    );
  }
  // Short and unique; Ralawise-style 20-character limits are respected.
  return { reference: `TEST-${now.getTime().toString(36).toUpperCase()}`.slice(0, 20), isReal: true };
}

interface Flags {
  supplier: string;
  sku: string;
  qty: number;
  dryRun: boolean;
  real: boolean;
  name: string;
  line1: string;
  line2: string;
  city: string;
  postcode: string;
}

function parseFlags(argv: string[]): Flags {
  const get = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3).trim() : undefined;
  };
  const supplier = get('supplier');
  const sku = get('sku');
  if (!supplier || !sku) {
    console.error('Usage: place-test-supplier-order.ts --supplier=<slug> --sku=<code> [--qty=1] [--dry-run] [--real]');
    process.exit(2);
  }
  const qty = Number(get('qty') ?? '1');
  if (!Number.isInteger(qty) || qty < 1) {
    console.error('--qty must be a whole number of at least 1');
    process.exit(2);
  }
  return {
    supplier,
    sku,
    qty,
    dryRun: argv.includes('--dry-run'),
    real: argv.includes('--real'),
    // Our returns address, so a real test order comes back to us.
    name: get('name') ?? 'CleverDeals Returns',
    line1: get('line1') ?? 'Close Cottage',
    line2: get('line2') ?? 'Mow Lane, Off Congleton Road',
    city: get('city') ?? 'Stoke-on-Trent',
    postcode: get('postcode') ?? 'ST7 3PL',
  };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const supplier = await getDb().query.suppliers.findFirst({
    where: and(eq(suppliers.slug, flags.supplier), isNull(suppliers.deletedAt)),
  });
  if (!supplier) throw new Error(`No supplier with slug "${flags.supplier}".`);

  // A dry run sends nothing, so it needs no --real.
  const { reference, isReal } = testOrderReference(supplier.connectorKind, flags.real || flags.dryRun);
  const req: SupplierOrderRequest = {
    idempotencyKey: `test-order-${reference}-${Date.now()}`,
    customerOrderRef: reference,
    shipping: {
      name: flags.name,
      line1: flags.line1,
      line2: flags.line2 || undefined,
      city: flags.city,
      postCode: flags.postcode,
      country: 'GB',
    },
    lines: [{ supplierSku: flags.sku, qty: flags.qty }],
    contactEmail: getEnv().SUPPLIER_ORDER_CONTACT_EMAIL || undefined,
  };

  console.log(`[test-order] supplier: ${supplier.name} (${supplier.connectorKind})`);
  console.log(
    `[test-order] ${
      flags.dryRun
        ? 'dry run — nothing will be sent'
        : isReal
          ? 'REAL ORDER — this will be charged and posted'
          : `test reference ${reference} — not fulfilled`
    }`,
  );
  console.log('[test-order] request:', JSON.stringify(req, null, 2));
  if (flags.dryRun) {
    console.log('[test-order] dry run: nothing sent.');
    return;
  }

  try {
    const resp = await resolveConnector(supplier).placeOrder(req);
    console.log('[test-order] ACCEPTED. Order reference:', resp.orderRef);
    console.log('[test-order] supplier reply:', JSON.stringify(resp.raw ?? resp, null, 2));
  } catch (err) {
    console.error(`[test-order] FAILED: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    if (err instanceof SupplierError) {
      console.error('[test-order] status:', err.status ?? '(none)');
      console.error('[test-order] supplier reply:', JSON.stringify(err.raw, null, 2));
    }
    process.exitCode = 1;
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('place-test-supplier-order.ts')) {
  main()
    .catch((err) => {
      console.error('[test-order] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => {
      void closeDatabase();
    });
}
