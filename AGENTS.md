# AGENTS.md

## Start here

Read [HANDOFF.md](HANDOFF.md) first. It describes what this project does, how it is structured, the API it talks to, and the conventions the code follows.

## Rules

- **Do not run a preview.** Do not start the dev server, open the Browser pane, or take screenshots of the page. The user tests the UI themselves.
- **GET requests are allowed** for testing, for example with `curl`:
  - `https://n8n.fairbankequipment.com/webhook/outlook-dash?request=info`
  - `https://n8n.fairbankequipment.com/webhook/outlook-dash?request=settings`
- **Do not send POST requests** to the webhook. A POST overwrites the live sync settings in production.
- Keep the existing navy and gold colour scheme, the Barlow and Barlow Condensed fonts, and the visual style unless the user asks otherwise.