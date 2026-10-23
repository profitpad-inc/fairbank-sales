# Fairbank Sales

Internal sales tools for Fairbank Equipment reps, served as a static site from GitHub Pages (`/docs`). It replaces the HubSpot CMS pages behind `sales.fairbankequipment.com`. All HubSpot and Eclipse (Epicor ERP) calls go through n8n workflows at `n8n.fairbankequipment.com`; the browser never talks to HubSpot or Eclipse directly.

## Pages

| Path | What it does |
|---|---|
| `docs/product-inquiry/` | Customer-specific pricing, quantity breaks and stock by branch for one product. |
| `docs/order-placement/` | New keyboard-first order entry. Open with `?e_customer_id=<Eclipse customer id>` (the HubSpot customer card link), optionally with `&e_product_ids=106331,110723&quantities=50,1` to prefill lines, pick a ship-to if needed, build the order, place it as a Bid (Alt+B, Control+B on a Mac) or an Order (Alt+O). Works on phones with a card layout. Open with `?e_sorder_id=S1234567.0001` to load an existing order: a Bid can have its lines changed (Update Bid), and any order that is not invoiced or cancelled can be cancelled. |
| `docs/order-placement/side.html` | Same order page with stock and qty breaks for every line in a box on the right, instead of in a strip under the focused line (the default `index.html` layout). |
| `docs/order-placement/details.html` | Same order page with no stock box: a Details button on each line opens its stock, qty breaks and line comment. |
| `docs/archive/order-placement-v1/` | Port of the original deal-based "Branch Fulfillment" card. Open with `?dealId=<HubSpot deal id>`. |
| `docs/outlook-integration/` | Outlook Sync admin: a dashboard of emails sent and received per user, and the sync settings (users to sync, emails and domains to exclude). Talks to the `outlook-dash` webhook. |
| `docs/index.html` | Redirects to order placement. |

Product inquiry and order placement v1 keep the HubSpot CMS module layout (a thin `index.html` loader plus `module.html`, `module.js`, `module.css`). The new order placement page is a plain web page: `index.html`, `styles.css`, `app.js`. Outlook integration is a plain web page too: `index.html`, `styles.css`, `index.js`.

## Sign-in

Every page loads `docs/auth.js`. Reps click **Sign in with HubSpot** and log in on HubSpot's own page. The n8n flow `auth-hubspot.json` checks with HubSpot that the login belongs to Fairbank's HubSpot account (43793456), reads the rep's Eclipse user ID, branch and territory from their HubSpot user, and returns a signed session token that lasts 48 hours. Every time a rep opens the site, `auth-refresh.json` renews it for another 48 hours (and re-checks the rep in HubSpot), so reps only sign in again after 48 hours away. Reps no longer type an ID or a password, and no Microsoft login is needed.

Every call to an `e-order-placement/*` webhook sends that token, and n8n refuses calls without a valid one, so the webhooks are protected on the server, not just hidden by the page.

Setup (HubSpot app, two n8n credentials, the client id in `auth.js`) is in [HANDOFF.md](HANDOFF.md), under "Going live with HubSpot sign-in". The site and the n8n flows have to go live together.

## n8n workflows

The workflow exports are in `n8n-flows/`. Import each one into n8n (Workflows → Import from file), check the credentials on the HubSpot and Eclipse nodes and the JWT credential on the Webhook node, and activate it. All the order webhooks live under `https://n8n.fairbankequipment.com/webhook/e-order-placement/`.

| File | Webhook | Used by |
|---|---|---|
| `auth-hubspot.json` | `GET auth/hubspot` | HubSpot sign-in (OAuth redirect URI) |
| `auth-refresh.json` | `GET auth/refresh` | `auth.js` (renews the session on every open) |
| `user-lookup.json` | `GET user?e_user_id=` | not used since HubSpot sign-in |
| `customer-lookup.json` | `GET customer?e_customer_id=` | order placement |
| `create-order.json` | `POST create-order` | order placement |
| `order-lookup.json` | `GET order?e_sorder_id=` | order placement (existing order, every generation) |
| `customer-orders.json` | `GET customer-orders?e_customer_id=` | order placement (Other orders) |
| `order-changelog.json` | `GET order-changelog?e_sorder_id=` | order placement (Change log) |
| `order-changelog-comment.json` | `POST order-changelog-comment` | order placement (Change log comment box) |
| `update-bid.json` | `POST update-bid` | order placement (Update Bid) |
| `cancel-order.json` | `POST cancel-order` | order placement (Cancel) |
| `pick-up-now.json` | `POST pick-up-now` | order placement (Pick Up Now: invoice and print; branch `printing-on-demand`) |
| `v1-inventory-lookup.json` | `POST v1/inventory-lookup` | order placement v1 |
| `v1-place-order.json` | `POST v1/place-order` | order placement v1 |

Customer search, product search and pricing reuse the existing `fairbank-product-inquiry` workflow, which is not stored in this repo.

The workflows use the ProfitPad custom HubSpot and Eclipse nodes, registered on this n8n instance as `CUSTOM.hubspotApi` and `CUSTOM.eclipseApi` (operations and parameters are described in `n8n-flows/hs_n8n_node.md` and `n8n-flows/eclipse_n8n_node.md`).

## Local development

Serve `docs/` with any static server, for example:

```bash
python3 -m http.server 8000 --directory docs
```

Then open `http://localhost:8000/order-placement/`. Sign-in sends you back to localhost after HubSpot, so the sign-in flow must be live in n8n for local testing.

## Going live on sales.fairbankequipment.com

1. Set up HubSpot sign-in (see HANDOFF.md), import and activate the n8n workflows, then test them on a throwaway order.
2. Point the `sales.fairbankequipment.com` DNS record at GitHub Pages and set the custom domain in the repo's Pages settings.
3. Update the HubSpot customer card link to `https://sales.fairbankequipment.com/order-placement/?e_customer_id={{e_customer_id}}`.

See [HANDOFF.md](HANDOFF.md) for architecture details, payloads, and open items.
