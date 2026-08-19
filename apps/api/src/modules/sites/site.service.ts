/**
 * SiteService — CRUD for the `sites` table (spec §A5).
 *
 * Sites are the multi-location backbone: stock is held per (product, site).
 * Adding a site (incl. a USD/imperial one like Dallas, P20) is a single admin
 * action with no code change, so create/update accept currency + UoM system +
 * timezone. Slugs are unique per company.
 */
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { sites } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

export interface SiteCreateInput {
  slug: string;
  name: string;
  canonicalName?: string;
  currencyCode?: string;
  uomSystem?: 'METRIC' | 'IMPERIAL';
  timezone?: string;
  isActive?: boolean;
  /**
   * Benches per table at this site (Aug-2026 feedback, F-7). `null` clears it
   * back to "not set", which the venue screen states rather than assuming a
   * number.
   */
  benchesPerTable?: number | null;
}

export type SiteUpdateInput = Partial<SiteCreateInput>;

export type Site = typeof sites.$inferSelect;

export class SiteService {
  private db = getDb();

  async list(companyId = getSingletonCompanyId()): Promise<Site[]> {
    return this.db.query.sites.findMany({
      where: eq(sites.companyId, companyId),
      orderBy: [asc(sites.name)],
    });
  }

  async get(id: string, companyId = getSingletonCompanyId()): Promise<Site | undefined> {
    return this.db.query.sites.findFirst({
      where: and(eq(sites.id, id), eq(sites.companyId, companyId)),
    });
  }

  async getBySlug(slug: string, companyId = getSingletonCompanyId()): Promise<Site | undefined> {
    return this.db.query.sites.findFirst({
      where: and(eq(sites.slug, slug), eq(sites.companyId, companyId)),
    });
  }

  async create(input: SiteCreateInput, companyId = getSingletonCompanyId()): Promise<Site> {
    const existing = await this.getBySlug(input.slug, companyId);
    if (existing) {
      throw new SiteSlugTakenError(input.slug);
    }
    const [row] = await this.db
      .insert(sites)
      .values({
        companyId,
        slug: input.slug,
        name: input.name,
        // Default the BumbleBee canonical join string to the display name.
        canonicalName: input.canonicalName ?? input.name,
        currencyCode: input.currencyCode ?? 'GBP',
        uomSystem: input.uomSystem ?? 'METRIC',
        timezone: input.timezone ?? 'Europe/London',
        isActive: input.isActive ?? true,
        benchesPerTable: input.benchesPerTable != null ? String(input.benchesPerTable) : null,
      })
      .returning();
    return row!;
  }

  async update(
    id: string,
    patch: SiteUpdateInput,
    companyId = getSingletonCompanyId(),
  ): Promise<Site | undefined> {
    if (patch.slug) {
      const clash = await this.getBySlug(patch.slug, companyId);
      if (clash && clash.id !== id) {
        throw new SiteSlugTakenError(patch.slug);
      }
    }
    // `benchesPerTable` arrives as a number (or null) and the column is
    // numeric, which drizzle takes as a string.
    const { benchesPerTable, ...rest } = patch;
    const [row] = await this.db
      .update(sites)
      .set({
        ...rest,
        ...(benchesPerTable !== undefined
          ? { benchesPerTable: benchesPerTable === null ? null : String(benchesPerTable) }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(sites.id, id), eq(sites.companyId, companyId)))
      .returning();
    return row;
  }
}

export class SiteSlugTakenError extends Error {
  constructor(slug: string) {
    super(`A site with slug "${slug}" already exists`);
    this.name = 'SiteSlugTakenError';
  }
}
