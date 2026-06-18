/**
 * GL provider switch (spec §A2/§A8). Big Bakes posts stock GL events (GRN,
 * stock adjustment) to Xero by default; the Luca path stays intact and is
 * selectable via GL_PROVIDER=luca. Both services expose the same
 * `postGoodsReceivedNote` / `postStockAdjustment` surface, so the call sites
 * are provider-agnostic.
 */
import { getEnv } from '../config/env.js';
import { LucaGLService } from './luca/luca-gl.service.js';
import { XeroGLService } from './xero/xero-gl.service.js';

export interface GRNGLParams {
  companyId: string;
  grnId: string;
  grnNumber: string;
  poNumber: string;
  bookedInDate: Date;
  stockValue: number;
  deliveryCharge: number;
  isService: boolean;
  /** The receiving site's currency (spec §7). Defaults GBP. */
  currencyCode?: string;
}

export interface StockAdjustmentGLParams {
  companyId: string;
  adjustmentId: string;
  adjustmentDate: Date;
  stockValue: number;
  type: 'ADD' | 'REMOVE';
  productName: string;
  /** The site's currency. Defaults GBP. */
  currencyCode?: string;
}

export interface StockGLService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  postGoodsReceivedNote(db: any, params: GRNGLParams): Promise<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  postStockAdjustment(db: any, params: StockAdjustmentGLParams): Promise<string>;
}

/** The configured GL service for stock postings (Xero by default). */
export function getStockGLService(): StockGLService {
  return getEnv().GL_PROVIDER === 'luca' ? new LucaGLService() : new XeroGLService();
}
