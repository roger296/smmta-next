#!/usr/bin/env python3
"""
Turn Rebecca's supplier-SKU workbook into importable CSVs.

    python apps/api/scripts/extract-supplier-catalogue.py ["C:\\path\\to\\book.xlsx"]

Reads the **Main List** tab only. The other tabs (Fondant, Food colouring,
Essences, Baking/Site equipment, one-off purchases) are supplier price lists in
different shapes, not product->supplier mappings, and are deliberately ignored.

Writes to apps/api/data/supplier-catalogue/:
    suppliers.csv          name, slug
    products-new.csv       products the sheet prices but the count list never had
    supplier-products.csv  the mappings themselves
    skipped.csv            every row NOT imported, with the reason
    extract-report.txt     the counts, so a re-run can be diffed

⚠️ Read the xlsx, NOT a Google Sheets export. Exporting this workbook as one
document concatenates all eight tabs into a single stream with four different
column layouts, which silently mixes price-list rows into the mapping rows.

A row with no supplier SKU is imported as PLACEHOLDER_SKU ("NOSKU"), on Roger's
call. Note what that means: the DB identity is (product, supplier, supplierSku),
so EVERY unmarked row for the same product+supplier collapses into ONE — which
is right, they are the same purchase line seen on different invoices, but it is
why the mapping count rises by less than the row count. A NOSKU line also
cannot be ordered against until someone fills the real code in.

A row with no readable price is imported at PLACEHOLDER_PRICE (GBP0.10) rather
than dropped, on Roger's call — the mapping is the valuable part and a missing
price only makes a proposal's VALUE wrong, not its existence. 0.10 is chosen
deliberately over 0.00: it is obviously not a real price, it survives any
"cost must be > 0" check, and `WHERE cost_gbp = 0.10` finds every one of them
later. They are counted in the report and flagged in the CSV so the number is
never mistaken for real costing.
"""
import csv, os, re, sys

import openpyxl

DEFAULT_SRC = (
    r"C:\Users\roger\Product Search - CleverDeals\Docapole"
    r"\Rogers Copy of Rebecca Prospective SKUs for stock system.xlsx"
)
SHEET = "Main List"

# Column positions in Main List (0-based).
C_MAIN_SKU, C_MAIN_NAME, C_INVOICE_NAME, C_CATEGORY = 0, 1, 2, 3
C_GROUP_ID, C_SUPPLIER_SKU, C_SUPPLIER, C_EXAMPLE_INV = 4, 5, 6, 7
C_PACK, C_PRICE, C_BASE_UNIT = 8, 9, 10

# Same supplier, typed differently on different invoices. Left as an explicit
# list rather than fuzzy-matched: "Cater 4 You" and "Cater for you" are the same
# firm, but "Sysco" and "Brakes" are genuinely different despite Sysco owning
# Brakes, and no similarity score knows that.
SUPPLIER_CANONICAL = {
    "cater 4 you": "Cater 4 You",
    "cater for you": "Cater 4 You",
    "makro": "Makro",
    "sainsburys": "Sainsbury's",
    "asda": "ASDA",
    "b&m": "B&M",
    "m&s": "M&S",
}

# An unmistakable stand-in for a price nobody has supplied yet. See the module
# docstring for why it is not 0.00.
PLACEHOLDER_PRICE = 0.10
# Stands in for a supplier code nobody has supplied. Deliberately shouty: it
# shows up as-is on a purchase order, so it cannot be mistaken for a real code.
PLACEHOLDER_SKU = "NOSKU"

UOM_ALIASES = {"ltr": "l", "litre": "l", "litres": "l", "kgs": "kg", "gram": "g", "grams": "g"}
# Units the sheet writes that the catalogue counts differently. A whole cake is
# the thing on the shelf; a slice is how it is sold, and counting slices would
# make the stock figure drift every time one is cut.
UOM_CANONICAL = {"slice": "cake"}
# Stock units the catalogue actually uses; anything else we don't convert into.
TO_BASE = {"g": ("kg", 0.001), "ml": ("l", 0.001), "cl": ("l", 0.01)}


def norm(v):
    return "" if v is None else str(v).strip()


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")[:100]


def canonical_supplier(name):
    n = norm(name)
    return SUPPLIER_CANONICAL.get(n.lower(), n)


def parse_price(v):
    """A billed unit price. Currency symbols and thousands separators only —
    anything with words in it is left for a human."""
    s = norm(v).replace("\u00a3", "").replace(",", "").strip()
    if not s:
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return round(f, 2) if f >= 0 else None


def parse_pack(pack, stock_uom):
    """Stock units in one purchase unit, or None when it can't be known.

    Handles "1x1kg", "2 x 5ltr", "500g", "70cl". Returns None for "Box / Case",
    "Pack of 100 x 7" and friends — and None is the SAFE answer: the reorder
    engine falls back to a pack size of 1, whereas a wrong number silently
    mis-sizes every future order of that item.
    """
    s = norm(pack).lower().replace("\u00d7", "x")
    if not s:
        return None

    def conv(qty, unit):
        unit = UOM_ALIASES.get(unit, unit)
        if unit in TO_BASE:
            base, factor = TO_BASE[unit]
            return qty * factor if base == stock_uom else None
        return qty if unit == stock_uom else None

    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*([a-z]+)", s)
    if m:
        return conv(float(m.group(1)) * float(m.group(2)), m.group(3))
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([a-z]+)", s)
    if m:
        return conv(float(m.group(1)), m.group(2))
    m = re.fullmatch(r"(\d+(?:\.\d+)?)", s)
    if m and stock_uom == "each":
        return float(m.group(1))
    return None


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, "..", "data", "supplier-catalogue")
    os.makedirs(out_dir, exist_ok=True)

    # The existing catalogue, so we know which sheet SKUs are new.
    known = {}
    cat = os.path.join(here, "..", "data", "count-catalogue", "products.csv")
    with open(cat, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            known[row["sku"].strip()] = row["stock_uom"].strip() or "each"

    wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
    rows = list(wb[SHEET].iter_rows(values_only=True))[1:]

    suppliers, new_products, mappings, skipped = {}, {}, {}, []
    seen_triples = set()

    for i, r in enumerate(rows, start=2):
        def g(c):
            return norm(r[c]) if c < len(r) else ""

        main_sku = g(C_MAIN_SKU)
        if not main_sku:
            continue

        supplier = canonical_supplier(g(C_SUPPLIER))
        supplier_sku = g(C_SUPPLIER_SKU)
        price = parse_price(g(C_PRICE))

        if not supplier:
            skipped.append([i, main_sku, "", "", "no supplier"])
            continue
        sku_placeholder = not supplier_sku
        if sku_placeholder:
            supplier_sku = PLACEHOLDER_SKU
        price_placeholder = price is None
        if price_placeholder:
            price = PLACEHOLDER_PRICE

        suppliers.setdefault(supplier, slugify(supplier))

        stock_uom = known.get(main_sku)
        if stock_uom is None:
            # Priced by the sheet but never on the count list — a purchasable
            # that nobody counts (packaging, cleaning, drinks).
            stock_uom = (g(C_BASE_UNIT) or "each").lower()
            stock_uom = UOM_ALIASES.get(stock_uom, stock_uom)
            stock_uom = UOM_CANONICAL.get(stock_uom, stock_uom)
            new_products.setdefault(
                main_sku,
                [main_sku, g(C_MAIN_NAME) or main_sku, slugify(main_sku), stock_uom, g(C_CATEGORY)],
            )

        # The DB identity is (product, supplier, supplierSku); collapse repeats
        # here so the importer never fights its own unique index.
        triple = (main_sku, supplier, supplier_sku)
        if triple in seen_triples:
            continue
        seen_triples.add(triple)

        pack = parse_pack(g(C_PACK), stock_uom)
        mappings[triple] = [
            main_sku,
            supplier,
            supplier_sku,
            f"{price:.2f}",
            "" if pack is None else f"{pack:g}",
            g(C_PACK),
            "yes" if price_placeholder else "",
            "yes" if sku_placeholder else "",
            g(C_INVOICE_NAME),
        ]

    def write(name, header, body):
        path = os.path.join(out_dir, name)
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(header)
            w.writerows(body)
        return path

    write("suppliers.csv", ["name", "slug"], sorted([n, s] for n, s in suppliers.items()))
    write(
        "products-new.csv",
        ["sku", "name", "slug", "stock_uom", "category_hint"],
        sorted(new_products.values()),
    )
    write(
        "supplier-products.csv",
        [
            "sku", "supplier", "supplier_sku", "cost_gbp",
            "pack_size", "pack_size_raw", "price_is_placeholder", "sku_is_placeholder",
            "invoice_name",
        ],
        sorted(mappings.values()),
    )
    write("skipped.csv", ["row", "sku", "supplier", "supplier_sku", "reason"], skipped)

    unpriced_pack = sum(1 for m in mappings.values() if not m[4])
    placeholder_priced = sum(1 for m in mappings.values() if m[6] == "yes")
    placeholder_sku = sum(1 for m in mappings.values() if m[7] == "yes")
    report = [
        f"source            : {src}",
        f"sheet             : {SHEET}",
        f"rows read         : {len(rows)}",
        f"suppliers         : {len(suppliers)}",
        f"mappings          : {len(mappings)}",
        f"  no pack size    : {unpriced_pack}  (engine falls back to 1 — safer than a guess)",
        f"  placeholder GBP{PLACEHOLDER_PRICE:.2f} price : {placeholder_priced}  (find later: cost_gbp = {PLACEHOLDER_PRICE:.2f})",
        f"  placeholder {PLACEHOLDER_SKU} code   : {placeholder_sku}  (not orderable until filled in)",
        f"new products      : {len(new_products)}  (priced but never on the count list)",
        f"skipped rows      : {len(skipped)}",
    ]
    reasons = {}
    for s in skipped:
        reasons[s[4].split(" ")[0] + " " + s[4].split(" ")[1] if " " in s[4] else s[4]] = 0
    for s in skipped:
        k = s[4] if not s[4].startswith("unparseable") else "unparseable price"
        reasons[k] = reasons.get(k, 0) + 1
    for k, v in sorted(reasons.items(), key=lambda x: -x[1]):
        if v:
            report.append(f"    {v:5d}  {k}")
    text = "\n".join(report)
    with open(os.path.join(out_dir, "extract-report.txt"), "w", encoding="utf-8") as f:
        f.write(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
