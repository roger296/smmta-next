/**
 * The `admin_` MCP tools (docs/MCP-CONNECTOR.md).
 *
 * Every tool is a thin description of one admin route: its name, what it
 * does, its arguments (the route's own zod schema, so the connector and the
 * web UI accept exactly the same input) and how the arguments map onto the
 * request. `callApi` then runs the route itself as the key's user.
 *
 * The named tools cover what is done most: orders, invoices and credit notes,
 * products and customers. `admin_list_endpoints`, `admin_get` and
 * `admin_request` reach every other admin route (purchasing, goods in, stock,
 * suppliers, drop-ship orders, channels, prices, shipping, subscriptions,
 * pre-orders, settings and the rest), so nothing the web UI does is out of
 * reach.
 */
import { z } from 'zod';
import {
  createOrderSchema,
  updateOrderSchema,
  orderQuerySchema,
  orderStatusChangeSchema,
  orderNoteSchema,
  allocateStockSchema,
  createInvoiceFromOrderSchema,
  createCreditNoteSchema,
  allocatePaymentSchema,
  orderHoldSchema,
  addOrderLineSchema,
} from '../orders/order.schema.js';
import { createProductSchema, updateProductSchema, productQuerySchema } from '../products/product.schema.js';
import {
  createCustomerSchema,
  updateCustomerSchema,
  customerQuerySchema,
  customerContactSchema,
  customerAddressSchema,
  customerInvoiceAddressSchema,
  customerNoteSchema,
} from '../customers/customer.schema.js';
import { paginationSchema } from '../../shared/utils/pagination.js';
import { allowedRoutes } from './catalogue.js';
import type { AdminContext, ApiCall } from './dispatch.js';

export interface AdminTool {
  name: string;
  description: string;
  input: z.ZodRawShape;
  /** The request the arguments stand for; or a result computed locally. */
  call: (args: any, ctx: AdminContext) => ApiCall | { local: unknown };
}

const id = (what: string) => z.string().uuid().describe(`The ${what}'s id`);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD');
const enc = encodeURIComponent;
/** Every argument except the named ones: the request body. */
const without = (args: Record<string, unknown>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(args).filter(([k]) => !keys.includes(k)));

const GL = 'Posts to the general ledger (Luca), exactly as the same action in the web UI does.';

export const ADMIN_TOOLS: AdminTool[] = [
  // ── Orders ────────────────────────────────────────────────────
  {
    name: 'admin_list_orders',
    description: 'Lists sales orders, newest first: filter by status, customer, channel, date range, on-hold, or free text (order number, customer). Paged (page, pageSize up to 250).',
    input: orderQuerySchema.shape,
    call: (a) => ({ method: 'GET', path: '/orders', query: a }),
  },
  {
    name: 'admin_get_order',
    description: 'One sales order in full: customer, addresses, lines, allocation, status history, notes, invoices, holds and shipping.',
    input: { id: id('order') },
    call: (a) => ({ method: 'GET', path: `/orders/${enc(a.id)}` }),
  },
  {
    name: 'admin_create_order',
    description: 'Creates a sales order (as Orders → New order). Needs a customer id and at least one line (productId, quantity, pricePerUnit, taxRate). Prices are ex VAT unless taxInclusive.',
    input: createOrderSchema.shape,
    call: (a) => ({ method: 'POST', path: '/orders', body: a }),
  },
  {
    name: 'admin_update_order',
    description: "Edits an order's header: contact, addresses, warehouse, delivery charge and date, payment method, customer's order number, tracking. Lines are changed with admin_add_order_line / admin_change_order_line / admin_remove_order_line.",
    input: { id: id('order'), ...updateOrderSchema.shape },
    call: (a) => ({ method: 'PUT', path: `/orders/${enc(a.id)}`, body: without(a, 'id') }),
  },
  {
    name: 'admin_set_order_status',
    description: "Moves an order to a new status (CONFIRMED, CANCELLED, COMPLETED and so on). The route enforces the same allowed transitions as the web UI.",
    input: { id: id('order'), ...orderStatusChangeSchema.shape },
    call: (a) => ({ method: 'PUT', path: `/orders/${enc(a.id)}/status`, body: without(a, 'id') }),
  },
  {
    name: 'admin_add_order_line',
    description: 'Adds a line to an open order.',
    input: { id: id('order'), ...addOrderLineSchema.shape },
    call: (a) => ({ method: 'POST', path: `/orders/${enc(a.id)}/lines`, body: without(a, 'id') }),
  },
  {
    name: 'admin_change_order_line',
    description: "Changes a line's quantity and/or unit price on an open order.",
    input: {
      id: id('order'),
      lineId: id('order line'),
      quantity: z.coerce.number().min(0.01).optional(),
      pricePerUnit: z.coerce.number().min(0).optional(),
    },
    call: (a) => ({ method: 'PATCH', path: `/orders/${enc(a.id)}/lines/${enc(a.lineId)}`, body: without(a, 'id', 'lineId') }),
  },
  {
    name: 'admin_remove_order_line',
    description: 'Removes a line from an open order.',
    input: { id: id('order'), lineId: id('order line') },
    call: (a) => ({ method: 'DELETE', path: `/orders/${enc(a.id)}/lines/${enc(a.lineId)}` }),
  },
  {
    name: 'admin_add_order_note',
    description: 'Adds a note to an order (isPickingNote: shown on the pick note).',
    input: { id: id('order'), ...orderNoteSchema.shape },
    call: (a) => ({ method: 'POST', path: `/orders/${enc(a.id)}/notes`, body: without(a, 'id') }),
  },
  {
    name: 'admin_allocate_order',
    description: "Allocates stock to an order's lines from a warehouse.",
    input: { id: id('order'), ...allocateStockSchema.shape },
    call: (a) => ({ method: 'POST', path: `/orders/${enc(a.id)}/allocate`, body: without(a, 'id') }),
  },
  {
    name: 'admin_hold_order',
    description: 'Puts an order on hold, with the reason.',
    input: { id: id('order'), ...orderHoldSchema.shape },
    call: (a) => ({ method: 'PUT', path: `/orders/${enc(a.id)}/hold`, body: without(a, 'id') }),
  },
  {
    name: 'admin_release_order_hold',
    description: 'Takes an order off hold.',
    input: { id: id('order') },
    call: (a) => ({ method: 'DELETE', path: `/orders/${enc(a.id)}/hold` }),
  },

  // ── Invoices and credit notes ─────────────────────────────────
  {
    name: 'admin_list_invoices',
    description: 'Lists customer invoices, newest first: filter by customer, order or status. Paged. A credit note shows on its invoice (admin_get_invoice).',
    input: {
      ...paginationSchema.shape,
      status: z.string().optional().describe('An invoice status'),
      customerId: z.string().uuid().optional(),
      orderId: z.string().uuid().optional(),
    },
    call: (a) => ({ method: 'GET', path: '/invoices', query: a }),
  },
  {
    name: 'admin_get_invoice',
    description: 'One invoice or credit note in full: lines, totals, VAT, payments and outstanding balance.',
    input: { id: id('invoice') },
    call: (a) => ({ method: 'GET', path: `/invoices/${enc(a.id)}` }),
  },
  {
    name: 'admin_create_invoice',
    description: `Invoices an order (as Orders → order → Create invoice). ${GL} Dates default to today and the customer's terms.`,
    input: { orderId: id('order'), ...createInvoiceFromOrderSchema.shape },
    call: (a) => ({ method: 'POST', path: `/orders/${enc(a.orderId)}/invoice`, body: without(a, 'orderId') }),
  },
  {
    name: 'admin_create_credit_note',
    description: `Raises a credit note against an invoice, for the lines given (productId, quantity, pricePerUnit, taxRate). ${GL}`,
    input: { invoiceId: id('invoice'), ...createCreditNoteSchema.shape, dateOfCreditNote: date },
    call: (a) => ({ method: 'POST', path: `/invoices/${enc(a.invoiceId)}/credit-note`, body: without(a, 'invoiceId') }),
  },
  {
    name: 'admin_record_invoice_payment',
    description: `Records a customer payment against an invoice. ${GL}`,
    input: { invoiceId: id('invoice'), ...allocatePaymentSchema.shape, paymentDate: date },
    call: (a) => ({ method: 'POST', path: `/invoices/${enc(a.invoiceId)}/payment`, body: without(a, 'invoiceId') }),
  },

  // ── Products ──────────────────────────────────────────────────
  {
    name: 'admin_list_products',
    description: 'Lists products: free text (name, stock code, EAN), category, manufacturer, supplier, type. Paged.',
    input: productQuerySchema.shape,
    call: (a) => ({ method: 'GET', path: '/products', query: a }),
  },
  {
    name: 'admin_get_product',
    description: 'One product in full: identifiers, prices, dimensions, supplier, storefront content and group.',
    input: { id: id('product') },
    call: (a) => ({ method: 'GET', path: `/products/${enc(a.id)}` }),
  },
  {
    name: 'admin_get_product_stock',
    description: "A product's stock level by warehouse: in stock, allocated, free.",
    input: { id: id('product') },
    call: (a) => ({ method: 'GET', path: `/products/${enc(a.id)}/stock-level` }),
  },
  {
    name: 'admin_create_product',
    description: 'Creates a product (as Products → New product).',
    input: createProductSchema.shape,
    call: (a) => ({ method: 'POST', path: '/products', body: a }),
  },
  {
    name: 'admin_update_product',
    description: 'Edits a product: send only the fields to change.',
    input: { id: id('product'), ...updateProductSchema.shape },
    call: (a) => ({ method: 'PUT', path: `/products/${enc(a.id)}`, body: without(a, 'id') }),
  },
  {
    name: 'admin_delete_product',
    description: 'Deletes a product (a soft delete, as in the web UI).',
    input: { id: id('product') },
    call: (a) => ({ method: 'DELETE', path: `/products/${enc(a.id)}` }),
  },

  // ── Customers ─────────────────────────────────────────────────
  {
    name: 'admin_list_customers',
    description: 'Lists customers: free text (name, email), customer type. Paged.',
    input: customerQuerySchema.shape,
    call: (a) => ({ method: 'GET', path: '/customers', query: a }),
  },
  {
    name: 'admin_get_customer',
    description: 'One customer in full: contacts, delivery and invoice addresses, notes, terms and special prices.',
    input: { id: id('customer') },
    call: (a) => ({ method: 'GET', path: `/customers/${enc(a.id)}` }),
  },
  {
    name: 'admin_create_customer',
    description: 'Creates a customer record.',
    input: createCustomerSchema.shape,
    call: (a) => ({ method: 'POST', path: '/customers', body: a }),
  },
  {
    name: 'admin_update_customer',
    description: "Edits a customer's record: send only the fields to change.",
    input: { id: id('customer'), ...updateCustomerSchema.shape },
    call: (a) => ({ method: 'PUT', path: `/customers/${enc(a.id)}`, body: without(a, 'id') }),
  },
  {
    name: 'admin_add_customer_contact',
    description: 'Adds a contact person to a customer.',
    input: { id: id('customer'), ...customerContactSchema.shape },
    call: (a) => ({ method: 'POST', path: `/customers/${enc(a.id)}/contacts`, body: without(a, 'id') }),
  },
  {
    name: 'admin_add_customer_address',
    description: 'Adds a delivery or invoice address to a customer.',
    input: {
      id: id('customer'),
      kind: z.enum(['delivery', 'invoice']),
      address: z.union([customerAddressSchema, customerInvoiceAddressSchema]).describe('The address fields'),
    },
    call: (a) => ({ method: 'POST', path: `/customers/${enc(a.id)}/addresses/${a.kind}`, body: a.address }),
  },
  {
    name: 'admin_add_customer_note',
    description: 'Adds a note to a customer.',
    input: { id: id('customer'), ...customerNoteSchema.shape },
    call: (a) => ({ method: 'POST', path: `/customers/${enc(a.id)}/notes`, body: without(a, 'id') }),
  },

  // ── Everything else ───────────────────────────────────────────
  {
    name: 'admin_list_endpoints',
    description: 'Lists every admin route the connector can call (method and path below /api/v1), optionally filtered by a word such as "purchase", "stock", "supplier", "grn", "channel", "shipping". Use with admin_get and admin_request to do anything the web UI does that has no named tool.',
    input: { search: z.string().optional().describe('Only paths containing this text') },
    call: (a, ctx) => {
      const term = (a.search ?? '').toLowerCase().trim();
      const list = allowedRoutes(ctx.canApprove)
        .filter((r) => !term || r.path.toLowerCase().includes(term))
        .map((r) => `${r.method} ${r.path}`);
      return { local: { count: list.length, routes: list } };
    },
  },
  {
    name: 'admin_get',
    description: 'Reads any admin route (GET), e.g. "/purchase-orders", "/purchase-orders/<id>/grns", "/suppliers/<id>". Path is below /api/v1; query parameters go in `query`. See admin_list_endpoints.',
    input: {
      path: z.string().min(1).describe('e.g. /purchase-orders/<id>'),
      query: z.record(z.unknown()).optional(),
    },
    call: (a) => ({ method: 'GET', path: a.path, query: a.query }),
  },
  {
    name: 'admin_request',
    description: 'Calls any admin route that changes something (POST, PUT, PATCH or DELETE), exactly as the web UI would, e.g. closing a purchase order or editing a supplier. The route validates the body and says what is wrong if it refuses. Files cannot be uploaded here; give images as URLs.',
    input: {
      method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string().min(1).describe('Below /api/v1, e.g. /purchase-orders/<id>/close'),
      query: z.record(z.unknown()).optional(),
      body: z.unknown().optional().describe('The JSON body the route expects'),
    },
    call: (a) => ({ method: a.method, path: a.path, query: a.query, body: a.body }),
  },
];
