# merchant-feed

Google Merchant Center product feed for **The Strong Kitchen** (thestrongkitchen.com).

* `build_merchant_feed.py` scrapes this week's live menu (meals / sides / snacks / sauces) and writes
  `docs/products.tsv` (Merchant Center tab-delimited format) + `docs/feed_report.md`.
* A GitHub Action rebuilds it **daily at 6 AM ET** and commits only if something changed.
* GitHub Pages serves `docs/` -> feed URL: **https://thestrongkitchen.github.io/merchant-feed/products.tsv**
  (set this as a *scheduled fetch* data source in Merchant Center).

Operational notes live in `1 - Claude Code\TSK Merchant Center\SETUP-GUIDE.md` on Luke's PC.
