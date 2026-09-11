/**
 * Pick notes: a printable list of what to pick for an order, stored with it.
 *
 * Created automatically when an order is created or paid, re-created on demand
 * from the order page, and kept current by its content hash. When what has to
 * be picked no longer matches what was printed, the note is re-created — by the
 * worker when an order.lines_changed event says so, and in any case before a
 * stale note is served, so an out-of-date list is never handed out whichever
 * way the order was changed.
 *
 * Files sit in LABELS_DIR/pick-notes, on the same private volume as shipping
 * labels, because a pick note carries the customer's name and postcode. They
 * leave the server only through the authenticated order routes.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getEnv } from '../../config/env.js';
import { customerOrders, orderLines, orderNotes, pickNotes, stockItems } from '../../db/schema/index.js';
import {
  buildPickNoteContent,
  formatLocation,
  pickNoteHash,
  type PickNoteContent,
  type PickNoteSource,
} from './pick-note-content.js';
import { renderPickNotePdf } from './pick-note-pdf.js';

/** Filenames are always a server-generated UUID; anything else is refused. */
const FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;

export class PickNoteNotFoundError extends Error {
  constructor(orderId: string) {
    super(`Order ${orderId} not found`);
    this.name = 'PickNoteNotFoundError';
  }
}

type PickNoteRow = typeof pickNotes.$inferSelect;

export interface PickNoteSummary {
  id: string;
  orderId: string;
  status: PickNoteRow['status'];
  errorMessage: string | null;
  lineCount: number;
  unitCount: number;
  generatedAt: Date | null;
  hasFile: boolean;
  /** The order no longer matches the stored note; it is re-created before it is next served. */
  isStale: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PickNoteServiceDeps {
  dir?: string;
  now?: () => Date;
}

export class PickNoteService {
  private readonly db = getDb();

  constructor(private readonly deps: PickNoteServiceDeps = {}) {}

  private get dir(): string {
    return resolve(this.deps.dir ?? join(getEnv().LABELS_DIR, 'pick-notes'));
  }

  /**
   * Makes sure the order has a current pick note. Does nothing when the stored
   * note still matches the order, unless `force` asks for a fresh print.
   */
  async generate(orderId: string, companyId: string, opts: { force?: boolean } = {}): Promise<PickNoteSummary> {
    const { row } = await this.ensureCurrent(orderId, companyId, opts.force ?? false);
    return summarise(row, false);
  }

  /** The order's pick note record, with whether the order has changed since it was made. */
  async getForOrder(orderId: string, companyId: string): Promise<PickNoteSummary | null> {
    const [row] = await this.db
      .select()
      .from(pickNotes)
      .where(and(eq(pickNotes.orderId, orderId), eq(pickNotes.companyId, companyId)))
      .limit(1);
    if (!row) return null;
    try {
      const hash = pickNoteHash(buildPickNoteContent(await this.loadSource(orderId, companyId)));
      return summarise(row, row.contentHash !== hash);
    } catch (err) {
      if (err instanceof PickNoteNotFoundError) return summarise(row, false);
      throw err;
    }
  }

  /** The current pick note PDF, re-created first if the order has changed since it was made. */
  async readFile(orderId: string, companyId: string): Promise<{ buffer: Buffer; filename: string } | null> {
    const { row, content } = await this.ensureCurrent(orderId, companyId, false);
    if (row.status !== 'CREATED' || !row.filePath) return null;
    const name = basename(row.filePath);
    if (!FILENAME.test(name)) return null;
    try {
      return { buffer: await readFile(join(this.dir, name)), filename: `pick-note-${content.orderNumber}.pdf` };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async ensureCurrent(
    orderId: string,
    companyId: string,
    force: boolean,
  ): Promise<{ row: PickNoteRow; content: PickNoteContent }> {
    const content = buildPickNoteContent(await this.loadSource(orderId, companyId));
    const hash = pickNoteHash(content);
    let row = await this.ensureRow(orderId, companyId);

    if (!force && row.status === 'CREATED' && row.contentHash === hash && (await this.fileExists(row.filePath))) {
      return { row, content };
    }

    if (content.lines.length === 0) {
      row = await this.update(row.id, {
        status: 'FAILED',
        contentHash: hash,
        lineCount: 0,
        unitCount: 0,
        errorMessage:
          content.dropShipLines > 0
            ? 'Nothing to pick: every item on this order ships direct from a supplier.'
            : 'Nothing to pick: this order has no items.',
      });
      return { row, content };
    }

    try {
      const now = this.deps.now?.() ?? new Date();
      const pdf = await renderPickNotePdf(content, { generatedAt: now });
      const filename = `${randomUUID()}.pdf`;
      await mkdir(this.dir, { recursive: true });
      await writeFile(join(this.dir, filename), pdf);

      const previous = row.filePath;
      row = await this.update(row.id, {
        status: 'CREATED',
        filePath: filename,
        contentHash: hash,
        lineCount: content.lines.length,
        unitCount: content.totalUnits,
        errorMessage: null,
        generatedAt: now,
      });
      // The superseded print goes, so only the current list can be opened.
      if (previous && previous !== filename && FILENAME.test(basename(previous))) {
        await rm(join(this.dir, basename(previous)), { force: true }).catch(() => undefined);
      }
      return { row, content };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.update(row.id, { status: 'FAILED', errorMessage: `Could not create the pick note: ${message}`.slice(0, 2000) });
      throw err;
    }
  }

  private async loadSource(orderId: string, companyId: string): Promise<PickNoteSource> {
    const order = await this.db.query.customerOrders.findFirst({
      where: and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId), isNull(customerOrders.deletedAt)),
      with: {
        customer: true,
        deliveryAddress: true,
        lines: { where: isNull(orderLines.deletedAt), with: { product: true } },
        notes: {
          where: and(isNull(orderNotes.deletedAt), eq(orderNotes.isPickingNote, true)),
          orderBy: [asc(orderNotes.createdAt)],
        },
      },
    });
    if (!order) throw new PickNoteNotFoundError(orderId);

    const locations = await this.locationsFor(orderId, companyId, order.lines.map((l) => l.productId));

    return {
      orderNumber: order.orderNumber,
      orderDate: String(order.orderDate),
      sourceChannel: order.sourceChannel,
      deliveryName: order.deliveryAddress?.contactName ?? order.customer?.name ?? null,
      deliveryPostcode: order.deliveryAddress?.postCode ?? null,
      lines: order.lines.map((l) => ({
        productId: l.productId,
        sku: l.product?.stockCode ?? null,
        name: l.product?.name ?? 'Item',
        quantity: Number(l.quantity) || 0,
        fulfilmentSource: l.fulfilmentSource,
        locations: locations.get(l.productId) ?? [],
      })),
      pickingNotes: order.notes.map((n) => n.note),
    };
  }

  /**
   * Where to find each product: the locations of the stock allocated to this
   * order, or failing that where it is in stock. Only rows with a location
   * recorded are read.
   */
  private async locationsFor(orderId: string, companyId: string, productIds: string[]): Promise<Map<string, string[]>> {
    const ids = [...new Set(productIds)];
    const result = new Map<string, string[]>();
    if (ids.length === 0) return result;

    const rows = await this.db
      .select({
        productId: stockItems.productId,
        salesOrderId: stockItems.salesOrderId,
        status: stockItems.status,
        aisle: stockItems.locationIsle,
        shelf: stockItems.locationShelf,
        bin: stockItems.locationBin,
      })
      .from(stockItems)
      .where(
        and(
          eq(stockItems.companyId, companyId),
          inArray(stockItems.productId, ids),
          inArray(stockItems.status, ['ALLOCATED', 'IN_STOCK']),
          isNull(stockItems.deletedAt),
        ),
      );

    const allocated = new Map<string, Set<string>>();
    const inStock = new Map<string, Set<string>>();
    for (const r of rows) {
      const loc = formatLocation(r.aisle, r.shelf, r.bin);
      if (!loc) continue;
      const target = r.salesOrderId === orderId ? allocated : r.status === 'IN_STOCK' ? inStock : null;
      if (!target) continue;
      const set = target.get(r.productId) ?? new Set<string>();
      set.add(loc);
      target.set(r.productId, set);
    }
    for (const id of ids) {
      const found = allocated.get(id) ?? inStock.get(id);
      if (found) result.set(id, [...found]);
    }
    return result;
  }

  private async fileExists(filePath: string | null): Promise<boolean> {
    if (!filePath || !FILENAME.test(basename(filePath))) return false;
    try {
      await stat(join(this.dir, basename(filePath)));
      return true;
    } catch {
      return false;
    }
  }

  /** One row per order; race-safe via the unique order id. */
  private async ensureRow(orderId: string, companyId: string): Promise<PickNoteRow> {
    await this.db
      .insert(pickNotes)
      .values({ companyId, orderId, status: 'PENDING' })
      .onConflictDoNothing({ target: pickNotes.orderId });
    const [row] = await this.db.select().from(pickNotes).where(eq(pickNotes.orderId, orderId)).limit(1);
    if (!row) throw new Error(`Pick note row for order ${orderId} could not be created`);
    return row;
  }

  private async update(id: string, patch: Partial<typeof pickNotes.$inferInsert>): Promise<PickNoteRow> {
    const [row] = await this.db
      .update(pickNotes)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(pickNotes.id, id))
      .returning();
    if (!row) throw new Error(`Pick note ${id} disappeared during update`);
    return row;
  }
}

function summarise(row: PickNoteRow, isStale: boolean): PickNoteSummary {
  return {
    id: row.id,
    orderId: row.orderId,
    status: row.status,
    errorMessage: row.errorMessage,
    lineCount: row.lineCount,
    unitCount: row.unitCount,
    generatedAt: row.generatedAt,
    hasFile: row.status === 'CREATED' && !!row.filePath,
    isStale,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
