# @profitpad-inc/n8n-nodes-hubspot — Node Reference (v0.1.43)

Custom n8n community node package for HubSpot CRM. **Use these nodes instead
of the stock `n8n-nodes-base.hubspot` / `n8n-nodes-base.hubspotTrigger`** when
generating workflow JSON for HubSpot automation in this environment.

Package name: `@profitpad-inc/n8n-nodes-hubspot`

---

## 1. Node type identifiers

| Internal `name`     | Full `type` string in workflow JSON                         | `displayName`   | Kind    |
|----------------------|---------------------------------------------------------------|-----------------|---------|
| `hubspotApi`         | `@profitpad-inc/n8n-nodes-hubspot.hubspotApi`                  | HubSpot         | Action  |
| `hubspotApiTrigger`  | `@profitpad-inc/n8n-nodes-hubspot.hubspotApiTrigger`           | HubSpot Trigger | Trigger (polling) |

Both nodes are `typeVersion: 1`. Both declare `usableAsTool: true` (usable as an AI Agent tool).

---

## 2. Credential

- Type name: **`hubspotApi`** (displayName "HubSpot API")
- Fields:
  - `notes` (string, optional) — free-text notes, not sent in requests
  - `accessToken` (string, password, **required**) — HubSpot Private App access token
- Auth: sent as `Authorization: Bearer <accessToken>` header (generic auth)
- Reference in a node's JSON:
  ```json
  "credentials": {
    "hubspotApi": { "id": "<credential-id>", "name": "<credential-name>" }
  }
  ```

---

## 3. Action node: `hubspotApi` (displayName "HubSpot")

Top-level parameter `resource` (options): `associations` | `objects` | `owners` | `properties`.
Each resource has its own `operation` options list.

Shared conventions across many operations:
- **Pagination** (`list`, `search`): `returnAll` (boolean). When `true`, add `returnAllMode` (`allInOne` | `eachPage` | `eachResult`) and `maxPages` (number). When `false`, add `limit` (number).
- **Output Mode** (batch-read/batch-delete Fields mode): no `returnAll`/`limit`/`maxPages` — every supplied ID is processed, chunked to HubSpot's batch limit automatically, and an output-mode picker (`allInOne` | `eachPage` | `eachResult`, default `eachResult`) controls how results are emitted.
- **Rate limiting**: most operations expose `millisecondsBetweenItems` inside an "Additional Options" collection (default 50ms) — delay between processing input items.
- **Create/Update input mode**: many write operations expose `createInputMode` / `updateInputMode` = `ui` (guided Fields) or `json` (Custom JSON), switching which sibling parameters are used.
- **Object Type** (`objectType`, options, `noValidation`): one of 24 HubSpot CRM object type IDs, shared across Objects/Properties resources (Owners resource uses its own `users`/`owners` values):
  `0-48` Calls, `0-142` Carts, `0-18` Communications, `0-2` Companies, `0-1` Contacts, `0-721` Contracts, `0-3` Deals, `0-49` Emails, `0-53` Invoices, `0-136` Leads, `0-8` Line Items, `0-47` Meetings, `0-46` Notes, `0-123` Orders, `0-101` Payments, `0-116` Postal Mail, `0-7` Products, `0-970` Projects, `0-14` Quotes, `0-162` Services, `0-69` Subscriptions, `0-27` Tasks, `0-5` Tickets, `0-115` Users.
- Property pickers (`getWritableProperties`, `getAllProperties`, `getUniqueProperties`, etc.) are dynamic `loadOptions` dependent on `objectType` — in workflow JSON you supply the raw HubSpot internal property name string (e.g. `email`, `firstname`) regardless of whether the UI would show a dropdown.

### 3.1 Resource: Associations

Manages associations between two CRM object types. Requires `fromObjectType` and `toObjectType` (same 24-value object type list, minus Users) at the top level in addition to `operation`.

| Operation (value) | Description | Key parameters |
|---|---|---|
| **Batch Read** (`assocBatchRead`) | Read associations between records in bulk (batches of 1000; "from" IDs resolved in sub-batches of 100 first if using a lookup property) | `fromIds`: string — comma-separated IDs (or property values); `fromIdProperty`: string, optional — if set, resolves `fromIds` via that property instead of record ID first |
| **Batch Delete** (`assocBatchDelete`) | Delete associations in bulk (max 1000 inputs) | `assocBatchDeleteBody`: JSON — `{ inputs: [{ from: {id}, to: [{id}] }] }` |
| **Batch Create Default** (`assocBatchCreateDefault`) | Create default (unlabeled) associations in bulk (max 2000 inputs) | `assocBatchCreateDefaultBody`: JSON — `{ inputs: [{ from: {id}, to: {id} }] }` |
| **Batch Create Labeled** (`assocBatchCreateLabeled`) | Create labeled associations in bulk (max 2000 inputs) | `assocBatchCreateLabeledBody`: JSON — `{ inputs: [{ from: {id}, to: {id}, types: [{associationCategory, associationTypeId}] }] }` |
| **List Labels** (`assocReadLabels`) | Retrieve all association labels/type IDs between the two object types | none beyond `fromObjectType`/`toObjectType` |

### 3.2 Resource: Objects

Generic CRM object CRUD/search. Requires `objectType` at top level. `operation` options differ slightly: Contacts/Companies/Deals/Tickets (`0-1`,`0-2`,`0-3`,`0-5`) additionally get **Merge**; all other object types share the same list minus Merge.

| Operation (value) | Description | Key parameters |
|---|---|---|
| **Get** (`get`) | Retrieve one record by ID | `objectId`: string, required; `properties`: multiOptions/property-list; Additional Options: `associations` (object types to expand), `idProperty` (lookup by unique property instead of ID), `archived`: bool, `errorWhenNotFound`: bool (default true; false → returns `{objectFound:false}` on 404), `propertiesWithHistory`, `millisecondsBetweenItems` |
| **List** (`list`) | List records of the type | `returnAll`/`limit`/pagination options above; `properties`; Additional Options: `after` (cursor), `archived`, `associations`, `propertiesWithHistory`, `millisecondsBetweenItems` |
| **Create** (`create`) | Create one record | `createInputMode` (`ui`/`json`); UI mode: `createProperties.propertyValues[]` = `{name, value}` pairs (name via `getWritableProperties`); JSON mode: `createJson` (JSON object of properties); optional associations: UI mode `createAssociations.associationValues[]` = `{associationCategory, associationTypeIds[], toIdProperty?, toObjectId}` (auto-resolves `toObjectId` via `toIdProperty` lookup if set), JSON mode `createAssociationsJson` (raw array); Additional Options: `millisecondsBetweenItems` |
| **Update** (`update`) | Update one record by ID | `objectId`: string, required; `updateInputMode` (`ui`/`json`); UI: `updateFields.propertyValues[]`; JSON: `updateJson`; Additional Options: `idProperty` (match by unique property instead of ID), `millisecondsBetweenItems` |
| **Upsert** (`upsert`) | Create-or-update one record, matched on a unique property | `objectId`: string, required — the value to match on; `upsertIdProperty`: string, **required top-level field** (not an additional option) — unique property to match on (e.g. `email`); Record ID is deliberately not offered, and object types with no unique properties surface a single non-selectable "No Unique Properties Available" entry; `upsertInputMode` (`ui` default / `json`); UI: `upsertFields.propertyValues[]` = `{name, value}`; JSON: `upsertJson` (JSON object of properties); Additional Options: `millisecondsBetweenItems`. No single-record upsert endpoint exists, so this POSTs to `/batch/upsert` with one input and returns that one result unwrapped from the batch response. |
| **Delete** (`delete`) | Archive/delete one record by ID | `objectId`: string, required; Additional Options: `idProperty` (resolves real ID via GET first), `millisecondsBetweenItems` |
| **Search** (`search`) | Search with filters | `searchInputMode` (`ui`/`json`); UI: `filterGroupsUi` (guided AND/OR builder — see §3.5); JSON: `filterJson` (raw `{filterGroups}`); `properties`; `returnAll`/`limit`/pagination; Additional Options: `query` (free-text), `sortsUi`/`sortsJson`, `millisecondsBetweenItems`. Default sort if none given: `hs_lastmodifieddate` DESC |
| **Batch Read** (`batchRead`) | Read many records by ID | `batchReadInputMode` (`json` default, or `ui`); JSON: `batchReadBody` = `{inputs:[{id}], properties?, idProperty?}`; UI: `batchReadObjectIds` (comma-separated — every ID is read, chunked in batches of 100), `batchReadReturnAllMode` (displayName "Output Mode", always shown, `allInOne` \| `eachPage` \| `eachResult`, default `eachResult`), Additional Options `batchReadOptions`: `idProperty`, `properties`, `propertiesWithHistory`, `millisecondsBetweenItems`. There is no `returnAll`/`limit`/`maxPages` in Fields mode. |
| **Batch Create** (`batchCreate`) | Create many records | `batchCreateBody`: JSON — `{inputs:[{properties:{...}}]}` |
| **Batch Update** (`batchUpdate`) | Update many records | `batchUpdateBody`: JSON — `{inputs:[{id, properties:{...}}]}` |
| **Batch Upsert** (`batchUpsert`) | Create-or-update many records | `batchUpsertBody`: JSON — `{inputs:[{idProperty, id, properties:{...}}]}` |
| **Batch Delete** (`batchDelete`) | Archive many records | `batchDeleteInputMode` (`json` default, or `ui`); JSON: `batchDeleteBody` = `{inputs:[{id}]}` → outputs `{success:true}`; UI: `batchDeleteObjectIds` (comma-separated — every ID is deleted, chunked in batches of 100), `batchDeleteOutputMode` (`allInOne` \| `eachPage` \| `eachResult`, default `eachResult`), Additional Options `batchDeleteOptions`: `idProperty`, `millisecondsBetweenItems`. With `idProperty` set, each chunk is resolved to real record IDs via `/batch/read` first (the archive endpoint only accepts record IDs); unmatched values come back under `notFound` (`eachPage`/`allInOne`) or as `{success:false, id, objectFound:false}` items (`eachResult`) instead of being archived. |
| **Merge** (`merge`) — *Contacts/Companies/Deals/Tickets only* | Merge 2+ records into one surviving record (sequential merges) | `primaryObjectId`: string, required (surviving record); `objectIdsToMerge`: string, required — comma-separated secondary IDs, merged one at a time; `preserveFromPrimary`: multiOptions of property names — read from primary before merge and re-written after, so the primary's values aren't clobbered by the secondary; Additional Options: `millisecondsBetweenItems` |

### 3.3 Resource: Owners

`objectType` = `users` (HubSpot user records) or `owners` (read-only CRM owner assignment records). Operation list differs by `objectType`.

**objectType = `users`** — operations: Get, List, Search, Update
**objectType = `owners`** — operations: Get, List only (read-only)

| Operation (value) | Applies to | Description | Key parameters |
|---|---|---|---|
| **Get** (`get`) | users, owners | Retrieve one | `idProperty`: options, required — for `users`: `userId` (default) / `ownerId` (resolved via extra Owners API call) / `email`; for `owners`: `ownerId` (default) / `userId` / `email` (both looked up by paging Owners API). `objectId`: string, required — value for the chosen ID field. Additional Options: `errorWhenNotFound`, `millisecondsBetweenItems`, plus for users: `properties`, `propertiesWithHistory`; for owners: `archived` |
| **List** (`list`) | users, owners | List all | `returnAll`/pagination; Additional Options (`listOptions`): `after`, `millisecondsBetweenItems`, plus for users: `properties`, `propertiesWithHistory`; for owners: `archived` |
| **Search** (`search`) | users only | Search users with filters | `searchBody`: JSON — raw `{filterGroups, sorts}` (legacy raw-JSON style, not the Fields/JSON toggle used elsewhere); `returnAll`/pagination; Additional Options: `errorWhenNotFound`, `properties`, `propertiesWithHistory`, `millisecondsBetweenItems`. Throws if 0 results and `errorWhenNotFound` true. |
| **Update** (`update`) | users only | Update one user | `idProperty`, `objectId` (as in Get); `updateInputMode` (`ui`/`json`); UI: `updateFields.propertyValues[]` (property via `getWritableUserProperties`); JSON: `updateJson`; Additional Options: `millisecondsBetweenItems` |

Note: Get/List on `users` always includes `hs_internal_user_id`, `hs_searchable_calculated_name`, `hs_family_name`, `hs_given_name`, `hs_email` in the response regardless of the `properties` selection, and cross-links the linked Owner (`user.owner`) / linked User (`owner.user`) record automatically.

### 3.4 Resource: Properties

Manage CRM property definitions. Requires `objectType` at top level.

| Operation (value) | Description | Key parameters |
|---|---|---|
| **Get Property** (`getProperty`) | Get one property's full definition | `getPropertyName`: string, required — internal property name |
| **List Properties** (`listProperties`) | List all properties for the object type | none beyond `objectType` |
| **List Property Groups** (`listPropertyGroups`) | List property groups for the object type | none beyond `objectType` |
| **Update Property Label** (`updatePropertyLabel`) | Change a property's label/description | `propertyName`: string, required; `label`: string, required; Update Fields: `description` (optional) |
| **Update Dropdown Options** (`updateDropdownOptions`) | Add/remove/overwrite the option list of an enumeration (dropdown) property | `dropdownPropertyName`: string, required; `dropdownUpdateMode`: `add` \| `remove` \| `overwrite`; for `add`/`overwrite`: `dropdownOptions` JSON — `{options:[{displayOrder,hidden,label,value,description}]}` (add = merge/replace-by-value onto existing, overwrite = replace entire list); for `remove`: `removeOptionValues` string — comma-separated option values to strip |

### 3.5 Search Filter UI shape (Objects → Search, and Trigger)

The toggle parameter is `searchInputMode` (displayName "Search Filter Mode", default `ui`). When `searchInputMode = 'ui'`, filters are built via `filterGroupsUi`:
```json
{
  "groups": [
    {
      "filters": {
        "conditions": [
          { "propertyName": "email", "operator": "EQ", "value": "a@b.com" }
        ]
      }
    }
  ]
}
```
- Groups are OR'd together; conditions within a group's `filters.conditions` are AND'd.
- `operator`: HubSpot enum — `BETWEEN, CONTAINS_TOKEN, EQ, GT, GTE, HAS_PROPERTY, IN, LT, LTE, NEQ, NOT_CONTAINS_TOKEN, NOT_HAS_PROPERTY, NOT_IN`.
- `HAS_PROPERTY`/`NOT_HAS_PROPERTY` take no value.
- `IN`/`NOT_IN` values are semicolon-separated in the `value` field.
- `BETWEEN` uses `value` (low) + `highValue` (high).
- Property picker includes `associations.<objectTypeId>` pseudo-properties for filtering by an associated record's ID.

When `searchInputMode = 'json'`, use `filterJson` = `{ "filterGroups": [...] }` directly (HubSpot's native shape).

Sorts: `sortsUi.sortValues[]` = `{propertyName, direction: ASCENDING|DESCENDING}` (Fields mode) or `sortsJson` = `{"sorts":[...]}` (JSON mode). Default sort when none supplied: `hs_lastmodifieddate` DESCENDING.

---

## 4. Trigger node: `hubspotApiTrigger` (displayName "HubSpot Trigger")

Polling trigger — no input connection, one main output. Polls the HubSpot CRM Search API on the schedule set by the workflow's trigger/poll settings (standard n8n polling interval config, not a node parameter).

### Parameters

| Parameter | Type | Required | Purpose |
|---|---|---|---|
| `objectType` | options | yes | Which CRM object type to watch. Same 24-value list as the Objects resource (default `0-1` Contacts). |
| `triggerOn` | options | yes | `newOrUpdatedRecords` (default) / `newRecords` / `updatedRecords` / `propertyChanged` |
| `triggerProperties` | multiOptions | only if `triggerOn = propertyChanged` | Properties to watch; fires only when one of these actually changes value (verified via property history, not just `hs_lastmodifieddate` moving) |
| `searchInputMode`, `filterGroupsUi` / `filterJson` | — | no | Same Fields/JSON filter builder as Objects→Search (§3.5). Hidden when `triggerOn = propertyChanged` — for that mode, filters instead live inside `additionalOptions.searchFilters.filterConfig` (same shape) |
| `returnAllMode` | options | yes | `eachResult` (default, one item per record) or `allInOne` (all matched records combined into one output item) |
| `maxPages` | number | yes | Max search-result pages fetched per poll cycle (default 10; each page ≤200 records) |
| `properties` | multiOptions | no | Properties to include on returned records |
| `additionalOptions.sortsUi` / `sortsJson` | — | no | Same sort shape as §3.5 |
| `additionalOptions.searchFilters.filterConfig` | — | only for `propertyChanged` | Optional extra filters narrowing which changed records qualify |

### Behavior notes
- Injects an automatic time-based filter (`hs_createdate`/`hs_lastmodifieddate`, or unprefixed `createdate`/`lastmodifieddate` for Contacts) scoped to "since last poll" — only during real scheduled polling, not manual "fetch test event" runs (manual mode ignores the time window so users can validate filters against all matches).
- `newRecords` filters on create-date; `updatedRecords`/`newOrUpdatedRecords` filter on last-modified-date; `updatedRecords` additionally excludes records created within the same window (so "new" records aren't double-reported as "updated").
- `propertyChanged` mode: after the search narrows candidates (anything touched since last poll), each candidate is re-fetched via batch/read with `propertiesWithHistory` (chunks of 50) and kept only if one of `triggerProperties` changed within the poll window.

### Output shape
- `eachResult` mode: one `INodeExecutionData` per matched record, `json` = the raw HubSpot object (`{id, properties, ...}` for normal modes; `{id, properties, changedProperties: [{propertyName, value, timestamp}]}` for `propertyChanged` mode).
- `allInOne` mode: single item, `json = { results: [...] }`.
- Returns `null` (no output) when zero records match a poll cycle.

---

## 5. Differences from the stock n8n HubSpot node

Verified from this package's code (not speculative):

- **Universal object type coverage**: works against all 24 HubSpot CRM object types (including custom/less-common ones like Carts, Contracts, Leads, Postal Mail, Subscriptions, Projects) via a single generic Objects resource, rather than separate hardcoded resources per entity.
- **Guided AND/OR filter builder**: `filterGroupsUi` gives a structured UI for building `filterGroups` (with a type-aware operator dropdown that hides invalid operators per property type) as an alternative to hand-writing the raw HubSpot Search JSON body.
- **Association-aware filtering**: the search property picker exposes `associations.<objectTypeId>` pseudo-properties so a search can filter by an associated record's ID directly.
- **Lookup-by-property everywhere**: Get/Update/Delete/Batch Read/Batch Delete/Associations Batch Read all support an `idProperty` (e.g. `email`) to resolve records by a unique property instead of requiring the HubSpot record ID up front.
- **Single-record Upsert**: a one-record Upsert operation laid out like Update, matched on a unique property, implemented over HubSpot's batch upsert endpoint (which has no single-record equivalent) and returning the single result unwrapped.
- **Merge operation**: dedicated Merge operation for Contacts/Companies/Deals/Tickets that supports merging multiple secondary records sequentially into one primary, with an explicit "properties to preserve from primary" step to guard against the secondary's values overwriting the primary's during merge.
- **Owners + Users unified resource**: treats HubSpot's read-only Owners API and the CRM Users object as a single "Owners" resource, auto-cross-linking the corresponding User/Owner record in the response.
- **Property-changed trigger mode**: the trigger can fire only when specific selected properties change value (verified via property history), not just on any record touch — something the stock polling trigger does not offer.
- **Dropdown (enumeration) option management**: dedicated Properties operation to add/remove/overwrite a dropdown property's option list, including safe merge-by-value semantics for "add".
- **Batch operations across the board**: batch create/read/update/upsert/delete for objects, and batch create/read/delete for associations, with automatic chunking to HubSpot's API limits (100 for object batch read/archive, 1000–2000 for association batches). Batch Read and Batch Delete both offer a Fields mode that takes a plain comma-separated ID list instead of a hand-written JSON body, plus an output-mode control for per-record, per-batch, or single-item output.
- **Rate-limit pacing**: most operations expose a configurable delay between processed input items to help stay under HubSpot API rate limits.