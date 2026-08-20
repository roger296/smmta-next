# Recipe import templates

Two blank CSVs to fill in, and one worked example to copy the shape from.

| File | What it is |
|---|---|
| `ingredients.template.csv` | Header row only. Fill in below it. |
| `recipes.template.csv` | Header row only. Fill in below it. |
| `EXAMPLE-battenburg-ingredients.csv` | A complete, valid ingredient set — **an example, not data to import** |
| `EXAMPLE-battenburg-recipes.csv` | The same cake as a full recipe, with gluten-free and vegan variants |

The blank templates are headers only on purpose: an example row left in by
accident becomes a real product or a real cake, which is how four invented demo
cakes reached a live venue test in the first place (defect F-4).

Full column reference, every validation rule, and the arithmetic behind the
variants: **`docs/RECIPE_IMPORT.md`**. What follows is the short version for
whoever is filling the spreadsheet in.

---

## `ingredients.csv` — one row per ingredient

| Column | Required | Notes |
|---|---|---|
| `slug` | **yes** | Stable key, lower-case-with-hyphens, e.g. `plain-flour`. This is what `recipes.csv` refers to and what a re-import matches on. Choose it once; don't change it later. |
| `name` | **yes** | What a baker sees on the iPad. |
| `stock_uom` | **yes** | The unit **recipes are written in** — `g`, `ml`, `each`. Stock is counted in this unit. |
| `purchase_uom` | no | What you *buy* it in — `sack`, `case`, `tray`. Blank if you buy it in the stock unit. |
| `purchase_to_stock_factor` | no | Stock units per purchase unit. A 16 kg sack of flour is `16000`. Defaults to `1`. |
| `pack_description` | no | Human label for the pack, e.g. `16 kg sack`. Shown on goods-in. |
| `expected_next_cost` | no | Cost per **stock** unit, to 6 decimals — a gram of flour is a fraction of a penny. |
| `barcode` | no | Scanned on goods-in. |
| `count_quantum` | no | Rounding bucket for stock-takes. **Leave blank for no rounding.** |

⚠️ **Three that caused real defects on 12 August:**

- **`purchase_uom` + `purchase_to_stock_factor` blank** is what made a 25 kg
  sack of icing sugar read as `= 1 g` on the iPad (C-1/C-2). Fill them in.
- **`expected_next_cost`** needs the per-**stock**-unit figure. £30 a sack over
  16,000 g is `0.001875`, not `30`.
- **`count_quantum` must be blank, never `0`.** `0` is rejected. A default
  rounding bucket silently turned a 4 kg count into 0 (D-2).

## `recipes.csv` — one row per ingredient line

A recipe version is every row sharing a `(bake, site_slug, effective_from)`.

| Column | Required | Notes |
|---|---|---|
| `bake` | **yes** | The cake. Free text; it's the name bakers tap. |
| `effective_from` | **yes** | `YYYY-MM-DD`. Applies from this date until a later version supersedes it. |
| `site_slug` | no | Blank = the recipe for all sites. A slug (`london-east`) makes a site override that beats the group one there. |
| `variant` | no | `BASE` (default), `GF_REMOVE`, `GF_ADD`, `VEGAN_REMOVE`, `VEGAN_ADD`. |
| `ingredient_slug` | **yes** | Must exist in `ingredients.csv`. |
| `qty_per_table` | **yes**, except on `*_REMOVE` | Per **bench** (one team, one cake), in that ingredient's `stock_uom`. Must be greater than zero. |
| `unit_cost` | no | Overrides the product's cost for this line. |

> **`qty_per_table` means per bench.** A bench and a table are the same thing —
> "bench" is the word used in the venue, "table" the word in the spec, and the
> column name follows the spec. One row of guests baking one cake.

### The variants

Every bench bakes the cake, so `BASE` applies to **all** of them. A gluten-free
or vegan bench then deviates: some base ingredients come out, substitutes go in.

```
expected = base × totalBenches
         − base × glutenFreeBenches   (if listed in GF_REMOVE)
         − base × veganBenches        (if listed in VEGAN_REMOVE)
         + gfAdd × glutenFreeBenches
         + veganAdd × veganBenches
```

⚠️ A `*_REMOVE` row carries **no quantity** — leave `qty_per_table` blank.
Removing an ingredient takes out however much that bench would have used, which
the system already knows from the `BASE` line.

> A blank template on its own won't validate — a dry run reports
> `no-data-rows`, "Header only". That's expected; fill it in first.

## Before you send it back

Nothing is written unless the whole file validates, so a dry run is free:

```bash
npm run import:recipes -w @smmta/api -- \
  --ingredients /tmp/ingredients.csv \
  --recipes /tmp/recipes.csv \
  --dry-run
```

Any problem fails the entire import and prints a `FILE / ROW / RULE / PROBLEM`
table. Row numbers count the way a person does — the header is row 1 — so they
map straight onto the spreadsheet.

The two rules worth knowing before you start, because they catch the defect
that made the 12 August test fail:

| Rule | What it means |
|---|---|
| `gf-offered-without-variant` | A cake sold gluten-free with no GF lines — selecting GF would silently serve the standard recipe |
| `remove-not-in-base` | A `GF_REMOVE` naming an ingredient the `BASE` recipe never had — nothing would be removed |
