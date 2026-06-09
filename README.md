# Tactiq → Markdown export

A [Tampermonkey](https://www.tampermonkey.net/) userscript that adds a one‑click
**Download** button to every meeting row on [Tactiq](https://app.tactiq.io)
(both **Search** and **My Meetings**), and a bulk **Download** button when you
check off multiple meetings. It exports each transcript as a clean Markdown file
named:

```
YYYY-MM-DD - <meeting title>.md
```

## Why

Tactiq's built‑in "Export to TXT" requires drilling into each meeting and a
multi‑click menu, names files `MM_DD_YYYY ...`, and the output is one giant
run‑on blob. This script does it in one click, names files the way an Obsidian
vault wants, and produces nicely structured Markdown.

## What the output looks like

- Title heading (the redundant date prefix is stripped — the date lives in the
  details block).
- An Obsidian `[!info]` callout with **Date**, **Duration**, **Participants**,
  and a link back to the meeting in Tactiq.
- An optional `[!quote]` **Highlights** callout for any pinned lines.
- A `## Transcript` where **consecutive lines from the same speaker are merged**
  into one paragraph (Tactiq splits speech into hundreds of tiny fragments), with
  a bold `Speaker · time` label above each turn.

## Install

1. Install the **Tampermonkey** browser extension.
2. Open this raw link — Tampermonkey will offer to install it:
   <https://raw.githubusercontent.com/colby-makowsky/tactiq-md-export/main/tactiq-export-md.user.js>
3. Click **Install**.
4. Reload `app.tactiq.io`. A download icon appears on each row.

## Updates

The script declares `@updateURL` / `@downloadURL` pointing at this repo's raw
file. Tampermonkey checks for updates on its own schedule (or on demand via
**Dashboard → Utilities → Check for userscript updates**) and pulls any version
where `@version` is higher than what's installed. So: bump `@version`, push, and
your browser picks it up.

## How it works

- The transcript is fetched from Tactiq's GraphQL API
  (`meetingWithTranscript`), then formatted to Markdown in the browser.
- Auth uses your **existing Tactiq session** — the script reads the bearer token
  from the app's own API calls (by wrapping `fetch`). It never stores or
  transmits credentials anywhere; nothing sensitive is in this file.

## Notes

- Bulk download triggers Chrome's "Download multiple files?" prompt once — click
  **Allow**.
- If a download says "No auth token captured yet," reload the page once so the
  script can observe one API call first.
- Files always land in your browser's Downloads folder (browsers can't choose a
  per‑download destination).
