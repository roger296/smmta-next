export interface CatalogueItem {
  key: string;
  area: string | null;
  section: string | null;
  name: string;
  /** What the counter is counting in — kg, l, each, bottle. From the product
   *  catalogue, so it is the same unit the stock system values against. */
  uom?: string;
  /** Only present on the bundled fallback catalogue; the API no longer sends
   *  pack/supplier hints — they were more confusing than helpful. */
  pack?: string | null;
  supplier?: string | null;
  order: number;
}

export interface Catalogue {
  source: string;
  sheet: string;
  itemCount: number;
  items: CatalogueItem[];
}

export interface SiteOption {
  slug: string;
  name: string;
}

/** A counted line held on the device. Catalogue lines and custom ("added")
 *  lines share this shape; custom lines carry their own name/section/pack. */
export interface CountEntry {
  itemKey: string;
  itemName: string;
  section: string | null;
  packSize: string | null;
  quantity: number;
  /** True once the counter has set a value (0 is a real count, so this is its
   *  own flag — never derived from quantity > 0). */
  counted: boolean;
  isCustom: boolean;
  /** Not yet pushed to the server. */
  dirty: boolean;
  countedAt: string;
}

export interface Session {
  deviceId: string;
  accessCode: string;
  period: string;
  siteSlug: string;
  counterName: string;
}

export type CountsMap = Record<string, CountEntry>;
