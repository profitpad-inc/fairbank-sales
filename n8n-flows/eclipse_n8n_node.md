# Eclipse n8n Node — AI Agent Reference

This document explains the `@profitpad-inc/n8n-nodes-eclipse` package: an n8n
community node integration for the **Epicor Eclipse API**, a distribution
ERP system. It is written for an AI agent that needs to build, edit, or
reason about n8n workflows using this node, or that will use the node
directly as an AI Agent tool inside n8n (the action node declares
`usableAsTool: true`).

## What this package provides

Two node types, both requiring the same `Epicor Eclipse` credential:

1. **Epicor Eclipse** (`eclipseApi`) — an action node with a
   resource/operation model. Used to read, create, and update records in
   Eclipse.
2. **Epicor Eclipse Trigger** (`eclipseApiTrigger`) — a polling trigger node
   that starts a workflow when new or updated Eclipse records are found.

## Authentication

Eclipse does not use a static API key. The credential stores:

- **Base URL** — root of the Eclipse API instance (e.g.
  `https://your-instance.epicoreclipse.com`)
- **Username** / **Password**

At the start of every execution or poll, the node calls `POST /Sessions`
with the username/password to obtain a `sessionToken`, then sends that
token as a plain `sessionToken` header (not `Authorization: Bearer`) on
every subsequent request. This happens automatically — an agent building a
workflow never sets the session token manually, it only fills in the
credential once.

## Resource / Operation model (action node)

The action node's parameters are always **Resource** then **Operation**,
which determine which other fields appear.

### Resource: Contact
- **Get** — retrieve a single contact by ID
- **Get Many** — list contacts, with filtering and pagination
- **Create** — create a contact (form fields, or a raw JSON body via
  "Input Mode: JSON")
- **Update** — update a contact (fetches the existing record first, merges
  in changes, so it behaves like a partial update even though the
  underlying API call is a full PUT)
- **Delete**

### Resource: Customer
- **Get**, **Get Many**, **Create**, **Update** (same GET-then-merge
  pattern as Contact), **Delete**
- Create/Update support a "Clear Fields" multi-select to explicitly null
  out or empty specific fields (needed because omitting a field just
  leaves the existing value unchanged, since the body is built from the
  fetched record).

### Resource: Product
- **Get** — retrieve a single product by ID
- **Get Many** — list products, with filtering and pagination
- **Product Inventory Pricing Inquiry** — given a Customer ID + one or more
  Product IDs (comma-separated), returns combined inventory and pricing
  data for every product. This operation fires three parallel Eclipse
  "mass inquiry" API calls internally — an inventory-pricing inquiry, a
  single-unit pricing inquiry, and a large-quantity pricing inquiry — and
  merges them per product, because no single Eclipse endpoint returns both
  quantity breaks and the correct first-unit price in one call. All
  requested Product IDs are sent on every call as repeated `ProductId`
  query params (`?ProductId=1&ProductId=2&...`). The operation always
  paginates using a **Page Size** field (default and maximum 100, matching
  Eclipse's own cap on this endpoint) — it loops, advancing the start index
  by the page size, stopping once a page comes back with fewer results than
  the page size, or once `startIndex + pageSize` would exceed the
  response's `totalItems` count (whichever comes first). Independently of
  page size, if more than 100 Product IDs are
  supplied, they're automatically split into batches of 100 (Eclipse's
  query string 404s somewhere above ~119 `ProductId` params, regardless of
  page size), each batch paginated the same way, transparent to the agent
  building the workflow. A **Return All Mode** field controls how the
  fetched pages/results are shaped into output items: `Each Page as 1 Item`
  (default) keeps today's behavior, one output item per API page/batch
  with that page's metadata; `All Results as 1 Item` combines every result
  across every page and batch into a single output item, with `metadata`
  as an array holding every page's metadata (not just the last one);
  `Each Result as 1 Item` emits one output item per individual product
  result, with no metadata envelope at all.

### Resource: Sales Order
The largest resource, with many operations:
- **Get**, **Get Many** (see batching note below), **Create**
- **Create Shipment** — creates a shipment for an order
- **Create Line Items**, **Update Line Items Price**, **Update Line Items
  Quantity**, **Delete Line Items** — sub-resource operations on a sales
  order's line items
- **Get Order Change Log**
- **Update Status**, **Update Internal Notes**, **Update PO Number**,
  **Update Ship Date**, **Update Ship Via**, **Update Shipping
  Instructions** — targeted single-field updates on an existing order,
  each its own lightweight PUT rather than a full record update

**Sales Order ID format**: IDs are composite,
`<orderNumber>.<generationId>` (e.g. `S2680001.0001`). Most fields that
take a sales order ID accept this full dotted form and pass it straight
through in the URL path. A few operations (`updateStatus`,
`updateInternalNotes`) split it internally into separate `orderId` /
`generationId` values because the underlying API wants them as separate
fields — this split happens automatically in the node, an agent filling in
the parameter just needs to supply the full dotted ID.

## Create / Update: two input modes

Contact Create/Update, Customer Create/Update, and Sales Order Create all
offer an **Input Mode** choice:
- **Fields** — structured UI fields for common properties
- **JSON** — a raw JSON object (or array, for line item operations) sent
  as the request body. Use this when the target fields aren't covered by
  the structured UI, or when composing the body from upstream workflow
  data is easier as a single JSON expression.

When filling these nodes via workflow expressions (e.g.
`={{ $json.someField }}`) rather than typing a literal value, note that
n8n passes through the native resolved type. Numeric-looking upstream
values become JS numbers even in fields typed as "string," and object/array
upstream values are passed through directly to JSON-typed fields rather
than as a JSON string. The node handles this internally — no special
escaping or `.toJsonString()` is needed in expressions feeding into it.

## Get Many: pagination, filtering, and field selection

Every "Get Many" operation (Contact, Customer, Product, Sales Order) shares
a common shape:
- **Return All** toggle, or manual **Page Size** + **Start Index**
- **Fields to Return**: `All Fields`, `Selected Fields` (comma-separated,
  supports dot notation for nested paths, e.g. `prices.unitPrice`), or
  `All Fields Except` (comma-separated exclusion list). `id` is always
  included when using "Selected Fields" and can't be excluded with "All
  Fields Except".
- An **Additional Options** collection with resource-specific filters
  (ID, keyword, date filters, and for Sales Order: BillTo, ShipTo,
  ShipBranch, PriceBranch, ShipVia, salesperson fields, Order Status,
  sort order, etc.)
- When **Return All** is on, a **Return All Mode** field controls how the
  fetched pages are shaped into output items: `Each Page as 1 Item`
  (default) — one output item per page, unchanged from prior behavior;
  `All Results as 1 Item` — every result across every page combined into a
  single output item, with `metadata` as an array holding every page's
  metadata; `Each Result as 1 Item` — one output item per individual
  record, with no metadata envelope. This mirrors the same `returnAllMode`
  field already used in the `n8n-nodes-hubspot` and
  `n8n-nodes-microsoft-outlook` packages. Note: for **Product** Get Many
  with more than 200 IDs, and **Sales Order** Get Many with more than 100
  IDs, the dedicated ID-batching paths described below are unaffected by
  this setting — they always combine everything themselves regardless of
  Return All or Return All Mode.

**Large ID lists get auto-batched**, transparent to the agent building the
workflow:
- **Product** Get Many: if the ID filter has more than 200 comma-separated
  IDs, requests are split into 200-ID batches and all batches are fetched
  regardless of the Return All setting.
- **Sales Order** Get Many: if the ID filter has more than 100 IDs, the
  list is split into 100-ID batches and paged as needed. In this batched
  path only, output items drop Eclipse's normal response envelope and are
  shaped as `{ countItems, results }` per Page-Size-sized chunk of the
  combined results (since a single batch's envelope wouldn't represent the
  combined total). This path also ignores Return All / Start Index, since
  the ID list itself bounds what can come back.

## Trigger node (Epicor Eclipse Trigger)

Polls one resource (Contact, Customer, Product, or Sales Order) on a
schedule and emits new/updated records since the last poll. Key behavior
an agent should know when configuring or reasoning about this node:

- **Rolling window mode** (default): looks back `pollInterval` minutes
  only on the very first-ever run. Every run after that uses the exact
  timestamp of the previous successful poll, so consecutive polls neither
  gap nor overlap results. A manual/test execution always uses
  `now - pollInterval` instead, since there's no meaningful "last run" to
  resume from.
- **Custom Date mode** (`Use Custom Date: true`): uses a fixed
  **Updated After** timestamp instead of a rolling window, and does not
  update any stored state between runs.
- Returns no output items (n8n's "nothing happened" convention) when a
  poll finds zero results — a downstream node connected to this trigger
  simply won't execute on that tick.
- Sales Order filtering on the trigger mirrors the action node's Get Many
  filters (BillTo, ShipTo, branches, salesperson, Order Status,
  date-range filters, sort). Contact/Customer/Product filtering is
  narrower: ID, keyword, and Start Index only.
- The trigger always filters by `updatedAfter` (Contact/Customer/Product)
  or `LastModifiedDateAndTimeStampStart` (Sales Order) — it is inherently
  an "updated since" poll, not a "created since" poll.

## Error handling

Every operation checks the HTTP status of write requests explicitly (the
underlying API sometimes returns non-2xx with a JSON error body rather
than throwing at the transport level) and raises a proper n8n
`NodeApiError`/`NodeOperationError` with the response body surfaced in the
error description. If the node's "Continue on Fail" setting is enabled,
a failed item produces an output item shaped `{ error, message }` instead
of stopping the workflow.

## Practical guidance for an agent composing workflows with this node

- Always resolve a Customer/Contact/Sales Order ID (via a prior Get/Get
  Many) before an Update or line-item operation — most Update operations
  fetch the current record first, so a nonexistent ID fails at that GET
  step with a clear error.
- For Sales Order operations, keep the full dotted ID
  (`orderNumber.generationId`) intact when passing it between nodes; do
  not attempt to split or reformat it manually.
- Prefer "Fields" input mode for straightforward single-record
  create/update; switch to "JSON" input mode when mapping a whole object
  from an upstream node (e.g. a CRM payload) is more natural than mapping
  each field individually.
- When building a Get Many with a large, dynamically-sized ID list (e.g.
  from a prior node's output), it's safe to join all IDs into one
  comma-separated string parameter — the node's internal batching handles
  request-size limits automatically.
