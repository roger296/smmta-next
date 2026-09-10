/**
 * Builds a Smooth Parcel shipment from an order.
 *
 * Pure: no database, no network, no clock except what is passed in, so every
 * field rule is unit-testable. Rules come from the Smooth Parcel user guide:
 *
 *   - address lines should stay under 35 characters to avoid truncation;
 *   - Region is required — repeat the town when there is none;
 *   - a phone and email are required, and a placeholder is acceptable;
 *   - weight and dimensions may be estimates, because every parcel is re-weighed.
 *
 * Missing essentials (no postcode, no address line) throw LabelDataError before
 * any API call, so an operator sees "missing postcode" rather than a vague
 * carrier rejection, and a pointless retry is never queued.
 *
 * Unconfirmed until the developer pack: whether an item's Price and Weight are
 * per unit or per line (treated here as per unit, since the item carries its
 * own Quantity), and the numeric codes for WeightUnits / LWHUnit (0 is taken as
 * the guide's defaults, kg and cm).
 */

export interface LabelOrderLine {
  sku: string | null;
  name: string;
  quantity: number;
  unitPriceGbp: number;
  weightKg: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
}

export interface LabelOrderInput {
  orderNumber: string;
  /** YYYY-MM-DD. */
  orderDate: string;
  customerName: string;
  customerEmail: string | null;
  address: {
    contactName: string | null;
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postCode: string | null;
    country: string | null;
    phone: string | null;
  };
  lines: LabelOrderLine[];
}

export interface MapperOptions {
  senderName: string;
  defaultPhone: string;
  fallbackEmail: string;
  defaultWeightKg: number;
  defaultBoxCm: { length: number; width: number; height: number };
  shippingDate: Date;
}

export interface SmoothParcelItem {
  ItemID: string;
  ItemName: string;
  Quantity: number;
  Price: number;
  Weight: number;
  WeightUnits: number;
  Height: number;
  Width: number;
  Length: number;
  LWHUnit: number;
}

export interface SmoothParcelOrderPayload {
  IsExpress: boolean;
  SignatureOnDelivery: boolean;
  OrderDate: string;
  TransactionID: string;
  RecordNumber: string;
  OrderReference: string;
  OrderCurrencyName: string;
  Company: string;
  FirstName: string;
  MiddleName: string;
  LastName: string;
  CustomerID: string;
  CustomerEmailAddress1: string;
  CustomerEmailAddress2: string;
  CustomerPhone1: string;
  CustomerPhone2: string;
  HouseNameNumber: string;
  Street: string;
  Region: string;
  City: string;
  PostalCode: string;
  Country: string;
  ShipmentFirstName: string;
  ShipmentMiddleName: string;
  ShipmentLastName: string;
  IsInsuranced: boolean;
  InsuranceAmount: number;
  ShippingDate: string;
  OrderDetailList: SmoothParcelItem[];
  ContainsLiquid: boolean;
  ContainsBatteries: boolean;
  ContainsFragile: boolean;
  TrackedRequired: boolean;
  SenderName: string;
}

export class LabelDataError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`Cannot create a label — the order is missing: ${missing.join(', ')}`);
    this.name = 'LabelDataError';
    this.missing = missing;
  }
}

/** Placeholder Smooth Parcel accepts when no phone is known (guide, p17). */
const PHONE_PLACEHOLDER = '00000000000';

/** Collapses whitespace, trims, and caps length. */
export function clip(value: string | null | undefined, max = 35): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Last word is the family name; a single word fills both, as both are required. */
export function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0]!, last: parts[0]! };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1]! };
}

const ISO3: Record<string, string> = {
  GB: 'GBR', UK: 'GBR', 'UNITED KINGDOM': 'GBR', 'GREAT BRITAIN': 'GBR',
  IE: 'IRL', FR: 'FRA', DE: 'DEU', ES: 'ESP', IT: 'ITA', NL: 'NLD', BE: 'BEL',
  PT: 'PRT', AT: 'AUT', DK: 'DNK', SE: 'SWE', FI: 'FIN', PL: 'POL', LU: 'LUX',
};

/** The guide recommends ISO 3166-1 alpha-3, and accepts two-letter codes too. */
export function toIso3(country: string | null | undefined): string {
  const c = (country ?? '').trim().toUpperCase();
  if (ISO3[c]) return ISO3[c]!;
  return c;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const positive = (n: number | null | undefined) =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;

export function buildSmoothParcelOrder(
  input: LabelOrderInput,
  opts: MapperOptions,
): SmoothParcelOrderPayload {
  const a = input.address;
  const recipient = (a.contactName ?? '').trim() || input.customerName.trim();
  const email = (input.customerEmail ?? '').trim() || opts.fallbackEmail.trim();

  const missing: string[] = [];
  if (!recipient) missing.push('recipient name');
  if (!clip(a.line1)) missing.push('address line 1');
  if (!clip(a.city)) missing.push('town or city');
  if (!clip(a.postCode)) missing.push('postcode');
  if (!clip(a.country)) missing.push('country');
  if (!email) missing.push('customer email');
  if (input.lines.length === 0) missing.push('order lines');
  if (missing.length > 0) throw new LabelDataError(missing);

  const { first, last } = splitName(recipient);
  const city = clip(a.city);
  const line1 = clip(a.line1);

  const items: SmoothParcelItem[] = input.lines.map((l) => ({
    ItemID: clip(l.sku || l.name, 50),
    ItemName: clip(l.name, 100),
    Quantity: Math.max(1, Math.round(l.quantity)),
    Price: round2(l.unitPriceGbp),
    Weight: round3(positive(l.weightKg) ?? opts.defaultWeightKg),
    WeightUnits: 0,
    Height: positive(l.heightCm) ?? opts.defaultBoxCm.height,
    Width: positive(l.widthCm) ?? opts.defaultBoxCm.width,
    Length: positive(l.lengthCm) ?? opts.defaultBoxCm.length,
    LWHUnit: 0,
  }));

  return {
    IsExpress: false,
    SignatureOnDelivery: false,
    OrderDate: new Date(`${input.orderDate}T00:00:00.000Z`).toISOString(),
    // One parcel per order, so the order number is unique for the transaction.
    TransactionID: input.orderNumber,
    RecordNumber: input.orderNumber,
    OrderReference: input.orderNumber,
    OrderCurrencyName: 'GBP',
    Company: '',
    FirstName: clip(first),
    MiddleName: '',
    LastName: clip(last),
    CustomerID: email,
    CustomerEmailAddress1: email,
    CustomerEmailAddress2: '',
    CustomerPhone1: clip(a.phone, 30) || clip(opts.defaultPhone, 30) || PHONE_PLACEHOLDER,
    CustomerPhone2: '',
    HouseNameNumber: line1,
    // Street is required. With no second line, repeating line 1 prints a
    // duplicate line, which is harmless; leaving it blank fails validation.
    Street: clip(a.line2) || line1,
    Region: clip(a.region) || city,
    City: city,
    PostalCode: clip(a.postCode, 20),
    Country: toIso3(a.country),
    ShipmentFirstName: clip(first),
    ShipmentMiddleName: '',
    ShipmentLastName: clip(last),
    IsInsuranced: false,
    InsuranceAmount: 0,
    ShippingDate: opts.shippingDate.toISOString(),
    OrderDetailList: items,
    ContainsLiquid: false,
    ContainsBatteries: false,
    ContainsFragile: false,
    TrackedRequired: true,
    SenderName: opts.senderName,
  };
}
