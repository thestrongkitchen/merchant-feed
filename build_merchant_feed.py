#!/usr/bin/env python3
"""
The Strong Kitchen — Google Merchant Center product feed generator.

Reads the LIVE thestrongkitchen.com menu pages (this week's Meals / Sides / Snacks,
plus any sauce shown on /menus), opens every product page, and writes a
tab-delimited Google Merchant Center feed (products.tsv) + a human-readable
report (feed_report.md).

Stdlib only — no pip installs needed (works on the bare Python 3.14 on Luke's PC
and inside the GitHub Actions runner).

Usage:
    python build_merchant_feed.py                 # writes ./products.tsv + ./feed_report.md
    python build_merchant_feed.py --out docs      # write into a folder (used by the GitHub Pages repo)

Design notes (see SETUP-GUIDE.md):
  * One feed row per purchasable option (Fat Loss / Performance / Protein Plus,
    or "Six Pack", "16oz" ...). item id = "<product_id>-<productoption_id>",
    item_group_id = product_id so Google groups the plans as variants.
  * Items are "in stock" simply by being on this week's menu; when the menu
    rotates they drop out of the feed and Google expires them. The id is stable,
    so when a meal comes back in the 8-week rotation its history carries over.
  * Items with NO real photo (site falls back to a generic category banner) are
    skipped — Google disapproves placeholder images — and listed in the report.
  * Shipping / minimum-order / service area are NOT in the feed on purpose: they
    are configured once in Merchant Center (CT-only delivery, $10, $50 min).
"""

from __future__ import annotations

import argparse
import csv
import html
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://thestrongkitchen.com"
MENU_PAGES = {
    # product_type label        : listing URL
    "Meals > Complete Meals":   f"{BASE}/menus/complete-meals",
    "Sides":                    f"{BASE}/menus/individual-sides",
    "Snacks & Breakfast":       f"{BASE}/menus/on-the-go-options",
    # /menus (all categories) also lists sauces that have no category page
    "_all":                     f"{BASE}/menus",
}
BRAND = "The Strong Kitchen"
UA = "Mozilla/5.0 (compatible; TSK-MerchantFeed/1.0; +https://thestrongkitchen.com)"
PLACEHOLDER_IMAGE_HINTS = ("category-hero-default", "/images/storefront/")

# Google product taxonomy (full-path strings are accepted by Merchant Center)
GPC_PREPARED = "Food, Beverages & Tobacco > Food Items > Prepared Foods"
GPC_SAUCE = "Food, Beverages & Tobacco > Food Items > Condiments & Sauces"
GPC_SNACK = "Food, Beverages & Tobacco > Food Items > Snack Foods"
GPC_CEREAL = "Food, Beverages & Tobacco > Food Items > Grains, Rice & Cereal > Cereal & Granola"


# --------------------------------------------------------------------------- http
def fetch(url: str, retries: int = 3) -> str:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"fetch failed for {url}: {last}")


# --------------------------------------------------------------------------- parsing helpers
def clean(s: str) -> str:
    s = html.unescape(re.sub(r"<[^>]+>", " ", s))
    return re.sub(r"\s+", " ", s).strip()


def find_product_ids(listing_html: str) -> list[int]:
    ids = re.findall(r'data-product-card-id="(\d+)"', listing_html)
    seen, out = set(), []
    for i in ids:
        if i not in seen:
            seen.add(i)
            out.append(int(i))
    return out


def menu_week(listing_html: str) -> str:
    m = re.search(r'<meta name="sk-menu-week" content="([^"]*)"', listing_html)
    return m.group(1) if m else ""


def fulfillment_line(listing_html: str) -> str:
    m = re.search(r'sk-alert__title">\s*([^<]+?)\s*<', listing_html)
    return clean(m.group(1)) if m else ""



def fulfillment_dates(fulfill: str, today=None):
    """Turn the site's 'Order now for fulfillment on Sunday, September 13th, Monday, September 14th'
    into {'delivery': 'Sunday, September 13th or Monday, September 14th',
          'deadline': 'Wednesday, September 9th'} (deadline = the Wednesday before the first date).
    Returns empty strings if the line can't be parsed, so the email falls back to generic copy."""
    import datetime as _dt
    today = today or _dt.date.today()
    found = re.findall(r"(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),\s+([A-Z][a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?", fulfill or "")
    if not found:
        return {"delivery": "", "deadline": ""}
    def ordinal(n): return f"{n}{'th' if 11<=n%100<=13 else {1:'st',2:'nd',3:'rd'}.get(n%10,'th')}"
    days = [f"{d}, {m} {ordinal(int(n))}" for d, m, n in found]
    try:
        m0, n0 = found[0][1], int(found[0][2])
        year = today.year
        first = _dt.datetime.strptime(f"{m0} {n0} {year}", "%B %d %Y").date()
        if first < today - _dt.timedelta(days=60):   # Dec build, Jan fulfillment
            first = first.replace(year=year + 1)
        back = (first.weekday() - 2) % 7 or 7          # Wednesday=2; strictly before
        wed = first - _dt.timedelta(days=back)
        deadline = f"Wednesday, {wed.strftime('%B')} {ordinal(wed.day)}"
    except Exception:  # noqa: BLE001
        deadline = ""
    return {"delivery": " or ".join(days), "deadline": deadline}

def parse_product(pid: int, page: str) -> dict:
    """Return dict with title, description, badges, ingredients, image, options[]"""
    title = clean(re.search(r'<h1 class="sk-product-detail__title">(.*?)</h1>', page, re.S).group(1))
    m = re.search(r'<p class="sk-product-detail__description">(.*?)</p>', page, re.S)
    description = clean(m.group(1)) if m else ""
    # badges inside the detail block only (first 'flex gap-2 mb-4' after the title)
    badges = []
    m = re.search(r'sk-product-detail__description.*?<div class="flex gap-2 mb-4">(.*?)</div>\s*<div class="mb-6">', page, re.S)
    if m:
        badges = [clean(b) for b in re.findall(r'sk-badge--md">(.*?)</span>', m.group(1), re.S)]
    m = re.search(r'<span>Ingredients</span>.*?sk-accordion__body">\s*<p>(.*?)</p>', page, re.S)
    ingredients = clean(m.group(1)) if m else ""
    ingredients = re.sub(r"^Ingredients:\s*", "", ingredients, flags=re.I)
    m = re.search(r'<meta property="og:image" content="([^"]+)"', page)
    image = m.group(1) if m else ""
    # prefer the full-size (non-"conversions") featured image if present
    m2 = re.search(r'href="(https://thestrongkitchen\.com/uploads/media/products/%d/featured-image/[^"]+)"' % pid, page)
    if m2:
        image = m2.group(1)

    options = []
    blocks = re.split(r'<div class="border border-gray-200 rounded-lg p-4">', page)[1:]
    for blk in blocks:
        names = re.findall(r'<span class="font-medium text-gray-900">(.*?)</span>', blk, re.S)
        if len(names) < 2:
            continue
        opt_name, price_txt = clean(names[0]), clean(names[1])
        pm = re.search(r"\$([\d.]+)", price_txt)
        if not pm:
            continue
        cal = re.search(r'ml-2">\s*(\d+)\s*cal', blk)
        protein = re.search(r"(\d+)g protein", blk)
        carbs = re.search(r"(\d+)g carbs", blk)
        fat = re.search(r"(\d+)g fat", blk)
        oid = re.search(r'name="productoption_id" value="(\d+)"', blk)
        options.append({
            "option_id": oid.group(1) if oid else "",
            "name": opt_name,
            "price": float(pm.group(1)),
            "cal": cal.group(1) if cal else "",
            "protein": protein.group(1) if protein else "",
            "carbs": carbs.group(1) if carbs else "",
            "fat": fat.group(1) if fat else "",
        })
    return {
        "id": pid, "title": title, "description": description, "badges": badges,
        "ingredients": ingredients, "image": image, "options": options,
        "url": f"{BASE}/products/{pid}",
    }


# --------------------------------------------------------------------------- feed rows
PLAN_NAMES = {"Fat Loss", "Performance", "Protein Plus"}


def classify(product_type: str, title: str, desc: str) -> tuple[str, str]:
    """Return (google_product_category, product_type) for a product."""
    t = (title + " " + desc).lower()
    if "sauce" in title.lower():
        return GPC_SAUCE, "Sauces"
    if product_type.startswith("Meals"):
        return GPC_PREPARED, product_type
    if product_type == "Sides":
        return GPC_PREPARED, "Sides"
    if "oatmeal" in t and "cookie" not in t:
        return GPC_CEREAL, "Snacks & Breakfast > Protein Oatmeal"
    if "burrito" in t:
        return GPC_PREPARED, "Snacks & Breakfast > Breakfast & Burritos"
    return GPC_SNACK, "Snacks & Breakfast"


def make_title(p: dict, opt: dict, ptype: str) -> str:
    base = p["title"]
    if opt["name"] in PLAN_NAMES:
        t = f"{base} - {opt['name']} Meal"
        if opt["cal"]:
            t += f" ({opt['cal']} cal"
            if opt["protein"]:
                t += f", {opt['protein']}g protein"
            t += ")"
        return t[:150]
    if ptype == "Sauces":
        return f"{base} - {opt['name']} Bottle"[:150] if opt["name"] else base[:150]
    if opt["name"] and opt["name"].lower() not in ("side",):
        return f"{base} - {opt['name']}"[:150]
    return base[:150]


def make_description(p: dict, opt: dict, ptype: str, fulfill: str) -> str:
    parts = []
    if p["description"]:
        d = p["description"]
        if d.lower().startswith("with "):
            d = f"{p['title']} {d}"
        parts.append(d.rstrip(".") + ".")
    if opt["name"] in PLAN_NAMES:
        macro = []
        if opt["cal"]:
            macro.append(f"{opt['cal']} calories")
        if opt["protein"]:
            macro.append(f"{opt['protein']}g protein")
        if opt["carbs"]:
            macro.append(f"{opt['carbs']}g carbs")
        if opt["fat"]:
            macro.append(f"{opt['fat']}g fat")
        plan_blurb = {
            "Fat Loss": "Fat Loss portion (lighter carbs)",
            "Performance": "Performance portion (balanced)",
            "Protein Plus": "Protein Plus portion (extra protein)",
        }[opt["name"]]
        parts.append(f"{plan_blurb}: " + ", ".join(macro) + ".")
    if p["badges"]:
        parts.append(" • ".join(p["badges"]) + ".")
    if ptype.startswith("Meals") or ptype == "Sides":
        parts.append("Fresh, chef-made meal prep from The Strong Kitchen in Hamden, CT — fully cooked, "
                     "just heat and eat. Delivered Sunday/Monday across Connecticut or pick up in Hamden.")
    elif ptype == "Sauces":
        parts.append("Made in-house by The Strong Kitchen, Hamden, CT. Delivered with your meal prep order "
                     "across Connecticut or pick up in Hamden.")
    else:
        parts.append("Made fresh by The Strong Kitchen in Hamden, CT. Delivered Sunday/Monday across "
                     "Connecticut with your order or pick up in Hamden.")
    if p["ingredients"]:
        parts.append("Ingredients: " + p["ingredients"] + ".")
    desc = " ".join(parts)
    return desc[:5000]


def build(out_dir: Path) -> int:
    t0 = datetime.now(timezone.utc)
    listings = {k: fetch(v) for k, v in MENU_PAGES.items()}
    week = menu_week(listings["_all"])
    fulfill = fulfillment_line(listings["_all"])

    # product_id -> product_type (first category wins; sauces on /menus only)
    pid_type: dict[int, str] = {}
    for ptype, page in listings.items():
        if ptype == "_all":
            continue
        for pid in find_product_ids(page):
            pid_type.setdefault(pid, ptype)
    for pid in find_product_ids(listings["_all"]):
        pid_type.setdefault(pid, "Other")   # sauces etc.

    rows, skipped, report_items = [], [], []
    for pid, ptype in pid_type.items():
        try:
            p = parse_product(pid, fetch(f"{BASE}/products/{pid}"))
        except Exception as e:  # noqa: BLE001
            skipped.append((pid, "?", f"parse error: {e}"))
            continue
        gpc, ptype2 = classify(ptype, p["title"], p["description"])
        if not p["image"] or any(h in p["image"] for h in PLACEHOLDER_IMAGE_HINTS):
            skipped.append((pid, p["title"], "no real product photo (site shows a generic banner)"))
            continue
        if not p["options"]:
            skipped.append((pid, p["title"], "no purchasable option/price found"))
            continue
        multi = len(p["options"]) > 1
        for opt in p["options"]:
            item_id = f"{pid}-{opt['option_id']}" if opt["option_id"] else f"{pid}"
            row = {
                "id": item_id,
                "item_group_id": str(pid) if multi else "",
                "title": make_title(p, opt, ptype2),
                "description": make_description(p, opt, ptype2, fulfill),
                "link": p["url"],
                "image_link": p["image"],
                "price": f"{opt['price']:.2f} USD",
                "availability": "in_stock",
                "condition": "new",
                "brand": BRAND,
                "identifier_exists": "no",
                "google_product_category": gpc,
                "product_type": ptype2,
                "adult": "no",
                "custom_label_0": ptype2.split(" > ")[0],
                "custom_label_1": opt["name"] if opt["name"] in PLAN_NAMES else "",
                "custom_label_2": f"menu-week-{week}" if week else "",
            }
            rows.append(row)
        report_items.append((pid, p["title"], ptype2, len(p["options"]),
                             ", ".join(f"{o['name']} ${o['price']:.2f}" for o in p["options"])))

    out_dir.mkdir(parents=True, exist_ok=True)
    cols = ["id", "item_group_id", "title", "description", "link", "image_link", "price",
            "availability", "condition", "brand", "identifier_exists", "google_product_category",
            "product_type", "adult", "custom_label_0", "custom_label_1", "custom_label_2"]
    with (out_dir / "products.tsv").open("w", newline="", encoding="utf-8") as f:
        # Merchant Center TSV: no quoting; make sure no field contains a tab/newline
        w = csv.DictWriter(f, fieldnames=cols, delimiter="\t", quoting=csv.QUOTE_NONE,
                           escapechar="\\", lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow({k: re.sub(r"[\t\r\n\\]+", " ", v) for k, v in r.items()})


    # --- Klaviyo custom-catalog feed (flat XML, one node deep) ---------------
    # Same rows as the TSV. Klaviyo wants: id, title, link, description, price
    # (numeric, no currency), image_link, categories (comma list). We fold the
    # portion plan + menu week into categories so an email can filter on them.
    from xml.sax.saxutils import escape as _x
    xml_lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<Products>"]
    for r in rows:
        cats = [c for c in (r["custom_label_0"], r["product_type"], r["custom_label_1"],
                            r["custom_label_2"]) if c]
        xml_lines += [
            "  <Product>",
            f"    <id>{_x(r['id'])}</id>",
            f"    <title>{_x(r['title'])}</title>",
            f"    <link>{_x(r['link'])}</link>",
            f"    <description>{_x(r['description'])}</description>",
            f"    <price>{_x(r['price'].replace(' USD', ''))}</price>",
            f"    <image_link>{_x(r['image_link'])}</image_link>",
            f"    <categories>{_x(','.join(dict.fromkeys(cats)))}</categories>",
            f"    <inventory_quantity>100</inventory_quantity>",
            f"    <inventory_policy>1</inventory_policy>",
            "  </Product>",
        ]
    xml_lines.append("</Products>")
    (out_dir / "products.xml").write_text("\n".join(xml_lines) + "\n", encoding="utf-8")

    # --- same rows as JSON: Klaviyo web feeds loop `feeds.NAME.items` --------
    import json as _json
    items = []
    for r in rows:
        cats = [c for c in (r["custom_label_0"], r["product_type"], r["custom_label_1"],
                            r["custom_label_2"]) if c]
        items.append({
            "id": r["id"], "group": r["item_group_id"] or r["id"].split("-")[0],
            "title": r["title"], "name": r["title"].split(" - ")[0],
            "portion": r["custom_label_1"], "type": r["custom_label_0"],
            "link": r["link"], "image_link": r["image_link"],
            "price": r["price"].replace(" USD", ""),
            "description": r["description"],
            "categories": list(dict.fromkeys(cats)), "week": week or "",
        })
    # One entry per dish for the weekly email: the Performance row (baseline portion),
    # meals only; everything else (snacks, sauces, breakfast) goes in `extras`.
    # Prefer the Performance row (baseline portion); fall back to the first row of
    # the group so single-option or differently-named dishes still show up.
    by_group: dict = {}
    for it in items:
        cur = by_group.get(it["group"])
        if cur is None or (it["portion"] == "Performance" and cur["portion"] != "Performance"):
            by_group[it["group"]] = it
    meals  = [it for it in by_group.values() if it["type"] == "Meals"]
    extras = [it for it in by_group.values() if it["type"] != "Meals"]
    fd = fulfillment_dates(fulfill)
    post_url = ""
    m = re.search(r"([A-Z][a-z]+) (\d{1,2})(?:st|nd|rd|th)?", fd.get("delivery", ""))
    if m:
        post_url = f"{BASE}/blog/post/whats-on-the-menu-new-haven-county-{m.group(1).lower()}-{int(m.group(2))}"
    (out_dir / "products.json").write_text(
        _json.dumps({"week": week or "", "fulfillment": fulfill, **fd, "post_url": post_url,
                     "items": items, "meals": meals, "extras": extras},
                    ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8")

    stamp = t0.strftime("%Y-%m-%d %H:%M UTC")
    lines = [f"# TSK Merchant Center feed — build report", "",
             f"Built: {stamp}  ·  Menu week: {week or '?'}  ·  {fulfill}", "",
             f"**{len(rows)} feed rows** from **{len(report_items)} products**; {len(skipped)} skipped.", "",
             "| Product | Type | Options |", "|---|---|---|"]
    for pid, title, ptype2, n, opts in report_items:
        lines.append(f"| [{title}]({BASE}/products/{pid}) | {ptype2} | {opts} |")
    if skipped:
        lines += ["", "## Skipped (fix on the site, then they'll flow in automatically)", "",
                  "| Product | Reason |", "|---|---|"]
        for pid, title, why in skipped:
            lines.append(f"| [{title}]({BASE}/products/{pid}) | {why} |")
    (out_dir / "feed_report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {out_dir/'products.tsv'} + products.xml: {len(rows)} rows, {len(report_items)} products, "
          f"{len(skipped)} skipped (week {week})")
    for pid, title, why in skipped:
        print(f"  skipped {pid} {title}: {why}")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=".", help="output folder")
    a = ap.parse_args()
    sys.exit(build(Path(a.out)))
