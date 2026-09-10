/**
 * Buys, stores and serves shipping labels for orders.
 *
 * The property this module exists to protect: a label is never bought twice.
 * A label costs money, and this runs from a retrying background job, so:
 *
 *   1. one row per order, keyed by a unique idempotency key;
 *   2. an order that already has a CREATED label is never sent again;
 *   3. the carrier's shipment code is saved the moment the shipment is accepted,
 *      BEFORE the PDF is fetched — so if the fetch fails, a retry resumes from
 *      that code instead of creating (and paying for) a second shipment.
 *
 * Bad order data (no postcode, say) is recorded as FAILED without calling the
 * carrier and without throwing, because retrying cannot fix it.
 *
 * Label PDFs hold customer names and addresses. They are written to LABELS_DIR,
 * which is deliberately not the publicly served /uploads directory, and are
 * only ever read back through the authenticated order routes.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getEnv } from '../../config/env.js';
import { customerOrders, orderLines, shippingLabels } from '../../db/schema/index.js';
import { SmoothParcelClient } from '../../integrations/smooth-parcel/smooth-parcel-client.js';
import {
  LabelDataError,
  buildSmoothParcelOrder,
  type LabelOrderInput,
  type MapperOptions,
} from './smooth-parcel-mapper.js';

export const SMOOTH_PARCEL_PROVIDER = 'SMOOTH_PARCEL';
export const SMOOTH_PARCEL_TRACKING_URL = 'https://app.smoothparcel.com/ListShipment/TrackMyParcel';

/** Filenames are always a server-generated UUID; anything else is refused. */
const LABEL_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;

/** Spool-box estimate when a product has no dimensions recorded. */
const DEFAULT_BOX_CM = { length: 20, width: 20, height: 8 };

export class ShippingLabelNotFoundError extends Error {
  constructor(orderId: string) {
    super(`Order ${orderId} not found`);
    this.name = 'ShippingLabelNotFoundError';
  }
}

type LabelClient = Pick<SmoothParcelClient, 'addNewOrder' | 'getShipmentLabel'>;
type LabelRow = typeof shippingLabels.$inferSelect;

export interface ShippingLabelServiceDeps {
  client?: LabelClient;
  labelsDir?: string;
  enabled?: boolean;
  now?: () => Date;
}

export interface ShippingLabelSummary {
  id: string;
  orderId: string;
  provider: string;
  status: LabelRow['status'];
  trackingNumber: string | null;
  providerOrderCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  hasLabelFile: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class ShippingLabelService {
  private readonly db = getDb();

  constructor(private readonly deps: ShippingLabelServiceDeps = {}) {}

  private get enabled(): boolean {
    return this.deps.enabled ?? getEnv().SMOOTH_PARCEL_ENABLED;
  }

  private get labelsDir(): string {
    return resolve(this.deps.labelsDir ?? getEnv().LABELS_DIR);
  }

  private client(): LabelClient {
    return this.deps.client ?? new SmoothParcelClient();
  }

  private mapperOptions(): MapperOptions {
    const env = getEnv();
    return {
      senderName: env.SMOOTH_PARCEL_SENDER_NAME,
      defaultPhone: env.SMOOTH_PARCEL_DEFAULT_PHONE,
      fallbackEmail: env.SMOOTH_PARCEL_FALLBACK_EMAIL,
      defaultWeightKg: env.SMOOTH_PARCEL_DEFAULT_WEIGHT_KG,
      defaultBoxCm: DEFAULT_BOX_CM,
      shippingDate: this.deps.now?.() ?? new Date(),
    };
  }

  static idempotencyKey(orderId: string): string {
    return `${SMOOTH_PARCEL_PROVIDER}:order:${orderId}`;
  }

  /**
   * Ensures an order has a label, buying one if needed. Safe to call any number
   * of times, from the worker or the admin button.
   */
  async requestLabel(orderId: string, companyId: string): Promise<ShippingLabelSummary> {
    const input = await this.loadOrderInput(orderId, companyId);
    let row = await this.ensureRow(orderId, companyId);

    if (row.status === 'CREATED' && row.labelPath) return summarise(row);

    if (!this.enabled) {
      row = await this.update(row.id, {
        status: 'DISABLED',
        errorMessage: 'Smooth Parcel is not connected (SMOOTH_PARCEL_ENABLED is off), so no label was bought.',
      });
      return summarise(row);
    }

    let payload;
    try {
      payload = buildSmoothParcelOrder(input, this.mapperOptions());
    } catch (err) {
      if (err instanceof LabelDataError) {
        row = await this.update(row.id, {
          status: 'FAILED',
          errorMessage: err.message,
          retryCount: row.retryCount + 1,
        });
        return summarise(row);
      }
      throw err;
    }

    const client = this.client();
    try {
      if (!row.providerOrderCode) {
        const created = await client.addNewOrder(payload);
        // Saved before the label is fetched: this is what stops a retry from
        // buying a second shipment if the fetch below fails.
        row = await this.update(row.id, {
          providerOrderCode: created.orderCode,
          trackingNumber: created.trackingNumber,
          requestPayload: payload,
          responsePayload: created.raw ?? null,
        });
      }

      const pdf = await client.getShipmentLabel(row.providerOrderCode!);
      const filename = `${randomUUID()}.pdf`;
      await mkdir(this.labelsDir, { recursive: true });
      await writeFile(join(this.labelsDir, filename), pdf);

      row = await this.update(row.id, { status: 'CREATED', labelPath: filename, errorMessage: null });

      if (row.trackingNumber) {
        await this.db
          .update(customerOrders)
          .set({
            trackingNumber: row.trackingNumber,
            trackingLink: SMOOTH_PARCEL_TRACKING_URL,
            updatedAt: new Date(),
          })
          .where(eq(customerOrders.id, orderId));
      }
      return summarise(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.update(row.id, {
        status: 'FAILED',
        errorMessage: message.slice(0, 2000),
        retryCount: row.retryCount + 1,
      });
      // Rethrown so the worker's retry policy applies to transient failures.
      throw err;
    }
  }

  async latestForOrder(orderId: string, companyId: string): Promise<ShippingLabelSummary | null> {
    const [row] = await this.db
      .select()
      .from(shippingLabels)
      .where(and(eq(shippingLabels.orderId, orderId), eq(shippingLabels.companyId, companyId)))
      .orderBy(desc(shippingLabels.createdAt))
      .limit(1);
    return row ? summarise(row) : null;
  }

  /** The stored PDF for an order, or null if there is none. */
  async readLabelFile(
    orderId: string,
    companyId: string,
  ): Promise<{ buffer: Buffer; filename: string } | null> {
    const [row] = await this.db
      .select({
        labelPath: shippingLabels.labelPath,
        status: shippingLabels.status,
        orderNumber: customerOrders.orderNumber,
      })
      .from(shippingLabels)
      .innerJoin(customerOrders, eq(customerOrders.id, shippingLabels.orderId))
      .where(and(eq(shippingLabels.orderId, orderId), eq(shippingLabels.companyId, companyId)))
      .orderBy(desc(shippingLabels.createdAt))
      .limit(1);
    if (!row || row.status !== 'CREATED' || !row.labelPath) return null;

    const name = basename(row.labelPath);
    if (!LABEL_FILENAME.test(name)) return null;
    try {
      const buffer = await readFile(join(this.labelsDir, name));
      return { buffer, filename: `label-${row.orderNumber}.pdf` };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async loadOrderInput(orderId: string, companyId: string): Promise<LabelOrderInput> {
    const order = await this.db.query.customerOrders.findFirst({
      where: and(
        eq(customerOrders.id, orderId),
        eq(customerOrders.companyId, companyId),
        isNull(customerOrders.deletedAt),
      ),
      with: {
        customer: true,
        deliveryAddress: true,
        lines: { where: isNull(orderLines.deletedAt), with: { product: true } },
      },
    });
    if (!order) throw new ShippingLabelNotFoundError(orderId);

    const num = (v: string | number | null | undefined) => {
      const n = typeof v === 'number' ? v : Number(v ?? NaN);
      return Number.isFinite(n) ? n : null;
    };
    const addr = order.deliveryAddress;
    return {
      orderNumber: order.orderNumber,
      orderDate: String(order.orderDate),
      customerName: order.customer?.name ?? '',
      customerEmail: order.customer?.email ?? null,
      address: {
        contactName: addr?.contactName ?? null,
        line1: addr?.line1 ?? null,
        line2: addr?.line2 ?? null,
        city: addr?.city ?? null,
        region: addr?.region ?? null,
        postCode: addr?.postCode ?? null,
        country: addr?.country ?? null,
        phone: addr?.phone ?? null,
      },
      lines: (order.lines ?? []).map((l) => ({
        sku: l.product?.stockCode ?? null,
        name: l.product?.name ?? 'Item',
        quantity: num(l.quantity) ?? 1,
        unitPriceGbp: num(l.pricePerUnit) ?? 0,
        weightKg: num(l.product?.weight),
        lengthCm: num(l.product?.length),
        widthCm: num(l.product?.width),
        heightCm: num(l.product?.height),
      })),
    };
  }

  /** Creates the order's label row if absent; race-safe via the unique key. */
  private async ensureRow(orderId: string, companyId: string): Promise<LabelRow> {
    const key = ShippingLabelService.idempotencyKey(orderId);
    await this.db
      .insert(shippingLabels)
      .values({ companyId, orderId, provider: SMOOTH_PARCEL_PROVIDER, idempotencyKey: key, status: 'PENDING' })
      .onConflictDoNothing({ target: shippingLabels.idempotencyKey });
    const [row] = await this.db
      .select()
      .from(shippingLabels)
      .where(eq(shippingLabels.idempotencyKey, key))
      .limit(1);
    if (!row) throw new Error(`Shipping label row for order ${orderId} could not be created`);
    return row;
  }

  private async update(id: string, patch: Partial<typeof shippingLabels.$inferInsert>): Promise<LabelRow> {
    const [row] = await this.db
      .update(shippingLabels)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(shippingLabels.id, id))
      .returning();
    if (!row) throw new Error(`Shipping label ${id} disappeared during update`);
    return row;
  }
}

function summarise(row: LabelRow): ShippingLabelSummary {
  return {
    id: row.id,
    orderId: row.orderId,
    provider: row.provider,
    status: row.status,
    trackingNumber: row.trackingNumber,
    providerOrderCode: row.providerOrderCode,
    errorMessage: row.errorMessage,
    retryCount: row.retryCount,
    hasLabelFile: row.status === 'CREATED' && !!row.labelPath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
