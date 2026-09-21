import { MarketplaceService } from '../../integrations/marketplace/marketplace.service.js';
import type { MarketplaceOrder, MarketplaceImportResult } from '../../integrations/marketplace/marketplace.types.js';

/**
 * CSVImportService — parses CSV order data and imports it via MarketplaceService.
 *
 * Two column layouts are accepted, told apart by their headings:
 *
 * 1. The native layout, one row per order line, grouped by `OrderNumber`:
 *      OrderNumber, CustomerName, CustomerEmail, DeliveryName, DeliveryLine1,
 *      DeliveryLine2, DeliveryCity, DeliveryRegion, DeliveryPostCode,
 *      DeliveryCountry, OrderDate, Currency, SKU, ProductName, Qty, UnitPrice,
 *      TaxRate, DeliveryCharge, PaymentMethod
 *
 * 2. The legacy layout that the previous generation of this system took, so
 *    a business moving across keeps sending the file it already produces.
 *    Rows are grouped by `Order Id`; dates are dd/mm/yyyy; the address
 *    columns are repeated as `<field> For Delivery Address` and
 *    `<field> For Invoice Address`:
 *      Order Id, Order Date(dd/mm/yyyy), Customer Name, Email Address,
 *      Customer Contact, Courier Name, Warehouse Name, Tax Scheme,
 *      Tax to be (Exclusive/Inclusive), Express, Delivery Charge,
 *      Delivery Tax Rate, Product Code, Quantity, Price, Tax Rate,
 *      Customization Codes, Contact Name / Address Line 1 / Address Line 2 /
 *      City / Region / Post Code / Country, each For Delivery Address and
 *      For Invoice Address.
 *
 * Headings are matched after lowercasing and dropping everything but letters
 * and digits, so `Order Id`, `order_id` and `OrderID` are the same column.
 */
export class CSVImportService {
  private marketplaceService = new MarketplaceService();

  /**
   * Parse CSV text into MarketplaceOrder[] and import them.
   */
  async importFromCSV(
    companyId: string,
    userId: string,
    csvText: string,
  ): Promise<MarketplaceImportResult> {
    const orders = parseOrdersCsv(csvText);
    return this.marketplaceService.importOrders(companyId, userId, orders);
  }
}

export type CsvLayout = 'native' | 'legacy';

/** A heading reduced to letters and digits: "Order Date(dd/mm/yyyy)" → "orderdateddmmyyyy". */
export function normaliseHeading(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Which layout a header row is in. Legacy is recognised by its two signature columns. */
export function detectCsvLayout(headings: string[]): CsvLayout {
  const keys = new Set(headings.map(normaliseHeading));
  return keys.has('orderid') && keys.has('productcode') ? 'legacy' : 'native';
}

/**
 * Parse CSV text into normalised orders. Pure: no database, no side effects.
 * Rows sharing an order id become one order with several lines; the header
 * fields are read from the first row of each group.
 */
export function parseOrdersCsv(csvText: string): MarketplaceOrder[] {
  const records = parseCsvRecords(csvText);
  if (records.length < 2) return [];

  const headings = records[0]!;
  const keys = headings.map(normaliseHeading);
  const layout = detectCsvLayout(headings);

  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < records.length; i++) {
    const values = records[i]!;
    if (values.every((v) => v === '')) continue;
    const row: Record<string, string> = {};
    keys.forEach((k, idx) => {
      row[k] = values[idx] ?? '';
    });
    rows.push(row);
  }

  return layout === 'legacy' ? groupLegacyRows(rows) : groupNativeRows(rows);
}

// ── Native layout ──

function groupNativeRows(rows: Array<Record<string, string>>): MarketplaceOrder[] {
  const groups = groupBy(rows, (row, i) => row.ordernumber || `CSV-${i + 1}`);
  const orders: MarketplaceOrder[] = [];

  for (const [orderNum, lines] of groups) {
    const h = lines[0]!;
    orders.push({
      thirdPartyOrderId: orderNum,
      sourceChannel: 'CSV',
      customer: {
        name: h.customername || 'CSV Customer',
        email: h.customeremail || undefined,
      },
      deliveryAddress: {
        contactName: h.deliveryname,
        line1: h.deliveryline1,
        line2: h.deliveryline2,
        city: h.deliverycity,
        region: h.deliveryregion,
        postCode: h.deliverypostcode,
        country: h.deliverycountry,
      },
      orderDate: h.orderdate || today(),
      currencyCode: h.currency || 'GBP',
      deliveryCharge: parseFloat(h.deliverycharge || '0') || 0,
      taxInclusive: false,
      paymentMethod: h.paymentmethod || undefined,
      customerOrderNumber: orderNum,
      lines: lines.map((l) => ({
        sku: l.sku || l.stockcode || '',
        name: l.productname || 'Unknown Product',
        quantity: parseFloat(l.qty || l.quantity || '1') || 1,
        pricePerUnit: parseFloat(l.unitprice || l.price || '0') || 0,
        taxRate: parseTaxRate(l.taxrate),
      })),
    });
  }
  return orders;
}

// ── Legacy layout ──

const ADDRESS_FIELDS = {
  contactName: 'contactname',
  line1: 'addressline1',
  line2: 'addressline2',
  city: 'city',
  region: 'region',
  postCode: 'postcode',
  country: 'country',
} as const;

function legacyAddress(row: Record<string, string>, suffix: 'fordeliveryaddress' | 'forinvoiceaddress') {
  const pick = (field: string) => row[`${field}${suffix}`] || undefined;
  return {
    contactName: pick(ADDRESS_FIELDS.contactName),
    line1: pick(ADDRESS_FIELDS.line1),
    line2: pick(ADDRESS_FIELDS.line2),
    city: pick(ADDRESS_FIELDS.city),
    region: pick(ADDRESS_FIELDS.region),
    postCode: pick(ADDRESS_FIELDS.postCode),
    country: pick(ADDRESS_FIELDS.country),
  };
}

function groupLegacyRows(rows: Array<Record<string, string>>): MarketplaceOrder[] {
  const groups = groupBy(rows, (row, i) => row.orderid || `CSV-${i + 1}`);
  const orders: MarketplaceOrder[] = [];

  for (const [orderId, lines] of groups) {
    const h = lines[0]!;
    const invoice = legacyAddress(h, 'forinvoiceaddress');
    orders.push({
      thirdPartyOrderId: orderId,
      sourceChannel: 'CSV',
      customer: {
        name: h.customername || 'CSV Customer',
        email: h.emailaddress || undefined,
        phone: h.customercontact || undefined,
      },
      deliveryAddress: { ...legacyAddress(h, 'fordeliveryaddress'), phone: h.customercontact || undefined },
      invoiceAddress: invoice.line1 ? invoice : undefined,
      orderDate: parseLegacyDate(h.orderdateddmmyyyy || h.orderdate) ?? today(),
      currencyCode: 'GBP',
      deliveryCharge: parseFloat(h.deliverycharge || '0') || 0,
      taxInclusive: /^inc/i.test(h.taxtobeexclusiveinclusive ?? ''),
      customerOrderNumber: orderId,
      courierName: h.couriername || undefined,
      warehouseName: h.warehousename || undefined,
      rawData: {
        layout: 'legacy',
        taxScheme: h.taxscheme || undefined,
        express: h.express || undefined,
        deliveryTaxRate: h.deliverytaxrate || undefined,
        customizationCodes: lines.map((l) => l.customizationcodes || ''),
      },
      lines: lines.map((l) => ({
        sku: l.productcode || '',
        name: l.productcode || 'Unknown Product',
        quantity: parseFloat(l.quantity || '1') || 1,
        pricePerUnit: parseFloat(l.price || '0') || 0,
        taxRate: parseTaxRate(l.taxrate),
      })),
    });
  }
  return orders;
}

/** dd/mm/yyyy (the legacy file's format) or yyyy-mm-dd → yyyy-mm-dd; anything else → undefined. */
export function parseLegacyDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(v);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return iso ? iso[0] : undefined;
}

// ── Shared helpers ──

function parseTaxRate(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 20;
  const n = parseFloat(value.replace('%', ''));
  return Number.isFinite(n) ? n : 20;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function groupBy<T>(items: T[], key: (item: T, index: number) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  items.forEach((item, i) => {
    const k = key(item, i);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  });
  return groups;
}

/**
 * Split CSV text into records of fields. Handles CRLF and LF line endings,
 * quoted fields containing commas, doubled quotes and line breaks.
 * Every field is trimmed.
 */
export function parseCsvRecords(csvText: string): string[][] {
  const text = csvText.replace(/^﻿/, '');
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      record.push(field.trim());
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field.trim());
      records.push(record);
      record = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field.trim());
    records.push(record);
  }
  return records.filter((r) => !(r.length === 1 && r[0] === ''));
}
