/**
 * The "needs setup" report (Aug-2026 feedback set, defects C-1/C-2/C-4).
 *
 * "Icing sugar displayed an incorrect default unit quantity of 1kg."
 * "Skittles displayed an incorrect base unit, preventing the 1.6kg bags from
 *  being added."
 *
 * Both are the same fault, and it is a **data** fault: those products were
 * seeded with `stockUom: 'g'`, `purchaseUom` NULL and `purchaseToStockFactor`
 * '1', so goods-in rendered a 25 kg sack as `= 1 g · £0.00/unit`. Nothing in
 * the app said a word — a product with no purchase model looks exactly like a
 * product bought in single grams.
 *
 * This is the list of every stocked product that is not ready for a venue to
 * receive, so it can be worked to zero *before* the next test rather than
 * discovered on a pallet. Each finding names what is wrong and what to do.
 */
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { products } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

/** Units where "buy in the same unit as you stock" is genuinely right. */
const DISCRETE_UOMS = ['each', 'ea', 'unit', 'units', 'item', 'items', 'pcs', 'piece'];

export type SetupIssueKind = 'NO_PURCHASE_UOM' | 'FACTOR_IS_ONE' | 'NO_COST' | 'NO_PACK_DESCRIPTION';

export interface SetupIssue {
  kind: SetupIssueKind;
  message: string;
}

export interface NeedsSetupRow {
  id: string;
  name: string;
  stockCode: string | null;
  itemKind: string;
  stockUom: string;
  purchaseUom: string | null;
  purchaseToStockFactor: string;
  packDescription: string | null;
  expectedNextCost: string | null;
  issues: SetupIssue[];
}

export function isDiscrete(uom: string): boolean {
  return DISCRETE_UOMS.includes(uom.trim().toLowerCase());
}

/**
 * What is wrong with one product's purchase model, if anything.
 *
 * Exported and pure so the rules can be asserted directly, and so the same
 * judgement can be reused at the point of booking (the blocked-line guard).
 */
export function setupIssuesFor(product: {
  stockUom: string;
  purchaseUom: string | null;
  purchaseToStockFactor: string | null;
  packDescription: string | null;
  expectedNextCost: string | null;
}): SetupIssue[] {
  const issues: SetupIssue[] = [];
  const discrete = isDiscrete(product.stockUom);
  const factor = Number(product.purchaseToStockFactor ?? 1);
  const cost = Number(product.expectedNextCost ?? 0);

  if (!product.purchaseUom && !discrete) {
    issues.push({
      kind: 'NO_PURCHASE_UOM',
      message: `Stocked in ${product.stockUom} with no purchase unit set, so a delivery reads as "= 1 ${product.stockUom}". Set the unit it is bought in.`,
    });
  }

  // A factor of exactly 1 against a non-discrete stock unit is the C-1 shape:
  // it is *possible* (a product genuinely bought by the gram) but overwhelmingly
  // it means nobody filled the factor in.
  if (!discrete && factor === 1) {
    issues.push({
      kind: 'FACTOR_IS_ONE',
      message: `1 ${product.purchaseUom ?? 'purchase unit'} = 1 ${product.stockUom}. If it is really bought in single ${product.stockUom}, this is fine; otherwise set how many ${product.stockUom} are in one ${product.purchaseUom ?? 'pack'}.`,
    });
  }

  if (!(cost > 0)) {
    issues.push({
      kind: 'NO_COST',
      message: 'No expected cost, so goods-in defaults to £0.00 and every line value is zero.',
    });
  }

  if (product.purchaseUom && !product.packDescription) {
    issues.push({
      kind: 'NO_PACK_DESCRIPTION',
      message: `No pack description. "${product.purchaseUom}" alone is a token; a baker checking a delivery note recognises "25 kg sack".`,
    });
  }

  return issues;
}

export class NeedsSetupService {
  private db = getDb();

  /**
   * Every stocked product with at least one setup issue, worst first.
   *
   * "Worst" is by issue count then name, so the products that will fail hardest
   * at a venue rise to the top of the list somebody is working through.
   */
  async list(companyId = getSingletonCompanyId()): Promise<NeedsSetupRow[]> {
    const rows = await this.db
      .select({
        id: products.id,
        name: products.name,
        stockCode: products.stockCode,
        itemKind: products.itemKind,
        stockUom: products.stockUom,
        purchaseUom: products.purchaseUom,
        purchaseToStockFactor: products.purchaseToStockFactor,
        packDescription: products.packDescription,
        expectedNextCost: products.expectedNextCost,
      })
      .from(products)
      .where(
        and(
          eq(products.companyId, companyId),
          isNull(products.deletedAt),
          eq(products.isStocked, true),
          // Cheap pre-filter so the scan below only sees plausible candidates;
          // `setupIssuesFor` still decides.
          or(
            isNull(products.purchaseUom),
            isNull(products.packDescription),
            sql`${products.purchaseToStockFactor} = 1`,
            sql`coalesce(${products.expectedNextCost}, 0) <= 0`,
          ),
        ),
      )
      .orderBy(asc(products.name));

    return rows
      .map((r) => ({ ...r, issues: setupIssuesFor(r) }))
      .filter((r) => r.issues.length > 0)
      .sort((a, b) => b.issues.length - a.issues.length || a.name.localeCompare(b.name));
  }

  /** Headline counts, for the admin page and for a go/no-go before a retest. */
  async summary(companyId = getSingletonCompanyId()): Promise<{
    total: number;
    byIssue: Record<SetupIssueKind, number>;
  }> {
    const rows = await this.list(companyId);
    const byIssue: Record<SetupIssueKind, number> = {
      NO_PURCHASE_UOM: 0,
      FACTOR_IS_ONE: 0,
      NO_COST: 0,
      NO_PACK_DESCRIPTION: 0,
    };
    for (const row of rows) {
      for (const issue of row.issues) byIssue[issue.kind] += 1;
    }
    return { total: rows.length, byIssue };
  }
}
