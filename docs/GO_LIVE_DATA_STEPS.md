# Go-live data steps

Everything that has to happen **after** the code is deployed and **before** the
venue retest is meaningful. The code fixes the behaviour; these steps supply the
data it needs to behave correctly.

Work through it top to bottom — the order matters in two places, flagged where
it does.

> **Prerequisite:** `stock-api` and `stock-web` both deployed from `autostock`.
> See `DEPLOY_COOLIFY.md`. Migrations run automatically in the API container's
> start command; if the container reports healthy, they applied.

---

## The three places commands run

Every step below is stamped 🖥️, 🐳 or 💻. There are only these three.

| | Place | How to get there |
|---|---|---|
| 🖥️ | **The admin site**, in a browser | `https://stock.thebigbakes.com`, signed in |
| 🐳 | **A shell inside the API container** | Coolify → Projects → Big Bakes Stock System → production → **Stock App API** → left menu, under *Observe & troubleshoot* → **Terminal** |
| 💻 | **PowerShell on your own PC** | Any window. Talks to the public API over HTTPS; nothing to do with the server |

⚠️ For 🐳, **not** the *Terminal* in the far-left workspace sidebar — that is a
shell on the host server, where the app's files and `node_modules` don't exist.
Use the one on the Stock App API page.

Confirm you're in the right shell before running anything:

```bash
pwd && ls package.json apps/api/scripts/import-recipes.ts
```

Expect `/app` and both files. "No such file or directory" means you're on the
host — go back and use the app's own Terminal.

---

## Step 1 🐳 — Head-baker PINs, one per site

```bash
npx tsx apps/api/scripts/seed-head-baker-pins.ts --dry-run
```

Then without `--dry-run` to write.

⚠️ **Write the PINs down as they print.** They are hashed on the way in and
cannot be recovered. There is no admin page for device PINs yet, so rotating one
later means deactivating a row in the database.

Idempotent — a site that already has an active head-baker PIN is left alone, so
re-running never mints a second or invalidates one in use. The script refuses to
issue two sites the same PIN: `pin-login` without a site id takes the first PIN
whose hash verifies, so a collision would log a baker into an arbitrary site and
file their counts against the wrong one, silently.

To choose a PIN rather than generate one, set `HEAD_BAKER_PIN_<SITE>` first —
e.g. `HEAD_BAKER_PIN_LONDON_SOUTH=481920`.

✅ One PIN per site, all distinct, all recorded somewhere safe.

## Step 2 🐳 — Purge the demo cakes

> **⚠️ ORDER MATTERS — this must happen BEFORE the recipe import.**
> The purge deletes recipes by **cake name**, and `Battenburg` is both one of
> the four invented demo cakes and a cake Big Bakes actually sells. Import
> first and the purge would delete your real Battenburg recipe on the way past.

```bash
npm run purge:demo-bakes -w @smmta/api -- --dry-run
```

Read the report, then run it again without `--dry-run`.

It removes the four invented cakes (Victoria Sponge, Coffee & Walnut Delight,
Battenburg, Burger Cake) and the ingredient products they introduced — but
**keeps** anything with stock movements, a stock level, consumption history, or
a line in a non-demo recipe, and tells you what it kept and why. Anything in the
KEPT list is real work from the 12 August session, correctly protected.

✅ 🖥️ The End of Bake cake list is empty, and none of the four demo names appear.

## Step 3 🐳 — Get the CSVs into the container

Head office supplies `ingredients.csv` and `recipes.csv` per
`docs/RECIPE_IMPORT.md`. **These are the long pole — chase them early.**

The Coolify terminal has no file upload, but the container is only a staging
post: the importer writes straight to the database, so `/tmp` is enough.

Paste each file with a heredoc — type the first line, paste the CSV body, then
`CSVEOF` on its own line:

```bash
cat > /tmp/ingredients.csv <<'CSVEOF'
<paste the whole file, header included>
CSVEOF
```

Repeat for `/tmp/recipes.csv`. The quotes around `'CSVEOF'` matter — they stop
the shell interpreting `£`, `$` or backticks in your data.

✅ `wc -l /tmp/ingredients.csv /tmp/recipes.csv` — line counts match the
spreadsheets.

> **Use absolute paths** (`/tmp/…`) in the next two steps. `npm run -w
> @smmta/api` runs with the working directory set to `apps/api`, so a path
> relative to the repo root resolves to `apps/api/<path>` and the import fails
> with a file-not-found.

## Step 4 🐳 — Dry-run the import

```bash
npm run import:recipes -w @smmta/api -- \
  --ingredients /tmp/ingredients.csv \
  --recipes /tmp/recipes.csv \
  --dry-run
```

Two possible outcomes:

- **`No problems found.`** → step 5.
- **A table of `FILE / ROW / RULE / PROBLEM`.** Any problem fails the whole
  import and nothing is written — deliberately, because a half-imported menu is
  harder to reason about than none. Row numbers count the way a person does
  (header is row 1), so they map straight onto the spreadsheet.

Fix in the source spreadsheet, re-paste, re-run. Every rule is documented in
`docs/RECIPE_IMPORT.md`. The two that catch the 12 August defect specifically:

| Rule | What it means |
|---|---|
| `gf-offered-without-variant` | A cake sold gluten-free with no GF lines — selecting GF would silently serve the standard recipe |
| `remove-not-in-base` | A `GF_REMOVE` naming an ingredient the base recipe never had — nothing would be removed |

## Step 5 🐳 — Import for real

```bash
npm run import:recipes -w @smmta/api -- \
  --ingredients /tmp/ingredients.csv \
  --recipes /tmp/recipes.csv
```

✅ `N ingredients, M new recipes, 0 superseded`.

Idempotent on `(bake, site, effective_from)`, so a corrected file can be re-run
as many times as needed — reruns report as *superseded* rather than duplicating.

## Step 6 🐳 — Audit the result

```bash
npx tsx apps/api/scripts/audit-recipes.ts
```

Read-only. It reports recipe lines pointing at products that no longer exist,
**and unit mismatches** — which is the one that bites. A line stored in grams
re-pointed at a product measured in kilograms turns 250 g of flour into 250 kg.
No validation catches that, because 250 kg is a legal number; it surfaces later
as an enormous materials cost and a reorder proposal nobody can explain.

✅ No broken lines, no unit mismatches.

## Step 7 🖥️ — Work "Needs setup" to zero

Admin site → **Needs setup** (`/products/needs-setup`).

Every stocked product that can't be received or counted properly: missing
purchase unit, missing pack size, zero cost, no barcode.

**Anything left here fails the retest at step 12 or 14.** Defects C-1 and C-2
were exactly this — the model existed, the data didn't.

✅ The list is empty.

## Step 8 💻 — Reverse the 12 August Birmingham booking

There's no admin page for goods-in receipts yet, so this is an API call.

Get a token: signed in to the admin site, DevTools → Application → Local
Storage → copy `smmta_token`.

Find the receipt:

```powershell
curl.exe -H "Authorization: Bearer <token>" `
  "https://stock-api.thebigbakes.com/api/v1/goods-in?siteId=<birmingham-site-id>"
```

(Site ids come from `https://stock-api.thebigbakes.com/api/v1/sites` with the
same header. Receipts come back newest first.)

Reverse it:

```powershell
curl.exe -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" `
  -d '{\"reason\":\"Booked to the wrong venue on 12 Aug\"}' `
  "https://stock-api.thebigbakes.com/api/v1/goods-in/<receipt-id>/reverse"
```

Needs `site_manager` or `admin`. It writes an **opposite movement** rather than
editing history — the ledger keeps both rows and they cancel.

> In PowerShell, `curl` is an alias for `Invoke-WebRequest`, which doesn't
> understand these flags. Use **`curl.exe`**, with the `.exe`.

## Step 9 — Recount 12 August

Operational, not a command. Any count taken on 12 August went through the
blanket-quantum bug, so a 4 kg count may be recorded as 0. Recount anything from
that day.

---

## When you're done

Run `docs/RETEST_2026-08-12.md` at the venue — a numbered script mirroring the
original session, with each step tagged by the defect ID it re-tests, so a
failure comes back as "step 14 — C-1 is back" rather than a paragraph.

---

## Removed from this list

**Setting "benches per table" per site.** A bench and a table are the same
thing — one team baking one cake, "bench" being the venue's word. A per-site
conversion ratio was added on 20 August on a misreading and dropped the same day
(migration `0045`). There is no bench setting to configure, and the field is
gone from the Sites page. See the F16 entry in `DECISIONS.md`.
