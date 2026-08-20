# Recipe import

Recipes are **imported from head office's spreadsheets, not seeded**.

Until August 2026 the menu came from `scripts/seed-bakes.ts`, which invented
four cakes. The 12 Aug South London live test found them immediately —
*"Displayed recipes are not part of our offering of course"* (F-4) — and, worse,
every seeded line was a `BASE` line, so the gluten-free / vegan machinery had
nothing to act on: *"Selecting Vegan or GF options for Battenburg failed to
generate required ingredients"* (F-5).

The seed now lives at `scripts/demo/seed-bakes.demo.ts`, refuses to run in
production, and refuses to run at all once real recipes exist. The real menu
arrives through the importer described here.

---

## Templates

Blank CSVs to fill in, plus a complete worked example, live in
**`docs/templates/`** — see the README there for a per-column crib aimed at
whoever fills the spreadsheet in. The templates are headers only on purpose: an
example row left in by accident becomes a real cake, which is how the demo
menu reached a live venue test (F-4).

## Running it

```bash
DATABASE_URL=... npm run import:recipes -w @smmta/api -- \
  --ingredients ./ingredients.csv \
  --recipes ./recipes.csv \
  --dry-run
```

Drop `--dry-run` to write. Always dry-run first: the report is the same either
way, and a dry run touches nothing.

Then remove the demo cakes, once:

```bash
DATABASE_URL=... npm run purge:demo-bakes -w @smmta/api -- --dry-run
```

The purge deletes the four demo recipes and the ingredient products they
introduced — **but only where nothing real points at them**. An ingredient with
stock movements, a stock level, consumption history, or a line in a
non-demo recipe is reported and kept. A demo name on a product does not make
the ledger behind it demo data.

### The validation report is a gate, not advice

**Any problem fails the whole import and nothing is written.** A half-imported
menu is harder to reason about than none, and every rule below describes
something that becomes *invisible* once it is in the database — which is
exactly how F-5 survived all the way to a live test.

The report names the file, the row as a person counts it (header = row 1), the
rule, and what is wrong:

```
FILE          ROW  RULE                        PROBLEM
------------  ---  --------------------------  ------------------------------------
recipes.csv   14   remove-not-in-base          Battenburg from 2026-09-01: GF_REMOVE
                                               removes "plain-flour", which is not in
                                               the BASE recipe. Nothing would be removed.
```

### Idempotence

Keyed on `(bake, site, effective_from)`. Re-importing the same file supersedes
the matching recipe version **in place** rather than stacking another one
beside it, so a corrected spreadsheet can be re-run as many times as it takes.
Ingredients are upserted by `slug`.

---

## `ingredients.csv`

One row per ingredient product. `slug` is the stable key — it is what
`recipes.csv` refers to, and what a re-import matches on. Choose it once and
don't change it.

| Column | Required | Notes |
|---|---|---|
| `slug` | yes | Stable key, e.g. `plain-flour`. Unique within the file. |
| `name` | yes | What a baker sees on the iPad. |
| `stock_uom` | yes | The unit **recipes are written in** — `g`, `ml`, `each`. Stock is authored and counted in this unit; it is never silently converted. |
| `purchase_uom` | no | What you buy it in — `sack`, `case`, `tray`. Blank if you buy it in the stock unit. |
| `purchase_to_stock_factor` | no | Stock units per purchase unit. A 16 kg sack of flour is `16000`. Defaults to `1`. Must be positive. |
| `pack_description` | no | Human label for the pack, e.g. `16 kg sack`. Shown on goods-in. |
| `expected_next_cost` | no | Cost per **stock** unit. Stored at `numeric(18,6)` — 6 decimals, because a gram of flour is a fraction of a penny. Defaults to `0`. |
| `barcode` | no | Scanned on goods-in. |
| `count_quantum` | no | Rounding bucket for stock-takes, in stock units. **Leave blank for no rounding.** `0` is rejected: it is not a quantum, and a default quantum is what destroyed counts in defect D-2. |

## `recipes.csv`

One row per **ingredient line**. A recipe version is every row sharing a
`(bake, site_slug, effective_from)`.

| Column | Required | Notes |
|---|---|---|
| `bake` | yes | The cake. Free text; it is the menu name bakers tap. |
| `effective_from` | yes | `YYYY-MM-DD`. The version applies from this date until a later version supersedes it. |
| `site_slug` | no | Blank = the group recipe. A slug makes a **site override** that beats the group one at that site. |
| `variant` | no | `BASE` (default), `GF_REMOVE`, `GF_ADD`, `VEGAN_REMOVE`, `VEGAN_ADD`. |
| `ingredient_slug` | yes | Must exist in `ingredients.csv`. |
| `qty_per_table` | yes, except on `*_REMOVE` | Per **table**, in the ingredient's `stock_uom`. Teams bake together, so tables drive ingredient use, not head count. Must be greater than zero. |
| `unit_cost` | no | Cost per stock unit for this line; falls back to the product's. |

### How the variants combine

Every table bakes the cake, so the `BASE` recipe applies to **all** of them.
A gluten-free or vegan table then deviates:

```
expected(ingredient) = base × totalTables
                     − base × glutenFreeTables   (if it appears in GF_REMOVE)
                     − base × veganTables        (if it appears in VEGAN_REMOVE)
                     + gfAdd × glutenFreeTables
                     + veganAdd × veganTables
```

The reduction uses the **BASE** quantity, not the removal line's — which is why
a `*_REMOVE` row carries no `qty_per_table`. Taking an ingredient out means
taking out however much that table would have used.

### Validation rules

| Rule | What it catches |
|---|---|
| `missing-column` | A required column absent from the header. |
| `duplicate-slug` | The same ingredient defined twice. |
| `stock-uom-required` | An ingredient with no unit — every recipe quantity against it would be meaningless. |
| `factor-positive` | A `purchase_to_stock_factor` of zero or a non-number: goods-in would book in nothing. |
| `quantum-positive` | `count_quantum` of `0`. Blank means no rounding; `0` is a typo that reads as a bucket. |
| `bake-required` / `ingredient-required` | A line that names neither. |
| `effective-from-format` | Anything that is not `YYYY-MM-DD`. |
| `variant-known` | A misspelt variant (`GF-ADD`, `VEGAN`), which would otherwise be dropped to `BASE`. |
| `qty-required` / `qty-positive` | A missing or zero quantity on a line that needs one. **A zero-quantity line consumes nothing while still looking, in the editor, like the ingredient is accounted for.** |
| `unit-cost-valid` | A negative or non-numeric cost. |
| `unknown-ingredient` | A recipe line naming a slug not in `ingredients.csv`. |
| `base-required` | A version with only variant lines. A variant with no standard recipe to vary produces nothing — F-5's shape. |
| `remove-not-in-base` | `GF_REMOVE` naming an ingredient the `BASE` recipe never had. Nothing would be removed, silently. |
| `gf-offered-without-variant` / `vegan-offered-without-variant` | A cake sold gluten-free or vegan with no variant lines at all. **This is F-5 exactly.** |
| `duplicate-effective-from` | Two versions of the same cake starting the same day — which one applies is undefined. |

---

## Worked example — Battenburg, with GF and vegan

`ingredients.csv`:

```csv
slug,name,stock_uom,purchase_uom,purchase_to_stock_factor,pack_description,expected_next_cost,barcode,count_quantum
plain-flour,Plain Flour,g,sack,16000,16 kg sack,11.4,,
gf-flour-blend,Gluten-Free Flour Blend,g,bag,1500,1.5 kg bag,4.85,,
unsalted-butter,Unsalted Butter,g,case,10000,10 kg case,58.2,,
vegan-block,Vegan Baking Block,g,case,5000,5 kg case,31.5,,
free-range-egg,Free-Range Egg,each,tray,30,tray of 30,0.24,,30
aquafaba,Aquafaba,ml,tin,400,400 ml tin,0.9,,
marzipan,Marzipan,g,block,1000,1 kg block,6.1,,
```

`recipes.csv`:

```csv
bake,effective_from,site_slug,variant,ingredient_slug,qty_per_table,unit_cost
Battenburg,2026-01-01,,BASE,plain-flour,400,0.000713
Battenburg,2026-01-01,,BASE,unsalted-butter,300,0.00582
Battenburg,2026-01-01,,BASE,free-range-egg,6,0.24
Battenburg,2026-01-01,,BASE,marzipan,250,0.0061
Battenburg,2026-01-01,,GF_REMOVE,plain-flour,,
Battenburg,2026-01-01,,GF_ADD,gf-flour-blend,420,0.003233
Battenburg,2026-01-01,,VEGAN_REMOVE,unsalted-butter,,
Battenburg,2026-01-01,,VEGAN_REMOVE,free-range-egg,,
Battenburg,2026-01-01,,VEGAN_ADD,vegan-block,300,0.0063
Battenburg,2026-01-01,,VEGAN_ADD,aquafaba,180,0.00225
```

A session of **10 tables — 7 regular, 2 gluten-free, 1 vegan** then expects:

| Ingredient | Sum | Expected |
|---|---|---|
| Plain flour | `400 × 10 − 400 × 2` | 3,200 g |
| Gluten-free flour blend | `420 × 2` | 840 g |
| Unsalted butter | `300 × 10 − 300 × 1` | 2,700 g |
| Vegan baking block | `300 × 1` | 300 g |
| Free-range egg | `6 × 10 − 6 × 1` | 54 each |
| Aquafaba | `180 × 1` | 180 ml |
| Marzipan | `250 × 10` | 2,500 g |

Marzipan appears in no removal list, so all ten tables use it.

Note the vegan table removes both butter **and** eggs, and adds two
replacements. That asymmetry is the point of the model, and it is what the
old all-`BASE` seed could not express.

---

## What happens on the iPad when a recipe is missing

Since August 2026 the End of Bake screen **refuses**, rather than showing an
empty list and a toast that disappears:

- No recipe for the cake / date / site → a blocking notice naming all three,
  and *"This bake cannot be submitted."*
- Gluten-free or vegan tables entered for a cake with no such variant → the
  same refusal, naming the diet.
- On the setup screen, a cake with no gluten-free variant **disables** the
  gluten-free table field with *"No gluten-free recipe for this cake — ask
  head office."* — rather than accepting a number that would silently do
  nothing.

A baker must never be able to file an empty bake, and must never be told
nothing is wrong when something is.

---

## Test fixture

`apps/api/test/fixtures/recipes/{ingredients,recipes}.csv` hold the same shape
under a `ZZ Test Fixture Cake` / `zz-test-*` namespace, so a fixture can never
be mistaken for the menu in a product list sorted by name.
