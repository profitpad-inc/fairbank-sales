# HANDOFF.md

Project handoff for the Fairbank sales site. Keep this file current: every change to a page, flow, endpoint, payload, or open question gets reflected here in the same session (see AGENTS.md).

Last updated: 2026-10-17.

## What this is

A static GitHub Pages site (`/docs`) that replaces the HubSpot CMS pages on `sales.fairbankequipment.com`. Reps use it for product inquiry (pricing and stock) and order placement. Every HubSpot and Eclipse call goes through n8n webhooks on `n8n.fairbankequipment.com`. The original HubSpot app (deal-based CRM card plus two serverless functions) is symlinked at `eclipse-branch-selector/` for reference only. It is read-only.

## Layout

```
docs/
  index.html                      redirect to product-inquiry
  auth.js                         temporary password gate (all pages)
  favicon.png
  product-inquiry/                existing page (do not edit beyond the auth.js line)
  order-placement/                new keyboard-first order entry (plain page: index.html, styles.css, app.js)
                                  index.html = side-panel layout (default); inline.html = same app, strips under each line
  archive/order-placement-v1/     port of the deal-based Branch Fulfillment card
n8n-flows/
  user-lookup.json                GET  e-order-placement/user
  customer-lookup.json            GET  e-order-placement/customer
  create-order.json               POST e-order-placement/create-order
  order-lookup.json               GET  e-order-placement/order
  customer-orders.json            GET  e-order-placement/customer-orders
  order-changelog.json            GET  e-order-placement/order-changelog
  update-bid.json                 POST e-order-placement/update-bid
  cancel-order.json               POST e-order-placement/cancel-order
  v1-inventory-lookup.json        POST e-order-placement/v1/inventory-lookup
  v1-place-order.json             POST e-order-placement/v1/place-order
  eclipse_n8n_node.md, hs_n8n_node.md   custom node references
```

`product-inquiry` and `archive/order-placement-v1` use the HubSpot-module layout: an `index.html` loader fetches `module.html`, strips HubSpot template tags, then loads `module.js`, with styles in `module.css`. The `hide-header` snippet hides their "LocalHost" header on `profitpad-inc.github.io`.

`order-placement` is a normal web page: `index.html` holds the markup and loads `../auth.js`, `styles.css`, and `app.js` (deferred, mounts on `#app`). Do not convert it to the module layout.

Style: navy and gold palette, Barlow and Barlow Condensed fonts. The colour tokens match `product-inquiry/module.css` (`--navy #0e2245`, `--gold #c8962a`, and so on).

`order-placement` readability rules (2026-10-17):
- Gold is reserved for the primary button (Place Order), focus and active states (focused row bar, input focus, active qty tier, ship branch chip, active side-panel line, edited price), the order total and the price level badge. Card, grid, side panel, action bar and secondary button borders use `--steel` (`--border` points at it). Section titles, the page kicker and the header caret are muted blue-gray. Secondary (ghost) buttons are steel outlined with light text and turn gold on hover. Customer id badges are neutral.
- Caps (Barlow Condensed, letter-spaced) only for section titles (Bill to, Ship to, Header, Stock & qty breaks) and grid column headers. Secondary labels (header form labels, Credit limit, Home branch, Stock (n), Qty breaks) are sentence case, 13px, muted.
- Numbers use `tabular-nums` (grid, side panel, action bar, credit limit, confirm table). On desktop the product, qty and unit price cells drop their padding and the grid inputs use 7px side padding (plus 1px border), so input text sits 8px from the cell edge like the plain cells and column headers, and digits line up down each column.

## Sign-in (`docs/auth.js`)

- Loaded synchronously in `<head>` of every page. The script path is relative: `auth.js`, `../auth.js` or `../../auth.js`.
- When locked, it adds `html.fb-locked`, hides every `body` child, and shows a form asking for the Eclipse user ID and the password.
- The password is checked as SHA-256 against `PASSWORD_HASH`. **The current hash is for the placeholder password `fairbank`. Change it before going live.**
- On success it calls `GET e-order-placement/user?e_user_id=`. It then stores `fb_user` (the response), `fb_auth` (the hash) and `fb_e_user_id` (remembered for next time) in localStorage. Changing the hash signs everyone out.
- It exposes `window.FB_USER` and `window.fbSignOut()`, fires a `fb:auth` event on sign-in, and shows a "name · ID · Sign out" chip top-right.
- This is browser-only. The webhooks are public and unauthenticated. Microsoft login will replace this file.

## n8n flows

General rules:
- Webhook nodes use `responseMode: responseNode` with CORS `allowedOrigins: *`. This can be tightened to `https://profitpad-inc.github.io,https://sales.fairbankequipment.com` once local testing is done.
- Every path ends in a single `Respond` node that sends `$json.body` with status `$json.statusCode`. Each gate Code node emits `{ ok, statusCode, body }`; IF nodes route `ok: false` straight to `Respond`.
- HubSpot and Eclipse nodes run with `onError: continueRegularOutput`. The Code node after each one checks for `json.error`.
- Node types are `CUSTOM.hubspotApi` and `CUSTOM.eclipseApi` (typeVersion 1). This is how the n8n instance registers the custom nodes; the package-style names in `hs_n8n_node.md` / `eclipse_n8n_node.md` (`@profitpad-inc/...`) are not recognized.
- Credentials: HubSpot `hubspotApi` id `4HKK5aFFmTGesa3H`, Eclipse `eclipseApi` id `PVIgwtzRL74PSVft` (the IDs the user supplied for this project).
- The JSON was generated by a small Python builder, not exported from n8n. After importing, open each flow once and check the nodes resolved their parameters. Re-export from n8n after any edit there, so the repo matches what is live.

### user-lookup (`GET user?e_user_id=`)
- HubSpot Owners → Users → Search, filtering on `e_user_id` EQ.
- Returns `{ e_user_id, name, email, default_branch, territory, hs_user_id, hs_owner_id }`.
- Territory doubles as the outside salesperson.
- **The property names `e_default_branch` and `e_territory` are placeholders.** They are set in the `CONFIG` block of the `Validate` Code node.

### customer-lookup (`GET customer?e_customer_id=60623`)
One call resolves a customer for v2; it replaced the earlier `customer-addresses` flow (`GET customers?ids=`, now deleted; deactivate/delete it in n8n) and the page's per-customer product-inquiry lookups. Product-inquiry's customer search is used only when the rep is searching for a customer.
1. Eclipse Customer Get Many `id=<e_customer_id>` with only `isBillTo,isShipTo,billToId,shipToLists`.
2. `Resolve`: ship-to → its bill-to (`billToId`); bill-to → all its ship-tos (`shipToLists[].shipToId`), plus itself first when it is also a ship-to. `needs_ship_to_choice` is true for a bill-to unless its only ship-to is itself. All ids are split into chunks of 100 (Eclipse's id filter is in the query string).
3. Eclipse Customer Get Many for every id, fields `name,addressLine1,addressLine2,city,state,postalCode,countryCode,isBillTo,isShipTo,homeBranch,defaultPriceClass,creditLimit` (`returnAll`, `allInOne`).
4. HubSpot company Batch Read (`0-2`, `idProperty: e_customer_id`, properties `e_customer_id, latitude, longitude`, `executeOnce`) for the HubSpot record id and coordinates; best-effort.

Response (each party has the same shape):
```
{ customer, bill_to, ship_tos: [...], ship_to: <auto-picked or null>, needs_ship_to_choice,
  party = { e_customer_id, name, hs_id, address_line1, address_line2, city, state, postal_code, country,
            is_bill_to, is_ship_to, home_branch, price_class, release_number, credit_limit: { value, currency } | null,
            latitude, longitude, missing } }
```
Errors: 400 bad id, 404 unknown customer, 502 Eclipse failure.
Field names confirmed live via the old customer-addresses flow (2026-10-17): address fields, `isBillTo`, `isShipTo`, `homeBranch`, `defaultPriceClass`, `creditLimit` (`{ value, currency }`), HubSpot company `latitude` / `longitude` (60622 / 60623 → `32.656575, -114.404216`; 57399 has none). Imported and GET-tested 2026-10-17: 60623 (ship-to) → bill-to 60622, auto-picks itself; 60622 (bill-to) → ship-tos [60623], picker shown; 57399 (bill-to and ship-to, no other ship-tos) → itself, no picker; 99999999 → 404. So `billToId` and `shipToLists[].shipToId` are confirmed, and HubSpot record ids come back (60623 → 32043761971).

### create-order (`POST create-order`)
Request:
```
{ bill_to_id, ship_to_id, ship_branch, price_branch?, order_status, ship_via, ship_date, required_date,
  po, release, internal_notes, shipping_instructions, freight_in?, writer, outside_sales, email,
  lines: [{ productId, quantity, um?, umQuantity?, unitPrice? }] }
```
1. Eclipse Customer Get for the bill-to and the ship-to.
2. The `Build order` node assembles the `POST /SalesOrders` body. It follows the `post_sorder()` reference script the user supplied:
   - Branch and PO fall back to the bill-to's defaults.
   - `salesSource`: the bill-to's `salesSourceOverride`, else `'Default Sales'`.
   - `termsCode`: the bill-to's `defaultTerms`; left out of the body when the bill-to has none.
   - `customerReleaseNumber`: exactly what the page sends (no fallback). The page pre-fills it from the bill-to's `release_number`, so a rep who clears it sends it blank.
   - Ship via: `shipVia` is only in the body when the page sends one (a bid may leave it blank), with no `defaultShipVia` fallback.
   - The address comes from the ship-to.
   - `orderType` is `MOE`.
   - `outsideSalesPerson` falls back to `WIHOUSE`.
   - Blank dates default to ship date today and required date 7 days out (a Saturday or Sunday moves to Monday), as `YYYY-MM-DD`.
   - Freight in (added 2026-10-17, on request): `freight_in` (dollars; blank, invalid or not above 0 → 0) goes into the body as `freightCharges` only when above 0. `freightCharges` is the only freight field in the `post_sorder()` reference body (commented out there, next to `handlingCharges`); **UNVERIFIED that Eclipse accepts it on create, and that it books it as freight in (`freightInBillable`) rather than freight out.** The user chose this mapping knowing that. Check with the first test order: open it on the page (the totals box shows Eclipse's freight in / out). Validate and Build order were run in node with 12.5, "", -3 and "abc". Pushed and published to the live workflow `7CTuJDaU94slnEH3` ("e-order-placement: create order") through the n8n connector on 2026-10-17, on request (the live Validate and Build order matched the repo before the change). Not called: no POST was sent, so the first real order with freight is the test.
   - `lines` is an array of `{ lineItemProduct }`. The reference script had a duplicate-key bug that kept only the last line.
3. Eclipse Sales Order Create in JSON mode.
4. `POST https://n8n.fairbankequipment.com/webhook/update-hs-deal` with `{ "e_sorder_ids": ["S123.0001"] }`. It answers `{ message: "Deals updated.", source, orders: [{ "<hs_deal_id>": "<e_sorder_id>" }] }` (verified 2026-10-17: `{ "66168463527": "S2737688.0001" }`). `Final` picks the deal whose order id matches the one just created (exact, then same order ignoring the gen suffix, then the only deal returned); a text body in `data` is parsed as JSON.

Returns `{ success, e_sorder_id, order_id, hs_deal_id, hubspot_sync: { ok, error?, orders? } }` (`orders` is update-hs-deal's raw list, for troubleshooting a missing deal link). `hs_deal_id` is `""` when the sync failed or returned no matching deal.

Done page (after placing): "New order, same ship-to" (N), "Change customer", "HS Deal ↗" (`record/0-3/<hs_deal_id>`, only when `hs_deal_id` is set; was "Open deal in HubSpot ↗") and "HS Customer ↗" (the HubSpot company, `record/0-2/<hs_id>`; earlier "Open in HubSpot", then "Open company", then "Open customer ↗"). Renamed 2026-10-17 to match the order page's top buttons.

### order-lookup (`GET order?e_sorder_id=S2678479.0002` or `?e_sorder_id=S2678479`)
Added 2026-10-17 for loading an existing order into order-placement v2. The id's `S` prefix is optional. Without a gen suffix the lowest generation is the selected one (it used to default to `.0001`, which 404s on orders like S2659464 that have no gen 1).
Live: the all-generations version was pushed and published to workflow `XWqISrcx7Qwkm6Tt` on 2026-10-17 and GET-tested (S2659464 → gens 2/3/4, invoice 3/1/2, 7 lines on gen 2; S2659464.0003 → Cancel, 0 lines; S2659464.0001 → 404; S0920344.0001 → one gen; S2678479.0002 → Bid, invoice null).
1. Eclipse SO Get on the base order id. Verified live 2026-10-17: `S2659464` returns all its generations (2, 3, 4) in one response; only gen 2 has lines.
2. `Shape` builds every generation (each with its own header fields and lines with a quantity, `stockQty + nonstockQty > 0`) into `generations[]`, sorted by `generation_id`, and copies the selected one's fields to the top level (so the response is a superset of the old one).

Totals (added to `Shape` 2026-10-17 for the summary box, per generation and top level): `freight_in` (`freightInBillable`), `freight_out` (`freightOutBillable`), `handling` (`handlingInBillable` + `handlingOutBillable`), `tax_total` (`taxTotal`), `order_total` (`total`), all `.value`. Run in node against S2678263.0002 from the export: 507.44 + 23.76 freight out + 50.22 tax = 581.42 total. Pushed and published to the live workflow `XWqISrcx7Qwkm6Tt` through the n8n connector on 2026-10-17 (on request) and GET-tested; subtotal + freight + handling + tax equalled Eclipse's total on every generation: S2678263.0002 507.44 + 23.76 + 50.22 = 581.42; S0920344.0001 404.77 + 16.68 = 421.45; S2659464 gen 2 15,260.91 + 1,695 = 16,955.91 (gens 3 / 4 cancelled, 0); S2737688.0001 404.87. Eclipse returns `freightInBillable` (and sometimes `freightOutBillable`) as null when nothing is billed; the page shows those as $0.00 on an existing order.

Response:
```
{ success, e_sorder_id, order_id, generation_id, status, editable (status === 'Bid'),
  cancellable (status not 'Invoice' / 'Cancel'), bill_to_id, ship_to_id, ship_to_name, ship_branch, price_branch,
  ship_via, order_date, ship_date, required_date, po, release, internal_notes, shipping_instructions, writer,
  outside_sales, inside_sales, print_status, last_modified, last_modified_by, sales_total,
  lines: [{ line_id, product_id, description, qty, unit_price, unit_cost, unit_cogs, um, um_qty, line_status }] }
```
3. `Deal ids` lists every generation's `e_sorder_id`; `HubSpot: get deals` does one deal Batch Read (`0-3`, Fields mode, `idProperty: e_sorder_id`, properties `e_sorder_id, dealname, delivery_details, delivery_tracking_link`, `allInOne`, `executeOnce`, `alwaysOutputData`, `continueRegularOutput`); `Shape` reads Eclipse by node name and matches deals on `e_sorder_id`. Best-effort: a HubSpot failure sets `hubspot_error` and the order still loads. Added and published 2026-10-17 (8 nodes now); GET-tested: S2737688.0001 → deal 66168463527, S2737687.0001 → 66178218245, S2659464 → 59219834900 / 59219907605 / 59725567316 for gens 2 / 3 / 4, S0920344.0001 → 64678008853, S2678479.0002 → 59235398504, about 0.8 to 0.95 s each. The raw HubSpot output returns `delivery_details` and `delivery_tracking_link` as null on all of these, so both property names exist; no deal with tracking filled in has been seen yet.
Each `generations[]` entry has the same per-generation fields as the top level plus `invoice_number`, `full_invoice_id`, `hs_deal_id`, `hs_deal_name`, `tracking_details` (HubSpot `delivery_details`) and `tracking_link` (`delivery_tracking_link`); the top level also has `hubspot_error`. The invoice number is Eclipse's `invoiceNumber`; `invoiceId` exists but is null in live responses. Invoice numbers do not follow the generation numbers (S2659464: gen 2 = invoice 3, gen 3 = invoice 1, gen 4 = invoice 2; gens 3 and 4 are cancelled but still carry invoice numbers).
Errors: 400 bad id, 404 unknown order or generation, 502 Eclipse failure.
Field names come from real Eclipse SO exports in `../retro_orders/from_eclipse/` (`generations[].status`, `billToId`, `shipToId`, `shipBranch`, `shipVia`, `poNumber`, `releaseNumber`, `internalNotes`, `shippingInstructions`; `lines[].lineId`, `productId`, `productDescription`, `displayUom`; `lines[].generations[].stockQty`, `nonstockQty`, `price.value` = unit price, `cost.value` → `unit_cost`, `cogs.value` → `unit_cogs`). `cost` and `cogs` differ on most lines; in the 2026 exports 373 lines have `cost` 0 with `cogs` above 0 (e.g. S2678479.0002 line 1, a $9,476 trailer: cost 0, COGS 6,144.677) and 14 the reverse. The page shows `cogs` as Unit cost (user's choice, 2026-10-17). `print_status` is `generations[].printStatus` as stored; values in the 2026 exports are `N` (almost all), `Q`, `H`, `P`, `A`, and their meanings are UNVERIFIED (not in the Epicor data profiles), so the page shows the raw code. `last_modified` / `last_modified_by` are the order-level `lastUpdateDateTime` / `lastUpdateUser` (Eclipse has no per-generation timestamp in the export). Status values seen there: `Bid`, `Invoice`, `ShipWhenComplete`, `CallWhenComplete`, `ShipWhenAvailable`, `Direct`, `ShipWhenSpecified`; `Cancel` comes from the node's status list. `productDescription` holds the catalog number and the description on two lines; the flow joins them with a space. Live in n8n as workflow `XWqISrcx7Qwkm6Tt`; the `unit_cost` / `unit_cogs` change was applied and published there through the n8n connector on 2026-10-17 and GET-tested; `print_status` / `last_modified` / `last_modified_by` were pushed and published the same way later that day (S0920344.0001: order date 2024-08-29, writer SAR, outside sales STHOUSE, print status N, last modified 2026-09-04T20:34:22Z by HILTRA). First test: S0920344.0001 (Invoice) → line 2579 price 391.07, cost 253.41, COGS 253.41; line 95447 ("Conversion Product Not Found") price 13.70, cost 0, COGS 0.

### customer-orders (`GET customer-orders?e_customer_id=13737`)
Added 2026-10-17 for the "Other orders" dialog. `e_customer_id` is the bill-to.
1. Eclipse SO Get Many: `BillTo`, sort `-orderDate`, one page of 100, `Selected Fields` `id,lastUpdateDateTime,generations.generationId,generations.invoiceNumber,generations.status,generations.orderDate,generations.shipToId,generations.shipToName,generations.poNumber,generations.salesTotal`.
2. `Shape` groups rows by base order id (the exports suggest Get Many returns one row per generation, ids like `S2659464.0002`; it copes with either), newest order date first.

Response: `{ success, e_customer_id, orders: [{ order_id, order_date, last_modified, generations: [{ e_sorder_id, generation_id, invoice_number, status, order_date, ship_to_id, ship_to_name, po, sales_total }] }], truncated, page_size }`. `truncated` is true when the page was full (older orders not listed). Live in n8n as workflow `2pbBFSx9klQlgdcW` (created through the n8n connector 2026-10-17, in Chris Becher's personal project; the other e-order-placement flows' project was not checked) and published. GET-tested: 13737 → 14 orders, 5 KB, 0.9 s, S2659464 grouped as gens 2 / 3 / 4 with invoices 3 / 1 / 2; 60622 → 98 orders from 100 rows, `truncated: true`, 31 KB, 1.6 s; `abc` → 400. So the dot-path field selection on `generations[]` works.

### order-changelog (`GET order-changelog?e_sorder_id=S2737684`)
Added 2026-10-17 for the "Change log" dialog. Accepts the id with or without a gen suffix; the log is always the whole order.
1. Eclipse Sales Order Get Order Change Log (`changeLogOrderId` = base id, `changeLogGenerationId` blank = every generation; `GET /SalesOrders/S…/OrderChangeLog`).
2. `Shape` maps `comments[]` (`generationIds`, `date`, `time`, `userId`, `comment`, per the user's `get_sorder_history.py` reference script) to `entries: [{ gens: ['ALL'] | ['1', …], at, date, time, user, comment }]` in Eclipse's order. `at` is `date` + `T` + `time` with a `Z` added when the time has no offset, i.e. UTC. Confirmed live: Eclipse sends `time` with a `Z` (`"17:12:21Z"`).

Live in n8n as workflow `u4N7UbnofoahBYSj` (created and published through the n8n connector 2026-10-17, Chris Becher's personal project). GET-tested: S2737684.0001 → 27 entries, 4.5 KB, 1.1 s, starting "ALL · Oct 17 2026 01:12:21 PM EDT · ANDDAV · ** Order Created **", matching the user's `get_sorder_history.py` output row for row; `nope` → 400.

Response: `{ success, order_id, entries }`. Errors: 400 bad id, 502 Eclipse failure.

### update-bid (`POST update-bid`)
Request: `{ e_sorder_id, writer, lines: [{ line_id?, productId, quantity, unitPrice? }] }`. `lines` is the complete list the bid should end up with: a `line_id` is an existing line (qty and/or price may change), no `line_id` is a new line, and existing lines left out are deleted. Only lines change; header, status and customers are untouched. An empty list is refused (cancel the bid instead).
1. Eclipse SO Get (base id), then `Plan`: the generation must exist and be `Bid` (else 409). Each `line_id` must still be on the gen with the same product (else 409, "reload the bid"). It plans DELETE for missing lines, PUT qty (`{ lineId, qty, um }`, um from the line's `displayUom`, as v1) for qty changes, PUT price (`{ lineId, value }`, the node's Update Line Items Price, `PUT /SalesOrders/S….NNNN/LineItems/Price`) for a `unitPrice` that differs from the line's price, and POST `{ lineItemProduct: { productId, quantity, um: 'ea', umQuantity: 1, unitPrice? } }` for new lines. Nothing to change → 200 `{ success, unchanged: true }` straight away.
2. Steps run in that order (delete, qty, price, add), each skipped when empty, all against the gen-scoped id. A failed step returns 502 with `step` and `changes`; earlier steps may already be saved.
3. `update-hs-deal` with the order id, then `Final`: `{ success, e_sorder_id, order_id, hs_deal_id, changes: { added, qty, price, deleted }, hubspot_sync }`.

UNVERIFIED: whether Eclipse reprices a line when only its qty is PUT (the page keeps showing the bid's price), whether `unitPrice` inside `lineItemProduct` is honoured on Create Line Items (it is on SO Create), and the Price endpoint's body (taken from the node source, `/Users/riipen/Desktop/n8n/n8n-nodes/packages/n8n-nodes-eclipse/nodes/Eclipse/EclipseApi.node.ts`; never called before).

### cancel-order (`POST cancel-order`)
Request: `{ e_sorder_id, writer }` (`writer` is required but only validated; the status call does not take it).
1. Eclipse SO Get, then `Check status`: `Invoice` → 409 "already invoiced", `Cancel` → 409 "already cancelled", unknown order / gen → 404.
2. Eclipse Update Status, `Cancel`, on the gen-scoped id (the node splits it into order id + `generationId`, as v1's empty-gen cleanup).
3. `update-hs-deal`, then `Final`: `{ success, e_sorder_id, order_id, previous_status, status: 'Cancel', hs_deal_id, hubspot_sync }`.

All three flows were built by the same Python builder (kept in the session scratchpad, not committed) and their Code nodes were run in node against a real bid from the export (S2678479.0002: 4 lines, incl. $0 kit components and a MiscChrg line). None has been imported or called live.

### v1-inventory-lookup (`POST v1/inventory-lookup {dealId}`)
This is a port of `eclipseInventoryLookup.js`, and the response body has the same shape.
1. HubSpot deal Get.
2. The `dealstage` property definition, which maps the stage id to a label. The node has no pipelines resource.
3. Blocked-stage gate, then missing-OID gate.
4. Deal → line items association, then Batch Read of the line items, then the missing-product-ID gate.
5. Eclipse SO Get to find the bill-to customer, which pricing needs. The bill-to is per generation: `results[0].generations[].billToId`. The flow uses the gen from the deal's `e_sorder_id` suffix, else the first gen (verified against S0920344.0001 → 62938, 2026-10-17).
6. Eclipse Product Inventory Pricing Inquiry (`considerUserAuthBranch: true`, `allInOne`).
7. The `Build branch matrix` node holds the original `BRANCH_COORDS`, haversine, branch matrix, unavailable products and `findClosestCombination`, unchanged.

The response also adds `deal.dealName`, which v1 `module.js` already displays.

### v1-place-order (`POST v1/place-order`)
This is a port of `eclipsePlaceOrder.js`, with the same stage order and the same idempotency:
1. HubSpot `e_sorder_id`, then preflight: the order ID must carry the gen suffix.
2. Eclipse SO Get, then `Plan generations`: reuse a matching gen, otherwise create one.
3. Create Shipment for each new gen, then `Plan line ops` (Pass A on destination gens, Pass B on the source gen).
4. POST line items, then DELETE, then PUT qty. Each step is skipped when its list is empty.
5. Re-read the order and cancel gens that ended up empty (best-effort).
6. `update-hs-deal` with every touched gen in one call. This replaces the dead Celigo export.

`Final` returns `{ success, eclipseOrderId, createdGenerations, eclipseResponses }`.

The planning code was checked against a mocked order and gave the same POST, DELETE and cancel plan as the original.

## Front end

### order-placement v2 (`docs/order-placement/`)
The user calls this page "order-placement v2".
- Unit cost: read-only column after Unit price, from `unit_cost` in the product-inquiry price lookup (shown muted; "-" when the lookup has none). On phones it sits beside Ext.
- Quantity breaks: F4 (together with the stock strip) toggles a strip under every line (like Eclipse's Quantity Breaks box): one chip per break with the break qty and unit price (the extension at that qty was removed on request) (`quantity_breaks` from the product-inquiry price lookup; a start qty of 0 shows as 1+). The tier the line's qty falls in is outlined in gold and moves as the qty changes. With one or no breaks it shows "None · $x each" (a single "1+ $x" chip was tried and reverted). It can be open together with the stock strip; each strip is labelled.
- Bill-to / ship-to boxes: two cards side by side (stacked on phones), steel border (the gold top border was removed in the readability pass). Each shows the Eclipse customer name (e.g. "test05 may12", not HubSpot's composite "test05 may12 - Bill/Ship - LP - Denver, CO - 57399"; HubSpot's name is only a fallback), Eclipse id, and the Eclipse address from `e-order-placement/customer` (one `customer-lookup` call returns the customer, its bill-to and all ship-tos). The bill-to card carries the price level badge (top right) and the credit limit (bottom right, e.g. "$15,000"; hidden when Eclipse has none); the ship-to card shows the ship-to's own Eclipse home branch bottom right (e.g. "17 - Yuma"; this is also the default ship branch) and has a "Change" link when the bill-to has more than one ship-to, which reopens the picker and keeps the lines and header (Esc returns to the order). A related customer missing from Eclipse shows "Not found in Eclipse" in place of the address. The ship-to picker lists each ship-to's address and, bottom right, its home branch (e.g. "16 - Salinas"; hidden when Eclipse has none).
- **Side layout (`index.html`, the default since 2026-10-17; was `side.html`):** It loads the same `app.js` / `styles.css`; `<main id="app" data-layout="side">` switches the layout. Instead of strips under every line, stock by branch and qty breaks for **every line with a product** show in a box to the right of the lines (`aside.fop-side`, sticky, scrolls on its own when long), one section per line in line order (line number and description, no product id), open by default. While the card is open the page widens to 1640px (`.fop-wrap--sideopen`); closed, it returns to the regular page's centred 1280px. The focused line's section is outlined in gold and scrolled into view as the rep moves between lines. The × in its top right, Esc, F4 or the "Hide stock & qty breaks" button close it; F4 / the button reopen it. The card's column runs beside the bill-to/ship-to cards, the lines, the header and the action bar (left column `.fop-split__main`; the place error and the action bar moved into it on request), so those no longer take the full width. The card scrolls independently of the page: it is sticky with its own scrollbar, `overscroll-behavior: contain` stops a scroll at its end from moving the page, following the focused line scrolls only the card (manual `scrollTop`, not `scrollIntoView`, which also scrolled the window), and its scroll position is kept across full re-renders (`render()`). The side layout has no "All" column (`.fop-grid--noall`); each product's stock label in the card reads "Stock (7)" with the all-branch total instead. Within a section, stock (left) and qty breaks (right) sit in two columns (`.fop-side__cols`), chips stacked; a thin divider sits above each product's name except the first (`.fop-side__line::before`; 14px above, 12px below), none between the name and its columns; the card is 340px wide (was 380px); product descriptions in it are white and capped at 35 characters plus "..." (full name in the tooltip). Card text is 15px (Stock / Qty breaks labels 14px), a size up from the rest of the page's small text. Below 1200px wide the card drops under the header. Everything else is identical to `inline.html`, so changes to `app.js` apply to both pages.
- **Inline layout (`inline.html`, was `index.html` until 2026-10-17):** the original v2 layout, kept for comparison. Same `app.js` / `styles.css`, no `data-layout` attribute; stock by branch and qty breaks show in a strip under each line, and the grid keeps the "All" column.
- Line shading: every second line (`.fop-line--alt`) is slightly lighter. When shown, the stock and qty-breaks strips form one slightly blue-tinted panel under each line (stock on top, breaks below), so they read separately from the line itself.
- Stock by branch: hidden by default to keep the chart compact. F4, the single "Show stock & qty breaks" button next to "+ Add line", or clicking any dotted "All" count toggles both the stock strip and the qty-breaks strip; the stock strip is under every line that has a product: one chip per branch with stock, in branch-number order (1 → 17). The ship branch is always shown and outlined in gold, even at 0. Strips update in place when the ship branch or qty changes; Esc hides them. Data is `stock_info` from the product-inquiry price lookup, so it costs no extra calls.
- URL prefill: `?e_customer_id=57399&e_product_ids=106331,110723,105958&quantities=50,1,4` seeds the first new order (started from the orders list) with those lines (quantities pair up by position; missing or invalid ones default to 1; non-numeric ids are skipped). Descriptions come from the product-inquiry product search with a leading dot (`e_product_name=.106331`, exact id match) and prices/stock load as usual. An id that isn't found shows "Product … not found" on its line and blocks placing until fixed or removed. Only the first order uses them ("New order" starts blank). The parser tolerates `?` used in place of `&` (e.g. `?e_customer_id=1?e_product_ids=2`) and a trailing `?`, and the page rewrites the address bar into a clean `&`-joined query.
- **Existing order (`?e_sorder_id=S2678479.0002`, added 2026-10-17):** loads the order through `e-order-placement/order`, then the customers through `e-order-placement/customer` on the order's bill-to (the ship-to is picked from its ship-tos by `ship_to_id`; one outside that list is resolved on its own). `?e_sorder_id` wins over `?e_customer_id`, and URL products are ignored. The title is just the order id ("S0920344.0001"; the "Bid" / "Order" prefix was removed on request) with a status badge (Invoiced green, Cancelled red, others steel), and an info note says what can be done.
  - **Invoiced or cancelled:** no stock at all (2026-10-17, on request): the Br column is blank (header and cells), the stock & qty breaks card and its button are gone, F4 does nothing and the F4 hint leaves the legend.
  - Locked header boxes all look alike (2026-10-17, on request): `.fop-head--locked` gives every input, select, date field and notes box the normal input background and text colour with a not-allowed cursor. Locked selects (Ship via, Ship branch) have no chevron and locked dates no calendar icon (2026-10-17, on request; normal 10px right padding). The earlier `.fop-input:disabled` style (lighter background, muted text) made selects and info boxes differ from the date fields and hid the select chevron.
  - **Switcher (2026-10-17):** a row under the title, above the customer cards, with an "Other orders" button and, on an existing order, one tab per generation ("Generation 2 / Invoice 3", or "Generation 4" with no invoice; tooltip shows the id and status). Every generation arrives in the one order-lookup call, so a tab switch makes no request (only a customer-lookup when a generation has a different bill-to). The URL follows the open tab (`?e_sorder_id=S2659464.0003`). Unsaved bid edits are kept per tab (`state.genEdits`), so switching away and back keeps them. The tabs are steel with the active one gold-underlined.
  - **Other orders:** the button (also on a new order once the customer is known) opens a dialog listing the bill-to's recent orders from `customer-orders`: order id, newest order date, ship-to, PO, the total of non-cancelled generations and a status badge per generation; the open order is marked "(open)" and focused. ↑↓ / Tab move, Enter opens, Esc closes. The list is cached per bill-to for the session. Opening an order loads it at its lowest generation. Leaving an order with unsaved bid edits, or a new order with lines, asks "Leave this order? Unsaved changes will be lost." (browser confirm); so does "Exit" on an existing order with unsaved edits.
  - **HubSpot (2026-10-17):** "HS Customer ↗" (was "Open customer in HubSpot ↗"; renamed with the deal link on request 2026-10-17) (the bill-to's company, `record/0-2/<bill_to.hs_id>` from customer-lookup; on new and existing orders, hidden when HubSpot has no company) and "HS Deal ↗" (was "Open deal in HubSpot ↗") sit beside "Exit" at the top right; the deal link shows whenever the open generation has a deal (`record/0-3/<hs_deal_id>`, deal name as tooltip); it follows the tab. A full-width row under the two notes boxes shows read-only "Tracking details" (HubSpot Tracking Details, `delivery_details`), parsed (2026-10-17, on request) by `parseTracking()` in `app.js`. The text is always one block per package separated by a dashed line (" - - - - -"), each with `Status:`, `Pickup Date:`, `Delivery Date:`, the carrier URL, and `Recent Update:` followed on the next line by "Departed from Facility (2026-10-17)". It renders a summary ("4 packages · On the Way · Delivery Oct 21, 2026"; mixed statuses read "2 On the Way, 1 Delivered"; the delivery date only when all packages share it) and one card per package (auto-fill grid): "Package 1 of 4", a status badge (green for Delivered, red for exception / delay / return words, steel otherwise), the tracking number as a gold link (from the URL's `tracknum` param, else "Track package"), Pickup and Delivery dates ("Oct 16, 2026") and "Latest Departed from Facility · Oct 17, 2026" (left out when the package is delivered, by status or by the update text, on request). Unrecognised lines in a block show muted at the bottom of its card. Text with no package fields falls back to the raw text with its http(s) links clickable (everything escaped; `javascript:` and HTML stay plain). The row is hidden when HubSpot has no tracking details (it showed "None" before). It replaced a separate "Tracking link" field (Tracking Link, `delivery_tracking_link`) on request; order-lookup still returns `tracking_link`, unused by the page. Shown on every existing order.
  - **Change log (2026-10-17):** a "Change log" button at the far right of the switcher row (existing orders only; moved there on request) opens a wide dialog with Eclipse's order change log from `order-changelog`, laid out like the user's tabulated script output: Gens, Date & time ("Oct 17, 2026, 1:12:21 PM EDT", browser time zone, with seconds), User, Comment, in Eclipse's order, header row sticky, scrolls inside the dialog. Rows for other generations are muted; a "Generation 2 / Invoice 3 only" checkbox filters to the open tab plus "ALL" rows, with an "n of m entries" count. Esc closes. Fetched once per order (reloading the order refetches). Esc fix (2026-10-17): clicking a dialog's text leaves focus on `<body>`, outside `#app`, so Esc did nothing; a document-level listener now passes Esc and Tab (not Enter, so stray focus cannot confirm a placement) to the same key handler (`onKey`) while any dialog is open (change log, other orders, cancel, confirm).
  - After a cancel, the done screen also offers "Back to order" (reloads it).
  - Header and customers are always locked on an existing order: header inputs and date pickers are disabled (no `minDate`, so past dates show), there is no ship-to "Change" link, and the top button reads "Exit" (was "New order", renamed on request 2026-10-17; it leaves the order, clears `e_sorder_id` and goes to the customer search).
  - **Bid:** only the lines can change (add, remove, retype product, qty, unit price). "Update Bid" (F9) replaces "Place as Bid"; "Place Order" / F10 are hidden so a bid is never duplicated as a new order. Update Bid is disabled with "No changes to save." until something differs. Its dialog lists every line tagged New / Changed and the removed lines struck through, with a "1 added · 2 changed · 1 removed" summary; Enter confirms. The done screen says "Bid updated" with "Back to bid" (reloads it), "New order, same ship-to", "Change customer" and the deal / customer links.
  - Loaded lines keep the bid's own unit price (`keepPrice`): no cost + $0.01 floor (bids carry $0 kit components) and no re-pricing from qty breaks on a qty change; the price is white, not gold, until the rep edits it. Editing a price drops `keepPrice` (normal floor and gold); clearing it goes back to Eclipse break pricing. Update Bid sends `unitPrice` for a loaded line only when its price differs from the bid's. Retyping a loaded line's product makes it a new line and the old one is deleted.
  - Unit cost on loaded lines is the order line's own Eclipse COGS (`unit_cogs` from `e-order-placement/order`, kept as `line.orderCost`; `cost` was tried first and switched on request, since it is 0 on some lines with a real COGS), not the product-inquiry lookup; it also drives the cost + $0.01 floor and the action bar's Cost total. Retyping the product drops it and the lookup's cost is used. Shared by `lineCost()` (2026-10-17, on request).
  - Descriptions on loaded lines are Eclipse's own `productDescription`. "Conversion Product Not Found" (product 95447 on S0920344.0001, seen live 2026-10-17) is that product's real name in Eclipse, not a page message; the page's own message reads "Product … not found. Retype it or remove the line."
  - **Not a bid (any other status):** the header gains read-only Writer, Outside sales, Inside sales and Print status (the raw Eclipse code), placed in the header rows described under **Order header** (`orderInfoField()`). Added 2026-10-17 on request. Inside sales is `generations[].insideSalesperson` (`inside_sales`, pushed and published to n8n the same day); it is blank on 98.8% of generations in the exports (158,832 of 160,774; filled ones look like EDWJOE, MOOJUS), and create-order always sends `insideSalesPerson: ''`, so it is usually empty.
  - **Last modified:** every existing order shows "Last modified Apr 27, 2026, 8:00 PM CDT" (the order's `last_modified`, in the browser's time zone with its short name: EDT, CDT, PDT, MST…; outside the US the browser may give "GMT+1"; 6px gap after the label) at the right of the action bar, before any buttons.
  - **Cancelled:** the red "required date before ship date" outline is never shown (2026-10-17, on request; cancelled orders can carry odd dates, e.g. a ship date of Oct 15, 2241).
  - **Any other status:** nothing is focused on load, so no line or stock-card section is highlighted (2026-10-17, on request; `state.focus.r` starts at -1). F3 or a click moves into the lines.
  - **Any other status (cont.):** lines are read-only (inputs `readonly`, arrows still move; no steppers, remove buttons, "+ Add line", Ins, Enter or Ctrl+Del). F9 and F10 do nothing.
  - **Cancel:** a red outlined "Cancel Bid" / "Cancel Order" button sits in the action bar for every status except `Invoice` and `Cancel`. It opens an "Are you sure?" dialog (focus starts on "Keep bid/order"; Esc keeps it; Tab stays in the dialog) whose red "Yes, cancel …" button calls `e-order-placement/cancel-order`. The done screen says "Bid cancelled" / "Order cancelled".
  - A jsdom smoke test with every request mocked (no live calls) covered: Bid load, header lock, no-change block, qty / price / remove / add edits and the exact update-bid payload, F10 ignored, the cancel dialog (Esc, confirm, payload), and the read-only Ship When Complete, Invoiced and Cancelled views. Not checked in a real browser.
- External-link icon (2026-10-17, on request): every "↗" in the labels above is drawn as HubSpot's ExternalLink SVG (`EXT_ICON` in `app.js`, `.fop-ext` in `styles.css`: 0.9em, `currentColor`, `aria-label` "Link opens in a new window"). It follows HS Customer, HS Deal (order page and done screen) and the tracking number links on package cards. The linkified URLs in the raw tracking fallback have no icon. On tracking links the gap before the icon is a 0.3em margin, not a space, so the underline ends with the tracking number.
- Price level: the bill-to's `price_class` from `e-order-placement/customer` (Eclipse `defaultPriceClass`). Shown as a gold badge on the Bill to card and in the confirm dialog. Prices are quoted against the bill-to, so that is the level in effect.
- Files: `index.html` (markup, `#app` mount), `styles.css`, `app.js`, and `vendor/flatpickr.min.{js,css}` (flatpickr 4.6.13, MIT, copied from `/Users/riipen/Sites/camo-cpq/html/sales.californiamobility.com/cpq/vendor/`; vendored so there is no CDN dependency).
- Date fields (ship date, required date) use the same Flatpickr setup as the camo-cpq quote expiration picker: `altInput` shows "Oct 26, 2026" (no weekday) while the hidden input and `state.header` keep `YYYY-MM-DD`; `minDate: "today"`; `disableMobile: true` so phones get the themed calendar instead of the native one. Themed navy/gold at the bottom of `styles.css` (literal colours, since the calendar is appended to `<body>`). Gotcha: when flatpickr opens the calendar above the field it positions it by the summed `offsetHeight` of the calendar's children, ignoring padding/border on `.flatpickr-calendar` itself; so the outer box has no padding or border (outline is a `box-shadow`) and the spacing sits on `.flatpickr-months` / `.flatpickr-innerContainer`, otherwise the calendar overlaps the input. The visible inputs carry a small calendar icon on the right (inline SVG background on `.fop-date-alt`, muted, gold when focused or open). Dropdowns (`select.fop-input`, including the F10 status picker) use a matching custom chevron instead of the native arrow: same muted colour, slightly bolder, 8px from the right edge, gold when focused. `initDatePickers()` destroys and re-attaches the pickers after every render. A ship date after the required date outlines the required field in red and blocks placing. `app.js` boots right away when `FB_USER` is set, otherwise on the `fb:auth` event.
- **Flow (reworked 2026-10-17, on request):**
  1. Customer: `?e_customer_id`, or a customer search.
  2. Orders list (`view: "orders"`, `viewOrders()`): the bill-to and (when the picked customer is a ship-to other than its bill-to) ship-to cards, a "New order" button (N) and the bill-to's recent orders from `customer-orders` (same rows as the "Other orders" dialog, shared through `ordersBodyHtml()`). A picked ship-to filters the list to orders with a generation for it, with a "Show orders from other ShipTos" checkbox (unchecked by default; on request, after "Only orders for ship-to …" and "Hide orders from other ShipTos") that, checked, lists the whole bill-to's orders. ↑↓ move between New order and the orders, Enter opens, Esc goes back to the customer search. The orders list (`.fop-orders`, dialog and page) has a thin steel scrollbar in a stable gutter, 8px clear of the cards (2026-10-17, on request: the default scrollbar sat on the cards' right borders). The list is refetched every time a customer is picked, and the cache is cleared after placing an order.
  3. New order: a bill-to (`needs_ship_to_choice`) gets the ship-to picker (Esc returns to the orders list); otherwise its auto-picked ship-to goes straight to the grid. An existing order opens directly (`loadExistingOrder`).
  4. Order grid, confirm dialog, done view with the SO number and HubSpot links.
  `?e_customer_id` also lands on the orders list (it no longer skips to the grid); URL products (`e_product_ids`) still seed the first new order started from it. Only `?e_sorder_id` skips straight to the order. Opening an order from the list leaves `e_customer_id` in the URL next to `e_sorder_id` (harmless, `e_sorder_id` wins). Checked with a mocked jsdom smoke test (bill-to and ship-to via URL, search by id, N / Esc / ↑↓, ship-to pick, opening an order, `?e_sorder_id`); not checked in a real browser.
- **Data sources:**
  - `fairbank-product-inquiry` (the existing flow that product-inquiry uses) for:
    - customer search only: `e_customer_name=<text>` (lookup by id goes through customer-lookup)
    - customer search: `e_customer_name`
    - product search: `e_customer_id` plus `e_product_name`
    - price and stock per product: `e_customer_id` plus `e_product_id`, at most 3 in flight, cached per product.
  - Prices use the bill-to customer.
  - Qty changes reprice locally from `quantity_breaks`.
  - "At branch" stock matches `stock_info[].warehouse` to the ship branch id.
- **Order header** (labelled "Header"; earlier "Order header", originally "Order details"). It is always open (2026-10-17, on request: no longer a collapsible `<details>`, on desktop or phones; the collapsed "ship via · Branch" summary next to the title went with it). F2 focuses its first field. It sits below the lines and the "+ Add line" / stock buttons, above the action bar. Desktop is a 6-column grid with fields three to a row (each spans 2 columns; `.fop-field--row` starts a row, so short rows leave the rest empty). Rows, in the user's order (2026-10-17): (1) ship via, ship branch, price branch (top right, read-only, "16 - Salinas"; an existing order's own `price_branch` from order-lookup, else the bill-to's Eclipse `home_branch`, which is what create-order's `Build order` uses when the page sends no `price_branch`; added on request); (2) ship date, required date, order date (order date moved to the right on request); (3) writer, outside sales, inside sales; (4) "Customer P/O #", "Customer rel #" (pre-filled from the bill-to's Eclipse `defaultReleaseNumber` via `release_number` in `e-order-placement/customer`; editable), print status; (5) "Shipping instructions" (left half) and "Internal notes (no credit cards)" (right half). Order date shows on every order, read-only: the order's own `order_date`, or today on a new order (2026-10-17, on request; Eclipse dates the order when it is created). Writer, outside / inside sales and print status only exist on a non-bid existing order, so a new order or a bid shows ship via, branch, price branch / ship date, required date, order date / PO, rel / notes. Read-only header inputs (order date, price branch) on a new order look like the locked ones (`.fop-head .fop-input:disabled`). Phones keep two fields per row. Both notes fields start at about 1.5 lines tall (`rows="1"` plus a CSS `min-height`; the half line hints there is room for more), have no placeholder or corner grip, and grow with their text; the two always share one height, the taller of the two (`autosizeNotesPair()` in `app.js`, on request 2026-10-17); line breaks are sent as `\n` in `shipping_instructions` / `internal_notes` (UNVERIFIED how Eclipse displays multi-line values). Order status is not in the header.
- **Header defaults:**
  - Ship branch dropdown: each branch shows its straight-line distance from the ship-to ("17 - Yuma · 4 mi"), sorted closest first, using the ship-to's HubSpot latitude/longitude and the same `BRANCH_COORDS` + haversine as v1 (copied into `app.js`). Without coordinates the list stays in branch-number order with no distances. Recomputed when the ship-to changes.
  - Ship branch: the ship-to's Eclipse `home_branch`, else the bill-to's, else the rep's `default_branch`. Required; there is no "customer default" option, and "Select…" only appears when none is known. Changing the ship-to mid-order moves the branch to the new ship-to's home branch unless the rep had picked a different one.
  - Ship via: starts blank ("Select…"). Required for Place Order (F10), which stays blocked until one is picked; not required for Place as Bid (F9). A bid sent without one gets `ship_via: ""`, and the create-order flow's `Build order` node leaves `shipVia` out of the Eclipse body entirely (UNVERIFIED what Eclipse stores then); the confirm dialog shows "None". The Common group is, in order: SEE INSTRUCTION, SALESMAN DELIVERY, UPS, BW BEST WAY, CPU PICK UP, OT OUR TRUCK, FEDEX AIR, FEDEX FRT, FEDEX GRD; everything else follows under All.
  - Order status: chosen only in the F10 / Place Order dialog (focused when it opens; ↑↓ or 1–6 pick it, Enter places). Defaults to Bid. Six statuses, in the user's order: Bid, Ship When Complete, Ship When Available, Ship When Specified, Ship Item Complete, Vendor Direct. The others (Call When Available/Complete/Specified, Pick Up Now, Ship Ticket) are hidden for now, commented out in `ORDER_STATUSES` in `app.js`. "Vendor Direct" sends Eclipse's `Direct` status (confirmed by the user, 2026-10-17). The dialog title and button switch between "Place as Bid?" and "Place Order?" as the status changes.
  - Dates: ship date today; required date 7 days out, moved to Monday if it lands on a Saturday or Sunday (local browser date).
  - PO and release: blank, filled from the bill-to's Eclipse defaults by create-order.
  - Price branch is not sent, so the flow uses the bill-to's home branch. The header shows it read-only (top right).
- **Writer and contact:** writer is `FB_USER.e_user_id`, email is `FB_USER.email`, outside sales is `FB_USER.territory`.
- **Totals summary box (2026-10-17, on request, modelled on a quote's totals box):** under the lines, right of "+ Add line" / the stock button (`.fop-gridfoot`, `summaryHtml()`, 340px, full width on phones; 8px below the lines, half the page's usual 16px gap, on request). Rows: Subtotal (the lines on the page), Freight in, Freight out, Handling (only when Eclipse has some, so the rows add up), Sales tax, then Total (gold, larger) with "Cost $x" in small muted text under it (the sum of each filled line's unit cost × qty, the same cost as the Unit cost column; "(some pending)" while any is loading or missing). Freight, handling and tax come from order-lookup (`freight_in` = `freightInBillable`, `freight_out` = `freightOutBillable`, `handling` = handling in + out billable, `tax_total` = `taxTotal`, `order_total` = `total`); a new order shows an editable Freight in box (added back on request, after a version with only the Total row) and the Total with the cost under it; freight out and tax are unknown until Eclipse creates the order. Its total is the subtotal + freight in, live as the rep types (only the total cell is redrawn, so the box keeps focus); leaving the box tidies it to two decimals, blank or invalid → empty. It is `state.header.freightIn`, sent as `freight_in` (see create-order), shown above the total in the confirm dialog when set, and reset by "New order". F2 now looks for the first field inside the header (`#fop-head`), since the freight box sits earlier in the page. Existing orders show every row (a null amount from Eclipse is $0.00; "-" only if order-lookup does not send the field). On an existing order, Total is Eclipse's `total` while the lines are unchanged, else subtotal + freight + handling + tax. In the 2026 exports `salesTotal + freightIn + freightOut + handling + taxTotal = total` on 44,347 of 44,684 generations; the other 337 (e.g. S2640606.0001: 204.00 → 209.87, about 3% more) have an extra amount none of these fields explain (UNVERIFIED, possibly a card surcharge), so Total there is more than the rows above it. Freight in was 0 or null on every 2026 generation.
- **Action bar totals:** the same Total as the summary box, in gold. The cost moved to the summary box (on request), and the line count ("3 lines") was removed earlier on request. The keyboard legend (↑↓←→ move, Enter next, …) sits just below the action bar, not inside it (moved 2026-10-17 on request); still hidden on phones.
- **Read-only columns:** Unit cost and Ext are muted gray (not editable); Qty and Unit price stay white.
- **Description:** blank on a line with no product yet (it used to show "-").
- **Unit price:** editable, up to 3 decimals (Eclipse prices like `183.619` keep the third decimal). An edited price is shown in gold and sent as `unitPrice`; clearing the cell reverts to Eclipse pricing.
- **Minimum price:** unit cost + $0.01. A typed price below it is raised to the minimum; an Eclipse break price below it is also raised. Either way the line shows "Price raised to the minimum, cost + $0.01 ($x)" and the order sends that `unitPrice`. When cost is unknown there is no floor. Normal prices above the floor send no `unitPrice`, so Eclipse prices them.
- **Keyboard:**
  - Existing order: F9 is Update Bid (bids only), F10 does nothing; in the cancel dialog Esc keeps the order.
  - Arrows move between cells. Left and right leave a cell only when the caret is at the edge.
  - Enter moves to the next cell or line, and picks from the product list.
  - Ins or Ctrl+Enter adds a line. Ctrl+Del removes one.
  - F2 jumps to the header, F3 to the lines. F4 shows or hides stock by branch and quantity breaks for all lines (one toggle); Esc hides them.
  - F9 opens the confirm dialog for a Bid (no status picker). F10 opens it with the order status picker; picking Bid there places a bid.
  - In the confirm dialog, Enter confirms and Esc cancels.
  - In the ship-to picker, 1 to 9 pick directly.
  - On the done screen, N starts a new order.
- **Phone (under 768px):**
  - Each line becomes a card with a large qty stepper.
  - Product search opens as a bottom sheet.
  - The header is always open, like on desktop.
  - A sticky bottom bar holds the total and the Bid / Order buttons.
- **Rendering:** a full re-render on structural changes. Cells are updated in place for prices, stock and totals, so focus is never lost.
- A jsdom smoke test was run from the scratchpad, not committed. It covered ship-to pick, product search, qty-break pricing, F10, confirm, and the POST payload. The UI has not been checked in a real browser: the user tests the UI.

### order-placement-v1 (`docs/archive/order-placement-v1/`)
- `module.js` now posts to `https://n8n.fairbankequipment.com/webhook/e-order-placement/v1/{inventory-lookup,place-order}`. It no longer uses `X-Api-Key` or `credentials`.
- The `data-api-key` attribute was removed from `module.html`.
- `index.html` gained `auth.js` and the github.io header hide.
- The deals board deep link on the done step still needs `data-portal-id` and `data-view-id`. These are stripped by the local loader, so the link is hidden.

## Unverified (confirm on first n8n run)

1. **HubSpot user properties** for default branch and territory. They are placeholders in `user-lookup` → `Validate` → `CONFIG`.
2. **Per-branch stock in Pricing Inquiry.** v1 expects `results[].stockInfo[{warehouse, warehouseQty}]` and also accepts `branchAvailableQuantity`. If neither is there, the v1 matrix shows zero stock everywhere. In that case, mirror how `fairbank-product-inquiry` builds `stock_info`.
3. ~~Eclipse SO Get bill-to field~~ Resolved: `generations[].billToId`.
4. **Eclipse Customer Get field names** (address fields, `isBillTo`, `isShipTo`, `homeBranch` and `defaultPriceClass` are confirmed via customer-addresses; `defaultShipVia`, `defaultTerms`, `defaultPoNumber`, `defaultReleaseNumber` and `salesSourceOverride` exist as plain strings in the Epicor customer data profile (`fairbank_offboarding_docs/Epicor data profiles/customers/distinct_values/`; `defaultReleaseNumber` had no values on any customer there); still unverified against a live GET: `outsideSalesperson`, `isBillTo`, `isShipTo`, `addressLine1`, `countryCode`). These come from the node's create fields, not a live response.
5. ~~SO Create response id~~ Resolved (2026-10-17, from a live create of S2737687): Eclipse wraps the created order as `{ results: [order] }`; `results[0].id` is `"S2737687"` and `results[0].generations[0].generationId` is `1`. `Check order` now unwraps `results[0]` (it read the top level before, so it would have reported "returned no order id" on a successful create) and builds `e_sorder_id` `S2737687.0001`. The same response showed `salesSource: "TERR38"`, `termsCode: "NET30D"`, `shipVia: ""` and `releaseNumber: ""` on the generation. Line 1 (product 106331, display UOM `FT`) also got an Eclipse comment `Requested QTY: 200 UOM: ea` (UNVERIFIED why; likely the `um` the page sends not matching the product's UOM).
6. **Gen-scoped line item calls.** The Eclipse node's Create Line Items, Delete Line Items and Update Qty use `/SalesOrders/S…​.NNNN/...`. The old function used the base OID plus a `generationId` query param. Update Qty now also sends `um`.
7. **Create Shipment `generationId`.** The node always sends the `generationId` query param, empty here. The old function omitted it.
8. **Line UM** on new orders defaults to `ea` / 1, as in the reference script. The page does not know product UMs.
10. **Freight in on create.** create-order sends the page's freight in as `freightCharges`; whether Eclipse takes it, and as freight in or freight out, is unconfirmed (see create-order).
9. **Multiple ship-tos in `e_ship_to_ids`.** Only single-id values have been seen; the page splits on `;`, `,` or whitespace.

## Open TODOs


- Confirm what Eclipse print status codes `N`, `Q`, `H`, `P`, `A` mean, then show labels instead of the codes.
- `update-bid.json` and `cancel-order.json` were regenerated with no behaviour change; re-import only if n8n's copies drifted.

- Set the real password hash in `docs/auth.js`.
- Import and activate the flows, then run the GET checks (`user`, `customer`, `order?e_sorder_id=`) and test the POST flows (create-order, update-bid, cancel-order) on a throwaway order.
- Point the HubSpot customer card link at `/order-placement/?e_customer_id=…`.
- Set up the DNS and custom domain for `sales.fairbankequipment.com`.
- Replace `auth.js` with Microsoft login.
