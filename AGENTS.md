# AGENTS.md

## Start here

Read [HANDOFF.md](HANDOFF.md) first. It describes what this project does, how it is structured, the APIs it talks to, and the conventions the code follows.

## Rules

- **Always update HANDOFF.md as you write.** Every change to a page, flow, endpoint, payload, or open question gets reflected in HANDOFF.md in the same session, not at the end.
- **Only use preview when the user explicitly mentions it** (user, 2026-10-19): you may serve `docs/` locally and check pages in the Browser pane. Never click Place, Update or Cancel there.
- **GET requests are allowed** for testing, for example with `curl`:
  - `https://n8n.fairbankequipment.com/webhook/outlook-dash?request=info`
  - `https://n8n.fairbankequipment.com/webhook/outlook-dash?request=settings`
  - `https://n8n.fairbankequipment.com/webhook/e-order-placement/user?e_user_id=...`
  - `https://n8n.fairbankequipment.com/webhook/e-order-placement/customer?e_customer_id=60623`
  - `https://n8n.fairbankequipment.com/webhook/e-order-placement/quote?e_sorder_id=S2735877.0001`
  - `https://n8n.fairbankequipment.com/webhook/sales-outreach/customers` (needs a session token; without one it answers 401)
  - `https://n8n.fairbankequipment.com/webhook/sales-outreach/transcript?id=<AssemblyAI transcript id>` (needs a session token). Its partner `sales-outreach/transcribe` is a POST, so it is off limits; test the AssemblyAI steps with a manual n8n run instead.
  - `https://n8n.fairbankequipment.com/webhook/fairbank-product-inquiry?...` (customer search: `e_customer_name=<text>`; `e_customer_id` alone does not work)
- **Do not send POST, PUT, PATCH or DELETE requests** to any webhook. A POST to `outlook-dash` overwrites the live sync settings in production; a POST to `e-order-placement/*` or `update-hs-deal` writes to live Eclipse orders or HubSpot deals.
- Keep the existing navy and gold colour scheme, the Barlow and Barlow Condensed fonts, and the visual style unless the user asks otherwise.
- Don't ask me to commit/push, the user will say when they want to commit

## Where you can and can't write

- Yes: `n8n-flows/*`
- Yes: `docs/archive/order-placement-v1/*`
- Yes: `docs/order-placement/*`
- Yes: `docs/outlook-integration/*`
- Yes: `docs/product-lookup/*` (added 2026-10-23, on request)
- Yes: `docs/sales-outreach/*` (added 2026-10-29, on request)
- Yes: `docs/auth.js`, `README.md`, `HANDOFF.md`, `AGENTS.md`
- One line only: the `auth.js` script tag in `docs/index.html` and `docs/product-inquiry/index.html`
- No: `eclipse-branch-selector/*` (symlink to the original HubSpot project, read-only reference)
- No: anything else in `docs/product-inquiry/*`
