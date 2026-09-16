/**
 * Where are we in the go-live checklist?
 *
 *   npx tsx apps/api/scripts/go-live-status.ts
 *
 * Read-only. Writes nothing, anywhere.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `docs/GO_LIVE_DATA_STEPS.md` is a procedure, not a record. It cannot tell you
 * which of its steps are already done, so on 16 Sept 2026 an operator read a
 * step finished five days earlier as outstanding work and asked what it meant.
 *
 * The answer is not a tick-list in the document — that goes stale the first
 * time somebody does a step without updating it. It is this: ask the database
 * what is actually true, every time.
 *
 * Each check mirrors one step of that document and reports DONE / TODO /
 * PARTIAL, with the number that justifies the verdict. PARTIAL matters more
 * than either of the others: "3 of 5 sites have a PIN" is the state that looks
 * finished from a distance and is not.
 */
import 'dotenv/config';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import {
  devicePins,
  products,
  recipes,
  sites,
  suppliers,
} from '../src/db/schema/index.js';
import { getEnv } from '../src/config/env.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { DEMO_BAKES } from './demo/seed-bakes.demo.js';
import { auditRecipes } from './audit-recipes.js';
import { NeedsSetupService } from '../src/modules/products/needs-setup.service.js';

export type Verdict = 'DONE' | 'PARTIAL' | 'TODO';

export interface StepStatus {
  step: string;
  title: string;
  verdict: Verdict;
  detail: string;
}

export async function goLiveStatus(companyId = getSingletonCompanyId()): Promise<StepStatus[]> {
  const db = getDb();
  const out: StepStatus[] = [];

  const activeSites = await db.query.sites.findMany({
    where: and(eq(sites.companyId, companyId), eq(sites.isActive, true)),
    columns: { id: true, name: true },
  });

  // ── 1. A head-baker PIN per site ──────────────────────────────────────
  const pins = await db.query.devicePins.findMany({
    where: and(eq(devicePins.companyId, companyId), eq(devicePins.isActive, true)),
    columns: { siteId: true, roles: true },
  });
  const bakerSites = new Set(
    pins.filter((p) => p.roles.includes('head_baker') && p.siteId).map((p) => p.siteId),
  );
  const withPin = activeSites.filter((s) => bakerSites.has(s.id));
  const missingPin = activeSites.filter((s) => !bakerSites.has(s.id));
  out.push({
    step: '1',
    title: 'Head-baker PINs, one per site',
    verdict: withPin.length === 0 ? 'TODO' : missingPin.length === 0 ? 'DONE' : 'PARTIAL',
    detail:
      `${withPin.length} of ${activeSites.length} site(s) have an active head-baker PIN` +
      (missingPin.length > 0 ? ` — missing: ${missingPin.map((s) => s.name).join(', ')}` : ''),
  });

  // ── 2. Demo cakes purged ──────────────────────────────────────────────
  // ⚠️ Counted by NAME, which is how the purge works — and "Battenburg" is
  // both a demo cake and a real one. A hit here is not proof of demo data.
  const demoLeft = await db
    .select({ bake: recipes.bake, n: sql<number>`count(*)::int` })
    .from(recipes)
    .where(and(eq(recipes.companyId, companyId), inArray(recipes.bake, DEMO_BAKES)))
    .groupBy(recipes.bake);
  out.push({
    step: '2',
    title: 'Demo cakes purged',
    verdict: demoLeft.length === 0 ? 'DONE' : 'PARTIAL',
    detail:
      demoLeft.length === 0
        ? 'No recipe carries a demo cake name'
        : `Named like demo cakes: ${demoLeft.map((d) => `${d.bake} (${d.n})`).join(', ')} — ` +
          'NB the purge matches on name, and Battenburg is both a demo cake and a real one',
  });

  // ── 3–5. Recipes imported ─────────────────────────────────────────────
  const recipeRows = await db.query.recipes.findMany({
    where: eq(recipes.companyId, companyId),
    columns: { bake: true, isActive: true, bakeType: true },
  });
  const bakes = new Set(recipeRows.map((r) => r.bake));
  out.push({
    step: '3–5',
    title: 'Recipes imported',
    verdict: recipeRows.length === 0 ? 'TODO' : 'DONE',
    detail: `${recipeRows.length} recipe version(s) across ${bakes.size} cake(s)`,
  });

  // ── 6. Audit clean ────────────────────────────────────────────────────
  const audit = recipeRows.length > 0 ? await auditRecipes(companyId) : [];
  const orphans = audit.reduce((t, a) => t + a.orphanedLines.length, 0);
  const mismatches = audit.reduce((t, a) => t + a.unitMismatches.length, 0);
  out.push({
    step: '6',
    title: 'Recipe audit clean',
    verdict: recipeRows.length === 0 ? 'TODO' : audit.length === 0 ? 'DONE' : 'PARTIAL',
    // An audit over no recipes passes trivially. Reporting that as "every line
    // points at a live product" would be true and useless — the tool would be
    // reassuring somebody about a database with nothing in it.
    detail:
      recipeRows.length === 0
        ? 'Nothing to audit — no recipes imported yet'
        : audit.length === 0
          ? 'Every recipe line points at a live product'
          : `${audit.length} recipe(s) need attention — ${orphans} dead line(s), ${mismatches} unit mismatch(es)`,
  });

  // ── 7. Suppliers ──────────────────────────────────────────────────────
  const supplierRows = await db.query.suppliers.findMany({
    where: and(eq(suppliers.companyId, companyId), isNull(suppliers.deletedAt)),
    columns: { name: true, email: true, orderEmail: true },
  });
  const orderable = supplierRows.filter((s) => s.email || s.orderEmail);
  out.push({
    step: '7',
    title: 'Suppliers imported',
    verdict: supplierRows.length === 0 ? 'TODO' : supplierRows.length < 60 ? 'PARTIAL' : 'DONE',
    detail:
      `${supplierRows.length} supplier(s); ${orderable.length} have an email ` +
      `(a PO cannot be sent to the other ${supplierRows.length - orderable.length})`,
  });

  // ── 8. Bake types + active flags tagged ───────────────────────────────
  // Everything defaults to REGULAR + active, so "all REGULAR" means nobody has
  // been through and tagged them, not that every cake really is regular.
  const tagged = recipeRows.filter((r) => r.bakeType !== 'REGULAR').length;
  const inactive = recipeRows.filter((r) => !r.isActive).length;
  out.push({
    step: '8',
    title: 'Recipes tagged (bake type + active)',
    verdict: recipeRows.length === 0 ? 'TODO' : tagged === 0 && inactive === 0 ? 'TODO' : 'DONE',
    detail:
      tagged === 0 && inactive === 0
        ? 'Every recipe is still the REGULAR + active default — nothing has been tagged'
        : `${tagged} recipe(s) tagged Corporate/Other, ${inactive} marked inactive`,
  });

  // ── 9. BumbleBee session feed ─────────────────────────────────────────
  const env = getEnv();
  out.push({
    step: '9',
    title: 'BumbleBee session feed',
    verdict: env.BUMBLEBEE_API_BASE_URL ? 'DONE' : 'TODO',
    detail: env.BUMBLEBEE_API_BASE_URL
      ? `Configured${env.BUMBLEBEE_API_KEY ? ' with a key' : ' but NO API KEY'} — run check-bumblebee.ts to confirm it answers`
      : 'Not configured — bakers type the session id by hand',
  });

  // ── 10. Needs setup ───────────────────────────────────────────────────
  const needs = await new NeedsSetupService().list(companyId);
  const stocked = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(products)
    .where(and(eq(products.companyId, companyId), isNull(products.deletedAt)));
  const catalogue = stocked[0]?.n ?? 0;
  out.push({
    step: '10',
    title: '"Needs setup" worked to zero',
    // An empty catalogue has nothing needing setup. Calling that DONE would
    // report a database with no products in it as ready to trade.
    verdict: catalogue === 0 ? 'TODO' : needs.length === 0 ? 'DONE' : 'PARTIAL',
    detail:
      catalogue === 0
        ? 'Nothing to check — the catalogue is empty'
        : needs.length === 0
          ? `No stocked product is missing its purchase unit, pack size or cost (${catalogue} in the catalogue)`
          : `${needs.length} product(s) still need setup (of ${catalogue} in the catalogue)`,
  });

  return out;
}

const isCliEntry = process.argv[1]?.endsWith('go-live-status.ts') ?? false;

if (isCliEntry) {
  const MARK: Record<Verdict, string> = { DONE: '✓', PARTIAL: '◐', TODO: '·' };
  goLiveStatus()
    .then((rows) => {
      console.log('[go-live-status] docs/GO_LIVE_DATA_STEPS.md — what is actually true\n');
      for (const r of rows) {
        console.log(`  ${MARK[r.verdict]} Step ${r.step.padEnd(4)} ${r.title}`);
        console.log(`      ${r.detail}`);
      }
      const todo = rows.filter((r) => r.verdict !== 'DONE');
      console.log('');
      if (todo.length === 0) {
        console.log('  ✓ Every step of the go-live list is done.');
        return;
      }
      console.log(`  ${todo.length} step(s) outstanding — next up:`);
      console.log(`    Step ${todo[0]!.step} — ${todo[0]!.title}`);
      console.log('');
      console.log('  ◐ means started but not finished, which is the one that looks');
      console.log('    finished from a distance. Read the detail line above it.');
    })
    .catch((err) => {
      console.error('[go-live-status] FAILED:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => void closeDatabase());
}
