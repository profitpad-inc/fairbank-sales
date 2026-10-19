# Fairbank Sales

Internal sales tools for Fairbank Equipment reps, served as a static site from GitHub Pages (`/docs`). It replaces the HubSpot CMS pages behind `sales.fairbankequipment.com`. All HubSpot and Eclipse (Epicor ERP) calls go through n8n workflows at `n8n.fairbankequipment.com`; the browser never talks to HubSpot or Eclipse directly.

## Pages

| Path | What it does |
|---|---|
| `docs/product-inquiry/` | Customer-specific pricing, quantity breaks and stock by branch for one product. |
| `docs/order-placement/` | New keyboard-first order entry. Open with `?e_customer_id=<Eclipse customer id>` (the HubSpot customer card link), optionally with `&e_product_ids=106331,110723&quantities=50,1` to prefill lines, pick a ship-to if needed, build the order, place it as a Bid (Alt+B, Control+B on a Mac) or an Order (Alt+O). Works on phones with a card layout. Open with `?e_sorder_id=S1234567.0001` to load an existing order: a Bid can have its lines changed (Update Bid), and any order that is not invoiced or cancelled can be cancelled. |
| `docs/order-placement/inline.html` | Same order page with stock, qty breaks and a line comment in a strip under the focused line instead of in the box on the right (the default `index.html` layout). |
| `docs/order-placement/details.html` | Same order page with no stock box: a Details button on each line opens its stock, qty breaks and line comment. |
| `docs/archive/order-placement-v1/` | Port of the original deal-based "Branch Fulfillment" card. Open with `?dealId=<HubSpot deal id>`. |
| `docs/index.html` | Redirects to product inquiry. |

Product inquiry and order placement v1 keep the HubSpot CMS module layout (a thin `index.html` loader plus `module.html`, `module.js`, `module.css`). The new order placement page is a plain web page: `index.html`, `styles.css`, `app.js`.

## Sign-in

Every page loads `docs/auth.js`, a temporary browser-only password gate. Reps enter the shared password and their Eclipse user ID (`e_user_id`). The ID is looked up in HubSpot to get the rep's name, default branch and territory, and it is remembered in the browser. Microsoft login will replace this file later.

The gate hides the pages, but it does not secure the n8n webhooks. To change the password, put the SHA-256 hex of the new password into `PASSWORD_HASH` in `docs/auth.js`:

```bash
node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" 'new-password'
```

## n8n workflows

The workflow exports are in `n8n-flows/`. Import each one into n8n (Workflows → Import from file), check the credentials on the HubSpot and Eclipse nodes, and activate it. All the order webhooks live under `https://n8n.fairbankequipment.com/webhook/e-order-placement/`.

| File | Webhook | Used by |
|---|---|---|
| `user-lookup.json` | `GET user?e_user_id=` | `auth.js` |
| `customer-lookup.json` | `GET customer?e_customer_id=` | order placement |
| `create-order.json` | `POST create-order` | order placement |
| `order-lookup.json` | `GET order?e_sorder_id=` | order placement (existing order, every generation) |
| `customer-orders.json` | `GET customer-orders?e_customer_id=` | order placement (Other orders) |
| `order-changelog.json` | `GET order-changelog?e_sorder_id=` | order placement (Change log) |
| `update-bid.json` | `POST update-bid` | order placement (Update Bid) |
| `cancel-order.json` | `POST cancel-order` | order placement (Cancel) |
| `v1-inventory-lookup.json` | `POST v1/inventory-lookup` | order placement v1 |
| `v1-place-order.json` | `POST v1/place-order` | order placement v1 |

Customer search, product search and pricing reuse the existing `fairbank-product-inquiry` workflow, which is not stored in this repo.

The workflows use the ProfitPad custom HubSpot and Eclipse nodes, registered on this n8n instance as `CUSTOM.hubspotApi` and `CUSTOM.eclipseApi` (operations and parameters are described in `n8n-flows/hs_n8n_node.md` and `n8n-flows/eclipse_n8n_node.md`).

## Local development

Serve `docs/` with any static server, for example:

```bash
python3 -m http.server 8000 --directory docs
```

Then open `http://localhost:8000/order-placement/`. The page needs a secure context (https or localhost) for the password check.

## Going live on sales.fairbankequipment.com

1. Import and activate the n8n workflows, then test them on a throwaway order.
2. Point the `sales.fairbankequipment.com` DNS record at GitHub Pages and set the custom domain in the repo's Pages settings.
3. Update the HubSpot customer card link to `https://sales.fairbankequipment.com/order-placement/?e_customer_id={{e_customer_id}}`.

See [HANDOFF.md](HANDOFF.md) for architecture details, payloads, and open items.
