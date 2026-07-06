/**
 * `npm run seed:dev` — development seed for the New Filament Store feature set
 * (Prompt 2). Idempotent: safe to re-run (unique constraints → onConflictDoNothing,
 * natural-key existence checks elsewhere).
 *
 * Seeds: a few filament SKUs with carton multiples + landed cost; three inbound
 * shipments at ETAs +70/+40/+20 days (one per pre-order band — the spec's "one
 * inbound shipment with lines and ETAs at 70/40/20 days" read as one pool per
 * band so the pricing engine has each band to exercise); two prospective
 * products; three storefront users (guest / Google-linked / trade) with consent
 * rows; and the default pricing_rules row matching SPEC §15.2 bands.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, closeDatabase } from '../src/config/database.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import {
  products,
  inboundShipments,
  inboundShipmentLines,
  prospectiveProducts,
  storefrontUsers,
  authIdentities,
  consentRecords,
  pricingRules,
  type PreorderBand,
} from '../src/db/schema/index.js';

const COMPANY = getSingletonCompanyId();

const DEFAULT_BANDS: PreorderBand[] = [
  { minDaysToEta: 60, discountBp: 2000 }, // 20%
  { minDaysToEta: 30, discountBp: 1500 }, // 15%
  { minDaysToEta: 14, discountBp: 1000 }, // 10%
  { minDaysToEta: 0, discountBp: 500 }, // 5%
];

const SKUS = [
  { sku: 'FIL-PLA-BLK-175', name: 'PLA Basic Black 1.75mm 1kg', colour: 'Black', basePounds: '19.99', cartonSize: 24, landedCostPence: 900 },
  { sku: 'FIL-PETG-BLK-175', name: 'PETG Matte Black 1.75mm 1kg', colour: 'Black', basePounds: '22.99', cartonSize: 24, landedCostPence: 1050 },
  { sku: 'FIL-PLA-GRY-175', name: 'PLA Basic Grey 1.75mm 1kg', colour: 'Grey', basePounds: '19.99', cartonSize: 24, landedCostPence: 900 },
];

function daysFromNow(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

async function ensureShipment(
  ref: string,
  mode: 'sea' | 'air',
  etaDays: number,
  sku: string,
  qtyManifested: number,
): Promise<void> {
  const db = getDb();
  const existing = await db
    .select({ id: inboundShipments.id })
    .from(inboundShipments)
    .where(and(eq(inboundShipments.companyId, COMPANY), eq(inboundShipments.reference, ref)));
  if (existing.length > 0) return;
  const eta = daysFromNow(etaDays);
  const [shipment] = await db
    .insert(inboundShipments)
    .values({
      companyId: COMPANY,
      reference: ref,
      mode,
      supplier: 'LANDU',
      etaOriginal: eta,
      eta,
      status: 'in_transit',
      bufferPct: 8,
    })
    .returning({ id: inboundShipments.id });
  await db.insert(inboundShipmentLines).values({
    companyId: COMPANY,
    shipmentId: shipment!.id,
    sku,
    qtyManifested,
    qtyPresold: 0,
  });
}

async function ensureProspective(name: string, threshold: number, creatorPartner?: string): Promise<void> {
  const db = getDb();
  const existing = await db
    .select({ id: prospectiveProducts.id })
    .from(prospectiveProducts)
    .where(and(eq(prospectiveProducts.companyId, COMPANY), eq(prospectiveProducts.name, name)));
  if (existing.length > 0) return;
  await db.insert(prospectiveProducts).values({
    companyId: COMPANY,
    name,
    status: 'considering',
    interestThreshold: threshold,
    creatorPartner,
  });
}

async function ensureUser(
  email: string,
  kind: 'guest' | 'account' | 'trade',
  displayName: string,
  verified: boolean,
): Promise<string> {
  const db = getDb();
  const found = await db
    .select({ id: storefrontUsers.id })
    .from(storefrontUsers)
    .where(eq(storefrontUsers.email, email));
  if (found[0]) return found[0].id;
  const [row] = await db
    .insert(storefrontUsers)
    .values({
      companyId: COMPANY,
      email,
      displayName,
      kind,
      emailVerified: verified ? new Date() : null,
    })
    .returning({ id: storefrontUsers.id });
  return row!.id;
}

async function ensureConsent(
  userId: string,
  consentType: 'flag_updates' | 'general_marketing',
  granted: boolean,
): Promise<void> {
  const db = getDb();
  // Consent is append-only; only add the row if the user has no consent record
  // of this type yet (keeps the seed idempotent without an UPDATE).
  const existing = await db
    .select({ id: consentRecords.id })
    .from(consentRecords)
    .where(and(eq(consentRecords.userId, userId), eq(consentRecords.consentType, consentType)));
  if (existing.length > 0) return;
  await db.insert(consentRecords).values({
    companyId: COMPANY,
    userId,
    consentType,
    granted,
    source: 'seed:dev',
  });
}

export async function seedDev(): Promise<void> {
  const db = getDb();

  // 1. Default pricing rules (SPEC §15.2). category NULL = the default ruleset.
  await db
    .insert(pricingRules)
    .values({ companyId: COMPANY, category: null, preorderBands: DEFAULT_BANDS })
    .onConflictDoNothing();

  // 2. Filament SKUs with carton multiples + landed cost.
  for (const s of SKUS) {
    await db
      .insert(products)
      .values({
        companyId: COMPANY,
        name: s.name,
        stockCode: s.sku,
        slug: s.sku.toLowerCase(),
        colour: s.colour,
        minSellingPrice: s.basePounds,
        cartonSize: s.cartonSize,
        landedCostPence: s.landedCostPence,
        isPublished: true,
      })
      .onConflictDoNothing();
  }

  // 3. Three inbound pools, one per pre-order band (ETA +70 / +40 / +20 days).
  await ensureShipment('SEA-2026-070', 'sea', 70, 'FIL-PETG-BLK-175', 480);
  await ensureShipment('SEA-2026-040', 'sea', 40, 'FIL-PLA-BLK-175', 240);
  await ensureShipment('AIR-2026-020', 'air', 20, 'FIL-PLA-GRY-175', 120);

  // 4. Prospective products (group-buy + creator colourway).
  await ensureProspective('Carbon-Fibre Nylon (PA-CF) 1.75mm', 40);
  await ensureProspective('Creator Colourway — Galaxy Purple Silk PLA', 25, '3dpprofessor');

  // 5. Three users + consent.
  const guestId = await ensureUser('guest@example.test', 'guest', 'Guest Watcher', false);
  const googleId = await ensureUser('maker@example.test', 'account', 'Ada Maker', true);
  const tradeId = await ensureUser('printfarm@example.test', 'trade', 'Print Farm Ltd', true);

  // Google-linked identity for the account user.
  await db
    .insert(authIdentities)
    .values({
      companyId: COMPANY,
      userId: googleId,
      provider: 'google',
      providerAccountId: 'google-oauth-seed-1',
    })
    .onConflictDoNothing();

  await ensureConsent(googleId, 'flag_updates', true);
  await ensureConsent(googleId, 'general_marketing', true);
  await ensureConsent(tradeId, 'flag_updates', true);
  // guest: implicit flag_updates from the watch action only.
  void guestId;

  const userRows = await db
    .select({ id: storefrontUsers.id })
    .from(storefrontUsers)
    .where(and(eq(storefrontUsers.companyId, COMPANY), isNull(storefrontUsers.mergedInto)));

  // eslint-disable-next-line no-console
  console.log(
    `[seed:dev] OK — ${SKUS.length} SKUs, 3 inbound pools, 2 prospective, ${userRows.length} users, default pricing_rules.`,
  );
}

// CLI runner (skipped when imported by a test).
const isMain = process.argv[1]?.endsWith('seed-dev.ts') || process.argv[1]?.endsWith('seed-dev.js');
if (isMain) {
  seedDev()
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[seed:dev] failed', err);
      process.exit(1);
    });
}
