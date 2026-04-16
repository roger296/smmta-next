# SMMTA-Next Frontend — Automated Build Prompts

> **How to use this document**: Open Claude Code in the `K:/smmta-next` directory and send the single instruction:
>
> **`run the prompts in FRONTEND-BUILD-PROMPT.md`**
>
> Claude Code will then work through Phases A → G in order, writing tests and fixing any failing tests before advancing. Do not interleave your own requests while it is running — let it complete end-to-end.

---

## META-INSTRUCTIONS (read these first, Claude Code)

You are building the React frontend for **SMMTA-Next**, an internal admin UI for a stock-control and order-handling system. The backend REST API at `apps/api` is already complete and must not be modified.

### Execution rules

1. **Work through Phases A → G in strict order.** Do not skip ahead. Do not batch phases.
2. **Every phase ends with a mandatory Test Loop**:
   1. Write the tests described in that phase
   2. Run them: `npm run test --workspace=apps/web` (unit/integration) and `npm run test:e2e --workspace=apps/web` (end-to-end)
   3. If any test fails — **debug and fix the underlying bug**, not the test. Re-run until green.
   4. If a test is genuinely wrong (e.g. wrong selector), fix the test, then re-run.
   5. **Only when all tests pass** commit with `git add -A && git commit -m "feat(web): phase X <short desc> — all tests passing"` and move to the next phase.
   6. If after 5 consecutive fix attempts on the same failing test the phase still can't pass, **stop and ask the user**. Do not fake a pass by skipping or commenting out the test.
4. **Report after every phase** with a short summary: what was built, what tests were added, how many passed, what (if anything) needed user decision.
5. **Do not ask for permission between phases** — proceed automatically as long as tests are green.
6. **Commit after every phase** (step 5 above). Each phase is one commit.

### Context: what's already there

**Repo layout:**
```
K:/smmta-next/
├── apps/
│   ├── api/                     # Fastify REST API — COMPLETE, do not modify
│   │   ├── src/modules/*/*.routes.ts     # HTTP routes — read for exact API shape
│   │   ├── src/modules/*/*.schema.ts     # Zod schemas — mirror these on the frontend
│   │   └── generate-test-token.ts        # Issues dev JWTs for testing
│   └── web/                     # ← YOU BUILD HERE
├── packages/
│   └── shared-types/            # Enums & shared interfaces — import from @smmta/shared-types
└── docker-compose.yml           # Postgres 16 + Redis 7 (assumed running)
```

**API base URL (dev):** `http://localhost:3000/api/v1`
**OpenAPI JSON:** `http://localhost:3000/docs/json`
**Swagger UI:** `http://localhost:3000/docs`

**Response envelope from every authenticated endpoint:**
```ts
// Paginated list
{ success: true, data: T[], total: number, page: number, pageSize: number, totalPages: number }

// Single record
{ success: true, data: T }

// Error
{ success: false, error: string, details?: unknown }
```

### Tech stack (install during Phase A)

**Runtime:** `react@19`, `react-dom@19`, `@tanstack/react-router`, `@tanstack/react-query`, `@tanstack/react-query-devtools`, `@tanstack/react-table`, `react-hook-form`, `@hookform/resolvers`, `zod`, `date-fns`, `lucide-react`, `recharts`, `clsx`, `tailwind-merge`, `class-variance-authority`.

**shadcn/ui Radix peers:** `@radix-ui/react-dialog`, `-dropdown-menu`, `-label`, `-select`, `-slot`, `-tabs`, `-toast`, `-popover`, `-checkbox`, `-radio-group`, `-switch`, `-separator`, `-avatar`, `-tooltip`, `-scroll-area`, `-accordion`, `-alert-dialog`.

**Dev:** `tailwindcss@next`, `@tailwindcss/vite`, `@tanstack/router-vite-plugin`, `openapi-typescript`, `@types/node`, `vitest`, `@vitest/ui`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `jsdom`, `msw@latest`, `@playwright/test`.

### Testing infrastructure (set up in Phase A, used in every subsequent phase)

**Unit / integration tests** — Vitest + React Testing Library + MSW:
- Config: `apps/web/vitest.config.ts` with jsdom environment, setup file at `src/test/setup.ts` (imports `@testing-library/jest-dom`, starts MSW server).
- MSW handlers: `src/test/mocks/handlers.ts` — one handler per API endpoint the feature uses. Mock the envelope `{ success, data, ... }`.
- Tests live next to source: `customer-form.tsx` → `customer-form.test.tsx`.
- Minimum coverage per feature: form validation, loading state, error state, successful submission fires mutation with correct payload.

**E2E tests** — Playwright:
- Config: `apps/web/playwright.config.ts` — baseURL `http://localhost:5173`, runs against a live API (`http://localhost:3000`).
- Tests live in `apps/web/e2e/*.spec.ts`.
- Use a test JWT generated at the start of each run (see E2E setup in Phase A).
- Each phase adds 1–2 happy-path E2E tests for its main workflow.

### Quality rules — non-negotiable

- TypeScript **strict mode on**. No `any`. No `as any`. If the generated API type is wrong, regenerate or write a narrow local type.
- Every data fetch: TanStack Query. No `useEffect(fetch)`.
- Every mutation: a dedicated hook, never inline `fetch` in a component.
- Every form: `react-hook-form` + `zodResolver`.
- All enums come from `@smmta/shared-types`. Never hard-code enum string literals.
- Accessibility: labels on every input, focus states visible, ARIA on custom controls.
- No dead code. No commented-out blocks. No `// TODO` without an owner/date.

### When stuck — source of truth order

1. `apps/api/src/modules/*/＊.routes.ts` — request/response shape
2. `apps/api/src/modules/*/＊.schema.ts` — field validation
3. `packages/shared-types/src/index.ts` — enums & cross-cutting types
4. `http://localhost:3000/docs/json` — regenerate types with the `gen:api-types` script

---

## PHASE A — Foundation

**Goal:** Stand up the app shell, auth, routing, API client, codegen, testing infrastructure, and a single working Customers list so the user can verify the full stack end-to-end.

### Build tasks

1. Install every dependency from the Tech Stack and Testing Infrastructure sections above into `apps/web` (use `npm install --workspace=apps/web ...`).
2. Configure Vite with `@tanstack/router-vite-plugin`, `@tailwindcss/vite`, and the React plugin.
3. Set up Tailwind v4 with shadcn theme tokens in `src/globals.css`.
4. Add npm scripts to `apps/web/package.json`:
   - `"gen:api-types": "openapi-typescript http://localhost:3000/docs/json -o src/lib/api-types.ts"`
   - `"test": "vitest run"`
   - `"test:watch": "vitest"`
   - `"test:e2e": "playwright test"`
5. Run `gen:api-types` once, commit the generated file.
6. Install these shadcn/ui components: button, input, label, textarea, select, checkbox, radio-group, switch, dialog, alert-dialog, dropdown-menu, tabs, toast, table, card, badge, avatar, separator, scroll-area, skeleton, sheet, tooltip, popover, calendar, form, plus a custom `data-table/` wrapper over TanStack Table.
7. Build the core lib:
   - `src/lib/api-client.ts` — single `apiFetch<T>(path, opts)` function: prepends `VITE_API_BASE_URL`, adds `Authorization: Bearer <token>` from `localStorage['smmta_token']`, JSON content-type, on 401 clears token and redirects to `/login`, unwraps `{success, data}` envelope, throws `ApiError` on `success: false`.
   - `src/lib/auth.ts` — `getToken()`, `setToken()`, `clearToken()`, `useAuth()` hook that reads token from localStorage.
   - `src/lib/query-client.ts` — `QueryClient` with 30-second stale time and exponential retry on 5xx only.
   - `src/lib/format.ts` — `formatMoney(value, currency)`, `formatDate(iso)`, `formatDateTime(iso)`, `formatPercent(value)`.
   - `src/lib/utils.ts` — `cn()` with clsx+tailwind-merge.
8. Build `src/App.tsx` — wraps `QueryClientProvider`, `RouterProvider`, `<Toaster/>`.
9. Routes (file-based):
   - `src/routes/__root.tsx` — outlet only.
   - `src/routes/login.tsx` — one input for JWT + "Sign in" button. On submit, `setToken()` and navigate to `/`.
   - `src/routes/_authed/route.tsx` — auth guard (redirect to `/login` if no token) + sidebar + header shell.
   - `src/routes/_authed/index.tsx` — dashboard with four placeholder KPI `<Card>`s.
   - `src/routes/_authed/customers/index.tsx` — Customers list with one column (`name`) using `useCustomersList()`.
10. Build `src/features/customers/use-customers.ts` with `useCustomersList(params)` hook.
11. E2E bootstrap: create `apps/web/e2e/helpers/auth.ts` with a function that runs `npx tsx ../api/generate-test-token.ts` (from the web dir) via Playwright's `globalSetup`, stores the token into `localStorage` via `page.addInitScript()`.

### Test Loop (Phase A)

**Unit/integration tests to write:**
- `src/lib/api-client.test.ts`:
  - Attaches Bearer token when present
  - Omits Authorization when no token
  - Unwraps `{ success: true, data }` correctly
  - Throws `ApiError` with message on `{ success: false, error }`
  - Clears token and redirects on 401 (mock `window.location`)
- `src/lib/format.test.ts`:
  - `formatMoney(1234.5, 'GBP')` → `£1,234.50`
  - `formatDate('2026-04-16')` → `16 Apr 2026`
  - Handles `null`/`undefined` gracefully
- `src/features/customers/use-customers.test.tsx`:
  - Renders loading → data → empty-list states with MSW mocking `GET /customers`
  - Refetches when search param changes

**E2E tests to write:**
- `apps/web/e2e/login.spec.ts`:
  - Visit `/` with no token → redirected to `/login`
  - Enter token + click Sign in → lands on dashboard with sidebar visible
- `apps/web/e2e/customers-empty.spec.ts`:
  - Authenticated user navigates to Customers → sees "No customers yet" empty state

**Run the Test Loop** (see META-INSTRUCTIONS). Fix bugs until all pass. Then commit:
```bash
git add -A
git commit -m "feat(web): phase A foundation — auth, routing, api client, codegen, test infra (all tests passing)"
```

### Report

Summarise in 10 lines or fewer: deps installed, routes wired, test counts (unit/e2e), any user decisions needed. Then proceed to Phase B.

---

## PHASE B — Core CRUD

**Goal:** Full CRUD for Customers, Suppliers, Products, Warehouses, Categories, Manufacturers, Customer Types. Includes related resources (contacts, addresses, notes, images).

### Build tasks

For each resource:
- List page: search (debounced 300ms), sortable columns, pagination, "+ New" button, row click → detail, empty state.
- Create page or modal (pick one, be consistent — recommended: page for Customers/Suppliers/Products, modal for reference data).
- Detail page: edit form, breadcrumbs, save button, delete with `<AlertDialog>`.
- Hook file: `features/<resource>/use-<resource>.ts` with `useList`, `useOne`, `useCreate`, `useUpdate`, `useDelete`.

Additional tabs:
- **Customers**: General / Contacts / Delivery Addresses / Invoice Addresses / Notes / Product Prices
- **Suppliers**: General / Contacts / Addresses / Notes
- **Products**: General / Images / Stock (read-only per-warehouse table) / Categories multi-select

Forms must use `react-hook-form` + `zodResolver`. Zod schemas should mirror the API's schemas — **read** `apps/api/src/modules/*/*.schema.ts` **to get the exact field rules** (required, defaults, max length, enum values).

Money fields → `<MoneyInput>` (string-based, 2 decimal places). Enum dropdowns → import from `@smmta/shared-types`. Date fields → shadcn `<DatePicker>`.

### Test Loop (Phase B)

**Unit/integration tests:**
For each resource (minimum):
- Form: renders all fields; fails validation when required fields empty; calls `useCreate` with correct payload on submit.
- List: renders rows from mocked data; search input updates query param after debounce; pagination "Next" increments page.
- Detail: loads record; edit + save calls `useUpdate`; delete button + confirm calls `useDelete`.

For Customers specifically, additional tests:
- Contacts tab: add / edit / remove flow with MSW mocks for `POST/PUT/DELETE /customers/:id/contacts`.
- Product Prices tab: set price for product, remove price.

**E2E tests:**
- `apps/web/e2e/customer-crud.spec.ts` — create, edit name, add a contact, delete customer (end-to-end against live API).
- `apps/web/e2e/supplier-crud.spec.ts` — create, edit, delete.
- `apps/web/e2e/product-crud.spec.ts` — create with category + manufacturer, edit, verify stock-levels table renders empty.

**Run the Test Loop**. Fix. Commit:
```
feat(web): phase B core CRUD — customers, suppliers, products, reference data (all tests passing)
```

---

## PHASE C — Orders & Invoicing

**Goal:** Full order lifecycle — create, allocate stock, invoice, credit, pay.

### Build tasks

- Orders list: status filter chips (DRAFT, CONFIRMED, ALLOCATED, SHIPPED, CANCELLED, COMPLETED), customer filter, date-range filter.
- Orders create page: customer picker (searchable), lines table (add/remove rows, product picker, qty, unit price, tax treatment dropdown from enum), auto-calculated sub-totals/VAT/total.
- Orders detail: header card with status + totals + customer + dates; tabs for Lines / Allocations / Notes / History.
- Status transition buttons mapped to `PUT /orders/:id/status` — CONFIRM, ALLOCATE, SHIP, CANCEL. Each disabled when not in a valid source state.
- "Allocate Stock" button → `POST /orders/:id/allocate`, toast with number of items allocated.
- "Create Invoice" button → `POST /orders/:id/invoice`, on success navigate to invoice detail.
- Invoices list (filter by status, customer, date).
- Invoice detail with tabs: Lines / Payments / Credit Notes.
- Credit note modal from invoice: line selection + quantities → `POST /invoices/:id/credit-note`.
- Payment allocation modal from invoice: amount + date + reference → `POST /invoices/:id/payment`.

### Test Loop (Phase C)

**Unit/integration:**
- Order form: line totals recalculate when qty or price changes; VAT amount correct for each `VatTreatment`; order total = subtotal + VAT − discounts.
- Status transition buttons disabled correctly based on current status (table-driven test — iterate through every pair).
- Credit note modal: cannot credit more than invoiced qty; total credit amount recalculates.
- Payment modal: cannot allocate more than outstanding amount.

**E2E:**
- `apps/web/e2e/order-lifecycle.spec.ts`: create customer → create product → add stock (direct API setup) → create order → confirm → allocate → ship → invoice → apply payment → verify status = COMPLETED, invoice status = PAID.
- `apps/web/e2e/credit-note.spec.ts`: on an existing invoice, create a credit note for 1 line → verify GL posting log contains CUSTOMER_CREDIT_NOTE entry (query API).

**Run Test Loop**. Commit:
```
feat(web): phase C orders & invoicing — lifecycle, credit notes, payments (all tests passing)
```

---

## PHASE D — Purchasing

**Goal:** PO lifecycle — create, book-in (GRN), invoice, pay.

### Build tasks

- Purchase Orders list + create (supplier picker, lines with product/qty/cost) + detail with tabs (Lines / GRNs / Invoices).
- "Book In" modal per PO: for each open line, inputs for qty received, cost per unit, serial numbers (comma-separated or one-per-line), warehouse → `POST /purchase-orders/:id/book-in`. Validates qty received ≤ outstanding.
- PO status: OPEN / PARTIALLY_RECEIVED / FULLY_RECEIVED / CLOSED — badge with colour.
- "Create Invoice" from PO → `POST /purchase-orders/:id/invoice`.
- Supplier Invoices list + detail (mirrors customer Invoices UI).
- Credit note modal + payment modal — same UX as customer side.

### Test Loop (Phase D)

**Unit/integration:**
- Book-in form: validates qty received against outstanding; parses serial numbers (handles both comma and newline separators); submits correct payload.
- PO status badge colour mapping test (table-driven).

**E2E:**
- `apps/web/e2e/po-lifecycle.spec.ts`: create supplier → create PO → book in → verify stock items created in API → create supplier invoice → apply payment.
- `apps/web/e2e/po-partial-receipt.spec.ts`: PO with 2 lines, book in only 1 → status = PARTIALLY_RECEIVED.

**Run Test Loop**. Commit:
```
feat(web): phase D purchasing — PO, GRN, supplier invoices (all tests passing)
```

---

## PHASE E — Stock operations

**Goal:** Stock visibility + adjustments + transfers + valuation + serial lookup.

### Build tasks

- Stock Items list with filters (product, warehouse, status: AVAILABLE/ALLOCATED/SOLD/WRITTEN_OFF).
- Stock Adjustment screen: product picker, warehouse picker, qty (+/−), reason (dropdown: FOUND, LOST, DAMAGED, COUNT_CORRECTION, OTHER), cost per unit → `POST /stock-items/adjust`.
- Stock Transfer screen: source warehouse, target warehouse, product, qty → `POST /stock-items/transfer`.
- Stock Valuation Report: grouped-by-warehouse view with subtotals and grand total, export-CSV button (client-side generation, no API).
- Serial Number Lookup: single input → `GET /stock-items/check-serial/:serial` → displays result card (product, warehouse, status, cost, linked order).

### Test Loop (Phase E)

**Unit/integration:**
- Adjustment form: negative qty allowed, reason required, cost required when qty > 0.
- Transfer form: source ≠ target validation.
- Valuation CSV export: correct column order and row count for mocked data.

**E2E:**
- `apps/web/e2e/stock-adjust.spec.ts`: adjust stock +5 → verify via API stock-items list.
- `apps/web/e2e/stock-transfer.spec.ts`: transfer 3 from Warehouse A to Warehouse B → verify both balances.
- `apps/web/e2e/serial-lookup.spec.ts`: book-in a PO with serial "SN-123" → lookup "SN-123" → card shows correct product.

**Run Test Loop**. Commit:
```
feat(web): phase E stock operations — adjust, transfer, valuation, serial lookup (all tests passing)
```

---

## PHASE F — Integrations & Bulk Ops

**Goal:** Marketplace + CSV imports, plus bulk order operations.

### Build tasks

- Marketplace Import page: tabs for Shopify / Amazon / eBay / Etsy. Each tab: config form (API credentials — stored only in-memory for now), "Fetch preview" button showing a table of normalised orders, "Import selected" button → `POST /import/marketplace`.
- CSV Import page: file upload (parse client-side using the first row as headers, show mapping preview), "Import" button → `POST /import/csv-orders` with JSON payload.
- Orders list: row-select checkboxes + header "select all visible" + multi-select actions dropdown with: Bulk Status Change → `POST /orders/bulk/status`; Bulk Ship → `POST /orders/bulk/ship` (tracking input per order in a modal); Bulk Invoice → `POST /orders/bulk/invoice`; Bulk Allocate → `POST /orders/bulk/allocate`. Each action shows a results summary (succeeded count / failed count + list).

### Test Loop (Phase F)

**Unit/integration:**
- CSV parser: handles quoted fields with commas, missing optional columns, rejects missing required columns with a clear error.
- Bulk action modal: empty selection disables actions; results summary renders success and failure rows.

**E2E:**
- `apps/web/e2e/bulk-invoice.spec.ts`: create 3 orders → select all → bulk invoice → verify 3 new invoices via API.
- `apps/web/e2e/csv-import.spec.ts`: upload a fixture CSV with 2 orders → import → verify orders exist.

**Run Test Loop**. Commit:
```
feat(web): phase F integrations & bulk ops — marketplace, CSV, bulk actions (all tests passing)
```

---

## PHASE G — Polish

**Goal:** Real dashboard, settings, empty states, error boundaries, loading skeletons, keyboard nav, mobile.

### Build tasks

- Dashboard KPIs (real data): Open Orders count + total value, Stock Value by warehouse, Unpaid Customer Invoices total, Unpaid Supplier Bills total, Recent Activity feed (last 20 significant events: orders created, invoices issued, stock adjusted) — each pulls from the relevant list endpoint with appropriate filters.
- Settings page with sub-tabs: Warehouses, Categories, Manufacturers, Customer Types, Year-End Close (button + confirm dialog → `POST /year-end-close`).
- Shared `<EmptyState>` component used in every list's empty case, with illustration (use a lucide icon + muted text + CTA button).
- Route-level `<ErrorBoundary>` — renders a "Something went wrong" card with a Retry button and shows the error message in a collapsed `<details>` block in dev mode only.
- Loading skeletons on every list (use shadcn `<Skeleton>`) — replace spinner placeholders from earlier phases.
- Keyboard shortcuts via a `<CommandPalette>` (cmd+k / ctrl+k): navigate to Customers, Orders, Products, etc. + "Create new ..." actions.
- Mobile breakpoints: hide sidebar below `md`, show hamburger-triggered `<Sheet>`.

### Test Loop (Phase G)

**Unit/integration:**
- Dashboard: renders all 4 KPI cards with mocked data; handles all-loading state; handles error in one KPI without breaking the others.
- ErrorBoundary: throws from child → renders fallback; retry button resets.
- CommandPalette: opens on cmd+k; filters items as user types; selecting item navigates.

**E2E:**
- `apps/web/e2e/dashboard.spec.ts`: login → dashboard → all 4 KPIs populated with real data.
- `apps/web/e2e/mobile-nav.spec.ts`: set viewport to 375x812 → sidebar hidden → hamburger opens sheet → nav works.
- `apps/web/e2e/year-end.spec.ts`: settings → year-end close → confirm → verify Luca period status via API.

**Run Test Loop**. Commit:
```
feat(web): phase G polish — dashboard, settings, empty states, errors, shortcuts, mobile (all tests passing)
```

---

## FINAL REPORT

After Phase G completes and commits successfully, print a final report:

```
=== SMMTA-Next Frontend Build Complete ===

Phases completed: A, B, C, D, E, F, G

Files created: <count>
Lines of code: <count>

Tests:
  Unit/integration: <N> tests, <X> passed
  E2E:              <M> tests, <Y> passed

Commits:
  feat(web): phase A ...
  feat(web): phase B ...
  ...

Known limitations:
  - <list any features deferred>
  - <list any tests skipped with reason>

To run locally:
  npm run dev --workspace=apps/web   # http://localhost:5173

To deploy:
  npm run build --workspace=apps/web
  # Serve dist/ behind Nginx — see docs/VPS-SETUP-GUIDE.md
```

Done.
