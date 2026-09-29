# pos-price-api

Live, paginated, searchable read API over `lucirajewelry-prod.Pos.Product_price`
(~368K rows / ~99MB -- too large to embed as a static JS snapshot).

Backs the "Product Price" tab in `dashboard/product-pricing-intelligence.html`.

## Endpoint

```
GET /?q=<search>&page=<n>&pageSize=<n>
```

- `q` -- optional, case-insensitive substring match across every column.
- `page` -- 1-based (default 1).
- `pageSize` -- default 50, max 500.

Response:

```json
{
  "rows": [...],
  "total": 368063,
  "page": 1,
  "pageSize": 50,
  "columns": ["item_code", "item_name", ...],
  "q": "",
  "generated_at": "...",
  "elapsed_sec": 0.4
}
```

## Deploy

```bash
./deploy.sh
```

Requires `gcloud auth login` + `gcloud auth application-default login` on the
`tech@lucirajewelry.com` account (or equivalent) with BigQuery Data Viewer and
Cloud Functions/Run Admin. Prints the deployed URL -- wire it into
`dashboard/ppi.js` as `CONFIG.PP_API_URL`.
