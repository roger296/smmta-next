#!/usr/bin/env python3
"""
Turn BumbleBee's analysed supplier invoices into an importable supplier list.

    python apps/api/scripts/extract-invoice-suppliers.py [export.json]

Rebecca's workbook (see extract-supplier-catalogue.py) named 29 suppliers.
BumbleBee has actually paid 86 of them for stock — the workbook is the list
someone sat down and wrote out, this is the list the bank statement proves.
The 57 it never mentioned account for GBP119,709 of stock spend, so a purchase
order raised today has no supplier to raise it against for roughly a fifth of
what Big Bakes buys.

INPUT is a saved response from the BumbleBee MCP tool
`bumblebee_invoice_suppliers(category="stock")`, committed alongside this
script as bumblebee-invoice-suppliers.json so the extract is reproducible
without a BumbleBee API key. Re-run the tool and overwrite that file to
refresh.

WHAT THIS DOES NOT GIVE YOU. An invoice proves a supplier exists, what was
bought and what it cost. It says nothing about how to place an order with
them: no email, no account number, no lead time, no credit terms. Every
supplier this creates therefore arrives NOT ORDERABLE, and the importer
prints them ranked by spend so the gap is a work list rather than a surprise
at the point someone tries to send a PO.

Writes to apps/api/data/invoice-suppliers/:
    suppliers.csv         the ones to import
    suppliers-review.csv  the long tail, held back, with the reason
    extract-report.txt    the counts, so a re-run can be diffed
"""
import csv, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "data", "invoice-suppliers")
DEFAULT_SRC = os.path.join(OUT_DIR, "bumblebee-invoice-suppliers.json")
# The catalogue extract's supplier list — used only to mark which names the
# purchasing side already knew, so the report can separate "new" from "seen".
CATALOGUE_SUPPLIERS = os.path.join(HERE, "..", "data", "supplier-catalogue", "suppliers.csv")

# Same firm, typed differently by whoever keyed the invoice. Explicit, not
# fuzzy-matched — for the reason the catalogue extractor gives: "Cater 4 You"
# and "Cater for you" are one firm, but "Sysco" and "Brakes" are two despite
# Sysco owning Brakes, and no similarity score knows the difference.
#
# Where a name already appears in the catalogue export, the CATALOGUE spelling
# wins. The importer matches suppliers by name, so a different spelling here
# would create a second row for a supplier that already exists.
SUPPLIER_CANONICAL = {
    "cater 4 you": "Cater 4 You",
    "cater for you": "Cater 4 You",
    "makro": "Makro",
    "sainsburys": "Sainsbury's",
    # A till-receipt store code, not a separate business.
    "sainsbury's - sainsbury's - s2029": "Sainsbury's",
    "asda": "ASDA",
    "b&m": "B&M",
    "m&s": "M&S",
    # Catalogue spells it closed-up; the invoices do both.
    "j m posner": "JMPosner",
    "jmposner": "JMPosner",
    "cupsdirect.co.uk": "Cups Direct Catering Supplies",
    "the drink supermarket team": "Drink Supermarket",
    # Lower-cased on the invoices; a supplier name is a proper noun.
    "rainbow dust": "Rainbow Dust",
    "classeq": "Classeq",
    "archer": "Archer",
    "craft company": "Craft Company",
    "ebay": "eBay",
}

# Names that look like they might be the same firm but are NOT merged, because
# being wrong here silently splits or fuses a spend history. Reported instead,
# for a human to decide.
POSSIBLE_DUPLICATES = [
    ("Cake Decorating", "The Cake Decorating Co"),
    ("Cake Decorating", "Cake Craft Group"),
    ("Drinkstuff", "Drink Supermarket"),
]

# A supplier worth a row in the dropdown. Deliberately a VOLUME test, not a
# judgement about which businesses are "really" suppliers: one big invoice is a
# real supplier (SP Colour Mill, GBP12,723 on a single invoice), and so is a
# corner shop used ten times for emergency milk. Everything under both bars is
# held back for review rather than dropped, because a 90-row dropdown of which
# 14 are one-off coffees is worse than a 72-row one.
MIN_SPEND = 100.0
MIN_INVOICES = 3


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")[:100]


def canonical_supplier(name):
    n = (name or "").strip()
    return SUPPLIER_CANONICAL.get(n.lower(), n)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    with open(src, encoding="utf-8") as fh:
        payload = json.load(fh)
    rows = payload["rows"] if isinstance(payload, dict) else payload

    known = set()
    if os.path.exists(CATALOGUE_SUPPLIERS):
        with open(CATALOGUE_SUPPLIERS, encoding="utf-8-sig") as fh:
            known = {r["name"] for r in csv.DictReader(fh)}

    agg = {}
    for r in rows:
        name = canonical_supplier(r["supplier"])
        if not name:
            continue
        a = agg.setdefault(
            name, {"name": name, "invoice_count": 0, "spend": 0.0, "aliases": set()}
        )
        a["invoice_count"] += int(r.get("invoice_count") or 0)
        a["spend"] += float(r.get("spend") or 0)
        raw = (r["supplier"] or "").strip()
        if raw != name:
            a["aliases"].add(raw)

    keep, review = [], []
    for a in sorted(agg.values(), key=lambda a: -a["spend"]):
        record = [
            a["name"],
            slugify(a["name"]),
            "Stock",
            "; ".join(sorted(a["aliases"])),
            str(a["invoice_count"]),
            f"{a['spend']:.2f}",
            "yes" if a["name"] in known else "no",
        ]
        # Anything purchasing already listed comes through whatever its spend —
        # the row exists in Auto-Stock already, so importing it is a no-op that
        # only fills in the blanks, and holding it back would misreport it as
        # unknown.
        if a["name"] in known or a["spend"] >= MIN_SPEND or a["invoice_count"] >= MIN_INVOICES:
            keep.append(record)
        else:
            review.append(
                record
                + [f"under GBP{MIN_SPEND:.0f} and fewer than {MIN_INVOICES} invoices"]
            )

    header = [
        "name", "slug", "type", "aliases", "invoice_count", "spend_gbp", "in_catalogue",
    ]
    os.makedirs(OUT_DIR, exist_ok=True)

    def write(fname, hdr, body):
        with open(os.path.join(OUT_DIR, fname), "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh, lineterminator="\n")
            w.writerow(hdr)
            w.writerows(body)

    write("suppliers.csv", header, keep)
    write("suppliers-review.csv", header + ["reason"], review)

    new = [r for r in keep if r[6] == "no"]
    report = [
        f"source            : {os.path.basename(src)}",
        f"invoice rows      : {len(rows)}",
        f"after merging     : {len(agg)} suppliers",
        f"  already listed  : {sum(1 for r in keep if r[6] == 'yes')}",
        f"  new             : {len(new)}  (GBP{sum(float(r[5]) for r in new):,.2f} of stock spend)",
        f"  held for review : {len(review)}  (see suppliers-review.csv)",
        "",
        "None of these can be ordered from yet — an invoice carries no email,",
        "lead time or credit terms. The importer lists them by spend.",
        "",
        "Possible duplicates NOT merged (decide by hand):",
    ] + [f"  {a}  vs  {b}" for a, b in POSSIBLE_DUPLICATES]
    text = "\n".join(report) + "\n"
    with open(os.path.join(OUT_DIR, "extract-report.txt"), "w", encoding="utf-8") as fh:
        fh.write(text)
    print(text, end="")


if __name__ == "__main__":
    main()
