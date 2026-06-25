/**
 * StockTakeLiteService (P26) — the standalone iPad stock-take demo backend.
 *
 * Deliberately decoupled from the count-vs-book stock-take: no products, no
 * ledger, no Xero. It stores what each device counted, consolidates per site,
 * flags cross-device conflicts (never sums them), and exports a plain CSV.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  stocktakeLiteCounts,
  stocktakeLiteResolutions,
} from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export interface SyncCountInput {
  itemKey: string;
  itemName: string;
  section?: string | null;
  packSize?: string | null;
  quantity: number;
  isCustom?: boolean;
}

export interface SyncInput {
  period: string;
  siteSlug: string;
  deviceId: string;
  counterName: string;
  counts: SyncCountInput[];
  companyId?: string;
}

export interface Contributor {
  deviceId: string;
  counterName: string;
  quantity: number;
  countedAt: string;
}

export type ConsolidatedStatus = 'RESOLVED' | 'CONFLICT';

export interface ConsolidatedItem {
  groupKey: string;
  itemKey: string;
  itemName: string;
  section: string | null;
  packSize: string | null;
  isCustom: boolean;
  status: ConsolidatedStatus;
  /** The agreed figure for a RESOLVED item; null while CONFLICT. */
  quantity: number | null;
  /** Set when a head-office resolution overrode a conflict. */
  resolvedBy?: string | null;
  contributors: Contributor[];
}

export interface SiteConsolidation {
  period: string;
  siteSlug: string;
  itemCount: number;
  resolvedCount: number;
  conflictCount: number;
  contributorNames: string[];
  items: ConsolidatedItem[];
}

/** Group identity used to decide "the same item across devices". Catalogue
 *  lines collide on their stable key; custom lines collide on a normalised
 *  name so two people typing "Burnt honey syrup" are treated as one item. */
function groupKeyFor(row: { itemKey: string; itemName: string; isCustom: boolean }): string {
  if (row.isCustom) {
    return `customname:${row.itemName.trim().toLowerCase().replace(/\s+/g, ' ')}`;
  }
  return row.itemKey;
}

export class StockTakeLiteService {
  private db = getDb();

  /** Upsert a device's counts. Idempotent on (company, period, device, itemKey):
   *  a re-sync of the same line updates value/time in place, never duplicates. */
  async sync(input: SyncInput): Promise<{ synced: number }> {
    const companyId = input.companyId ?? getSingletonCompanyId();
    let synced = 0;
    for (const c of input.counts) {
      const values = {
        companyId,
        period: input.period,
        siteSlug: input.siteSlug,
        deviceId: input.deviceId,
        counterName: input.counterName,
        itemKey: c.itemKey,
        itemName: c.itemName,
        section: c.section ?? null,
        packSize: c.packSize ?? null,
        quantity: String(round3(c.quantity)),
        isCustom: c.isCustom ?? false,
      };
      await this.db
        .insert(stocktakeLiteCounts)
        .values(values)
        .onConflictDoUpdate({
          target: [
            stocktakeLiteCounts.companyId,
            stocktakeLiteCounts.period,
            stocktakeLiteCounts.deviceId,
            stocktakeLiteCounts.itemKey,
          ],
          set: {
            counterName: values.counterName,
            itemName: values.itemName,
            section: values.section,
            packSize: values.packSize,
            quantity: values.quantity,
            isCustom: values.isCustom,
            countedAt: new Date(),
            updatedAt: new Date(),
          },
        });
      synced += 1;
    }
    return { synced };
  }

  /** All sites that have counts for a period, with quick progress. */
  async sites(
    period: string,
    companyId = getSingletonCompanyId(),
  ): Promise<Array<{ siteSlug: string; itemCount: number; conflictCount: number; counters: string[] }>> {
    const rows = await this.db
      .select()
      .from(stocktakeLiteCounts)
      .where(and(eq(stocktakeLiteCounts.companyId, companyId), eq(stocktakeLiteCounts.period, period)));
    const bySite = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = bySite.get(r.siteSlug) ?? [];
      list.push(r);
      bySite.set(r.siteSlug, list);
    }
    const out: Array<{ siteSlug: string; itemCount: number; conflictCount: number; counters: string[] }> = [];
    for (const [siteSlug] of bySite) {
      const con = await this.consolidate(period, siteSlug, companyId);
      out.push({
        siteSlug,
        itemCount: con.itemCount,
        conflictCount: con.conflictCount,
        counters: con.contributorNames,
      });
    }
    return out.sort((a, b) => a.siteSlug.localeCompare(b.siteSlug));
  }

  /** Consolidate one site for a period: group by item, flag cross-device
   *  conflicts, apply any head-office resolutions. */
  async consolidate(
    period: string,
    siteSlug: string,
    companyId = getSingletonCompanyId(),
  ): Promise<SiteConsolidation> {
    const rows = await this.db
      .select()
      .from(stocktakeLiteCounts)
      .where(
        and(
          eq(stocktakeLiteCounts.companyId, companyId),
          eq(stocktakeLiteCounts.period, period),
          eq(stocktakeLiteCounts.siteSlug, siteSlug),
        ),
      );

    const resolutions = await this.db
      .select()
      .from(stocktakeLiteResolutions)
      .where(
        and(
          eq(stocktakeLiteResolutions.companyId, companyId),
          eq(stocktakeLiteResolutions.period, period),
          eq(stocktakeLiteResolutions.siteSlug, siteSlug),
        ),
      );
    const resByGroup = new Map(resolutions.map((r) => [r.groupKey, r]));

    interface Group {
      groupKey: string;
      itemKey: string;
      itemName: string;
      section: string | null;
      packSize: string | null;
      isCustom: boolean;
      contributors: Contributor[];
    }
    const groups = new Map<string, Group>();
    for (const r of rows) {
      const gk = groupKeyFor(r);
      const g =
        groups.get(gk) ??
        ({
          groupKey: gk,
          itemKey: r.itemKey,
          itemName: r.itemName,
          section: r.section,
          packSize: r.packSize,
          isCustom: r.isCustom,
          contributors: [],
        } satisfies Group);
      g.contributors.push({
        deviceId: r.deviceId,
        counterName: r.counterName,
        quantity: Number(r.quantity),
        countedAt: (r.countedAt as Date).toISOString(),
      });
      groups.set(gk, g);
    }

    const items: ConsolidatedItem[] = [];
    for (const g of groups.values()) {
      const distinctDevices = new Set(g.contributors.map((c) => c.deviceId));
      const resolution = resByGroup.get(g.groupKey);
      let status: ConsolidatedStatus;
      let quantity: number | null;
      let resolvedBy: string | null | undefined;

      if (resolution) {
        status = 'RESOLVED';
        quantity = Number(resolution.resolvedQty);
        resolvedBy = resolution.resolvedBy;
      } else if (distinctDevices.size > 1) {
        status = 'CONFLICT';
        quantity = null;
      } else {
        // One device — sum its rows for this group (normally a single row).
        status = 'RESOLVED';
        quantity = round3(g.contributors.reduce((s, c) => s + c.quantity, 0));
      }

      items.push({
        groupKey: g.groupKey,
        itemKey: g.itemKey,
        itemName: g.itemName,
        section: g.section,
        packSize: g.packSize,
        isCustom: g.isCustom,
        status,
        quantity,
        resolvedBy,
        contributors: g.contributors.sort((a, b) => a.counterName.localeCompare(b.counterName)),
      });
    }

    items.sort((a, b) => a.itemName.localeCompare(b.itemName));
    const conflictCount = items.filter((i) => i.status === 'CONFLICT').length;
    const contributorNames = [...new Set(rows.map((r) => r.counterName))].sort();

    return {
      period,
      siteSlug,
      itemCount: items.length,
      resolvedCount: items.length - conflictCount,
      conflictCount,
      contributorNames,
      items,
    };
  }

  /** Record a head-office decision for a conflicted (or any) item group. */
  async resolve(input: {
    period: string;
    siteSlug: string;
    groupKey: string;
    resolvedQty: number;
    resolvedBy?: string | null;
    companyId?: string;
  }): Promise<void> {
    const companyId = input.companyId ?? getSingletonCompanyId();
    await this.db
      .insert(stocktakeLiteResolutions)
      .values({
        companyId,
        period: input.period,
        siteSlug: input.siteSlug,
        groupKey: input.groupKey,
        resolvedQty: String(round3(input.resolvedQty)),
        resolvedBy: input.resolvedBy ?? null,
      })
      .onConflictDoUpdate({
        target: [
          stocktakeLiteResolutions.companyId,
          stocktakeLiteResolutions.period,
          stocktakeLiteResolutions.siteSlug,
          stocktakeLiteResolutions.groupKey,
        ],
        set: {
          resolvedQty: String(round3(input.resolvedQty)),
          resolvedBy: input.resolvedBy ?? null,
          updatedAt: new Date(),
        },
      });
  }

  /** CSV for a period. One site (siteSlug set) or every site (omitted).
   *  Conflicts are excluded from the body and listed in a trailing note so a
   *  reader can never mistake an unresolved item for a real zero. */
  async exportCsv(
    period: string,
    siteSlug?: string,
    companyId = getSingletonCompanyId(),
  ): Promise<string> {
    const sites = siteSlug
      ? [siteSlug]
      : (await this.sites(period, companyId)).map((s) => s.siteSlug);

    const esc = (v: string | number | null | undefined): string => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines: string[] = [];
    lines.push(`# Big Bakes stock take — ${period}`);
    lines.push(`# Generated ${new Date().toISOString()}`);
    lines.push('');
    lines.push(['Site', 'Section', 'Product', 'Quantity', 'Counted by', 'Added?'].join(','));

    const conflicts: string[] = [];
    for (const site of sites) {
      const con = await this.consolidate(period, site, companyId);
      for (const item of con.items) {
        if (item.status === 'CONFLICT') {
          const detail = item.contributors
            .map((c) => `${c.counterName}=${c.quantity}`)
            .join('; ');
          conflicts.push(`# CONFLICT ${site} — ${item.itemName}: ${detail}`);
          continue;
        }
        lines.push(
          [
            esc(site),
            esc(item.section),
            esc(item.itemName),
            esc(item.quantity ?? 0),
            esc(item.contributors.map((c) => c.counterName).join(' / ')),
            esc(item.isCustom ? 'yes' : ''),
          ].join(','),
        );
      }
    }

    if (conflicts.length > 0) {
      lines.push('');
      lines.push('# Unresolved conflicts (excluded above — resolve before relying on this CSV):');
      lines.push(...conflicts);
    }

    return lines.join('\n') + '\n';
  }
}
