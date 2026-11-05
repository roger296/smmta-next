# The Claude connector (admin MCP server)

Claude can work in the CleverDeals admin through its MCP server, with **exactly
the capabilities of the person who issued the key**: everything that person
can do in the web UI, and nothing they can't.

- **URL:** `POST https://admin.cleverdeals.net/api/mcp` (Streamable HTTP,
  stateless). This is the same endpoint as the email tools; a key sees the
  tools its scopes allow.
- **Auth:** `Authorization: Bearer smmta_<prefix>_<secret>`, an API key with
  the **`admin:mcp`** scope.

## How it works

Every tool call runs one of the admin's own HTTP routes, in-process, signed in
as the key's user (a five-minute JWT made for that call). Nothing is
reimplemented:

- the same validation: a refused call returns the route's own error, with the
  field that is wrong;
- the same service code and side effects: invoices and credit notes post to
  Luca, stock moves, labels, emails and outbox events all happen exactly as
  from the web UI;
- the same record of who did it: invoices, notes and status changes carry the
  user's id.

Each call is also written to **`mcp_audit`**: key prefix, user, tool, method,
path and HTTP status. Bodies are not stored, because they can hold customer
details; the routes' own records hold the detail.

## Setting it up

1. **Issue a key.** In the admin, open **Settings → Claude connector**, name
   the key, tick what Claude may do, and press **Issue key**. Copy the key: it
   is shown once.
   - *The whole admin, as me* adds `admin:mcp`. The key acts as **you**, the
     person signed in when it is issued.
   - *Messaging tools* adds `email:mcp` (docs/email/MCP.md).
   - *Approve email campaigns* adds `email:approve`. Without it, campaign
     approval stays with a person in Messaging, through MCP too.
2. **Add it to Claude.** In claude.ai, open Settings → Connectors → **Add
   custom connector**:
   - URL: `https://admin.cleverdeals.net/api/mcp`
   - Request header: `Authorization` = `Bearer <the key>`

   In Claude Code:
   `claude mcp add --transport http cleverdeals https://admin.cleverdeals.net/api/mcp --header "Authorization: Bearer <the key>"`
3. **Revoke** a key on the same Settings page; access stops at once. A key
   also stops working if its user is deleted.

The key is as powerful as you are in the admin. Keep it out of chats,
tickets and git, and revoke it if it leaks.

## What the connector cannot do

The connector can call every admin route under `/api/v1` except these. None is
something a person does in the web UI's pages, or each would let a key widen
its own powers:

| Refused | Why |
| --- | --- |
| `/auth/*` | Signing in: the connector is already signed in as its user. |
| `/admin/api-keys*` | A key must never mint or revoke keys. Issue keys in Settings. |
| `/storefront/*`, `/order-feed/*`, `/webhooks/*`, `/unsubscribe` | Called by the shops, outside systems, payment and mail providers, or customers. |
| `/email/campaigns/:id/approve` | Unless the key also has `email:approve`. |

Files cannot be uploaded (product images go in as URLs). PDFs such as
invoices and pick notes are described (size and type) rather than returned;
open them in the admin.

## Tools

The named tools cover the day-to-day work. `admin_list_endpoints`, `admin_get`
and `admin_request` reach every other admin route: purchasing, goods in,
stock, suppliers, drop-ship orders, channels and prices, shipping,
subscriptions, pre-orders, settings and the rest.

| Tool | Arguments | Does |
| --- | --- | --- |
| `admin_list_orders` | `page?, pageSize?, status?, customerId?, sourceChannel?, held?, search?, dateFrom?, dateTo?` | Lists orders (read) |
| `admin_get_order` | `id` | One order in full (read) |
| `admin_create_order` | `customerId, orderDate, lines[], …` (as Orders → New order) | Creates an order |
| `admin_update_order` | `id` + header fields | Edits an order's header |
| `admin_set_order_status` | `id, status` | Changes status (the route's rules apply) |
| `admin_add_order_line` | `id, productId, quantity, pricePerUnit, taxRate?` | Adds a line |
| `admin_change_order_line` | `id, lineId, quantity?, pricePerUnit?` | Changes a line |
| `admin_remove_order_line` | `id, lineId` | Removes a line |
| `admin_add_order_note` | `id, note, isPickingNote?` | Adds a note |
| `admin_allocate_order` | `id, warehouseId` | Allocates stock |
| `admin_hold_order` | `id, reason` | Puts on hold |
| `admin_release_order_hold` | `id` | Takes off hold |
| `admin_list_invoices` | `page?, pageSize?, customerId?, orderId?, status?` | Lists invoices (read) |
| `admin_get_invoice` | `id` | One invoice, with its credit notes and payments (read) |
| `admin_create_invoice` | `orderId, dateOfInvoice?, dueDateOfInvoice?` | Invoices an order; posts to Luca |
| `admin_create_credit_note` | `invoiceId, dateOfCreditNote, lines[]` | Credits an invoice; posts to Luca |
| `admin_record_invoice_payment` | `invoiceId, amount, paymentDate, reference?` | Records a payment; posts to Luca |
| `admin_list_products` | `page?, pageSize?, search?, categoryId?, manufacturerId?, supplierId?, productType?` | Lists products (read) |
| `admin_get_product` | `id` | One product (read) |
| `admin_get_product_stock` | `id` | Stock by warehouse (read) |
| `admin_create_product` | `name, stockCode?, …` (as Products → New product) | Creates a product |
| `admin_update_product` | `id` + fields to change | Edits a product |
| `admin_delete_product` | `id` | Deletes a product (soft) |
| `admin_list_customers` | `page?, pageSize?, search?, typeId?` | Lists customers (read) |
| `admin_get_customer` | `id` | One customer in full (read) |
| `admin_create_customer` | `name, email?, creditTermDays?, vatTreatment?, …` | Creates a customer |
| `admin_update_customer` | `id` + fields to change | Edits a customer |
| `admin_add_customer_contact` | `id, name?, email?, mobile?, …` | Adds a contact |
| `admin_add_customer_address` | `id, kind (delivery / invoice), address` | Adds an address |
| `admin_add_customer_note` | `id, note` | Adds a note |
| `admin_list_endpoints` | `search?` | Every route the connector may call (read) |
| `admin_get` | `path, query?` | Reads any admin route (read) |
| `admin_request` | `method, path, query?, body?` | Calls any admin route that changes something |

## Example requests

1. "Has the last order gone to the supplier?" → `admin_list_orders {"pageSize": 1}`,
   then `admin_get {"path": "/supplier-orders"}`.
2. "Invoice order SO-1234 and email me the total" → `admin_list_orders {"search": "SO-1234"}`,
   then `admin_create_invoice {"orderId": "…"}`.
3. "Credit one of the two spools on invoice INV-0042" → `admin_get_invoice`, then
   `admin_create_credit_note` with that line.
4. "Which products have no EAN?" → `admin_list_products` page by page.
5. "Close purchase order PO-77" → `admin_list_endpoints {"search": "purchase"}`, then
   `admin_request {"method": "POST", "path": "/purchase-orders/<id>/close"}`.

## Code

- `apps/api/src/modules/mcp/catalogue.ts`: the routes and the refused list.
- `apps/api/src/modules/mcp/dispatch.ts`: runs a call as the user, writes `mcp_audit`.
- `apps/api/src/modules/mcp/tools.ts`: the tools; argument schemas are the routes' own.
- `apps/api/src/modules/email/mcp/server.ts`: the endpoint, shared with the email tools.
- `apps/web/src/features/integrations/claude-connector-panel.tsx`: Settings → Claude connector.
