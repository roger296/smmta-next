/**
 * ExpectedConsumptionService (P15, spec §A6).
 *
 * Given a session (site, date, experience, covers) it computes the expected
 * consumption per ingredient = Σ(qty_per_cover × covers), resolving the recipe
 * that's effective on the session date and letting a per-site override beat the
 * global. A session can mix experiences (a booking with CLASSIC + ULTIMATE
 * lines), so `expectedForSession` aggregates across cover-groups.
 *
 * Covers/experience come from the session's order lines — BumbleBee has no
 * experience column — so `resolveCoverGroups` maps the Tonic experience product
 * on each line (`products.experience_type`) to its experience + cover count.
 */
import { and, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { products, recipeLines, recipes } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import type { ExperienceType, Recipe, RecipeLine } from './recipe.service.js';

export interface ExpectedLine {
  productId: string;
  qtyPerCover: number;
  expectedQty: number;
  stockUom: string;
  unitCost: number | null;
  expectedCost: number | null;
}

export interface CoverGroup {
  experience: ExperienceType;
  covers: number;
}

/** A session order line as polled from BumbleBee — enough to resolve covers. */
export interface SessionLine {
  productId?: string | null;
  bumblebeeProductId?: string | null;
  quantity: number;
}

export class ExpectedConsumptionService {
  private db = getDb();

  /**
   * The recipe effective for (experience, site, date). A per-site override
   * (siteId set) beats the global (siteId NULL); within the winning scope the
   * newest version effective on the date wins.
   */
  async getEffectiveRecipe(input: {
    experience: ExperienceType;
    siteId: string;
    onDate: string; // YYYY-MM-DD
    companyId?: string;
  }): Promise<{ recipe: Recipe; lines: RecipeLine[] } | null> {
    const companyId = input.companyId ?? getSingletonCompanyId();
    const effectiveOn = and(
      lte(recipes.effectiveFrom, input.onDate),
      or(isNull(recipes.effectiveTo), gt(recipes.effectiveTo, input.onDate)),
    );
    const candidates = await this.db.query.recipes.findMany({
      where: and(
        eq(recipes.companyId, companyId),
        eq(recipes.experience, input.experience),
        or(isNull(recipes.siteId), eq(recipes.siteId, input.siteId)),
        effectiveOn,
      ),
    });
    if (candidates.length === 0) return null;

    // Per-site override beats global; then newest effectiveFrom, then version.
    const siteSpecific = candidates.filter((r) => r.siteId === input.siteId);
    const scope = siteSpecific.length ? siteSpecific : candidates.filter((r) => r.siteId === null);
    scope.sort((a, b) =>
      a.effectiveFrom === b.effectiveFrom
        ? b.version - a.version
        : a.effectiveFrom < b.effectiveFrom
          ? 1
          : -1,
    );
    const recipe = scope[0];
    if (!recipe) return null;
    const lines = await this.db
      .select()
      .from(recipeLines)
      .where(eq(recipeLines.recipeId, recipe.id));
    return { recipe, lines };
  }

  /** Expected consumption per ingredient for one experience × covers. */
  async expectedForExperience(input: {
    experience: ExperienceType;
    siteId: string;
    covers: number;
    onDate: string;
    companyId?: string;
  }): Promise<ExpectedLine[]> {
    const found = await this.getEffectiveRecipe(input);
    if (!found) return [];
    return found.lines.map((l) => {
      const qtyPerCover = Number(l.qtyPerCover);
      const expectedQty = qtyPerCover * input.covers;
      const unitCost = l.unitCost != null ? Number(l.unitCost) : null;
      return {
        productId: l.productId,
        qtyPerCover,
        expectedQty,
        stockUom: l.stockUom,
        unitCost,
        expectedCost: unitCost != null ? round4(expectedQty * unitCost) : null,
      };
    });
  }

  /** Aggregate expected consumption across a session's cover-groups. */
  async expectedForSession(input: {
    siteId: string;
    onDate: string;
    coverGroups: CoverGroup[];
    companyId?: string;
  }): Promise<ExpectedLine[]> {
    const byProduct = new Map<string, ExpectedLine>();
    for (const group of input.coverGroups) {
      const lines = await this.expectedForExperience({
        experience: group.experience,
        siteId: input.siteId,
        covers: group.covers,
        onDate: input.onDate,
        companyId: input.companyId,
      });
      for (const line of lines) {
        const existing = byProduct.get(line.productId);
        if (existing) {
          existing.expectedQty = round4(existing.expectedQty + line.expectedQty);
          existing.expectedCost =
            existing.expectedCost != null && line.expectedCost != null
              ? round4(existing.expectedCost + line.expectedCost)
              : (existing.expectedCost ?? line.expectedCost);
        } else {
          byProduct.set(line.productId, { ...line });
        }
      }
    }
    return [...byProduct.values()];
  }

  /**
   * Resolve a session's cover-groups from its order lines. A line whose product
   * is a Tonic experience product (`products.experience_type` set) contributes
   * `quantity` covers to that experience; non-experience lines are ignored.
   */
  async resolveCoverGroups(
    lines: SessionLine[],
    companyId = getSingletonCompanyId(),
  ): Promise<CoverGroup[]> {
    const byProductId = new Map<string, number>();
    const byBumblebeeId = new Map<string, number>();
    for (const line of lines) {
      if (line.productId) byProductId.set(line.productId, (byProductId.get(line.productId) ?? 0) + line.quantity);
      else if (line.bumblebeeProductId)
        byBumblebeeId.set(line.bumblebeeProductId, (byBumblebeeId.get(line.bumblebeeProductId) ?? 0) + line.quantity);
    }
    const ids = [...byProductId.keys()];
    const bbIds = [...byBumblebeeId.keys()];
    const rows = await this.db.query.products.findMany({
      where: and(
        eq(products.companyId, companyId),
        or(
          ids.length ? inArray(products.id, ids) : undefined,
          bbIds.length ? inArray(products.bumblebeeProductId, bbIds) : undefined,
        ),
      ),
      columns: { id: true, bumblebeeProductId: true, experienceType: true },
    });
    const byExperience = new Map<ExperienceType, number>();
    for (const row of rows) {
      if (!row.experienceType) continue;
      const covers =
        (row.id ? byProductId.get(row.id) ?? 0 : 0) +
        (row.bumblebeeProductId ? byBumblebeeId.get(row.bumblebeeProductId) ?? 0 : 0);
      if (covers <= 0) continue;
      const exp = row.experienceType as ExperienceType;
      byExperience.set(exp, (byExperience.get(exp) ?? 0) + covers);
    }
    return [...byExperience.entries()].map(([experience, covers]) => ({ experience, covers }));
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
