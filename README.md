# Merlin for Thunderbird

A Thunderbird add-on for saving links and pages to [Merlin](https://github.com/), a
cross-platform read-it-later app backed by either a Nextcloud instance
(`merlin-nextcloud`) or an independent standalone server (`merlin-server`).

Save a link straight from an email — or the page you're currently viewing — to your
Merlin reading list via the context menu, optionally tagging it on the way in.

## Features

- **Save link / save page** from the right-click context menu, with or without tags
- Works against either backend: a Nextcloud instance running the Merlin app, or a
  standalone `merlin-server`
- **Nextcloud Login Flow** support — connect without typing an app password by hand
- Credentials are stored locally (`storage.local`), encrypted at rest with AES-GCM;
  never synced
- Desktop notifications report success or failure of each save
- Localized UI (English, German)

## Requirements

- Thunderbird 115 or later
- A reachable Merlin backend: either a Nextcloud instance with the `merlin-nextcloud`
  app installed, or a `merlin-server` instance

## Installation

Install from the Thunderbird Add-ons site, or load unpacked for development:

1. Open Thunderbird → **Settings → Add-ons and Themes**
2. Gear icon → **Debug Add-ons** → **Load Temporary Add-on…**
3. Select `manifest.json` in this directory

## Setup

Open the add-on's settings page, choose your backend type (Nextcloud or standalone
server), enter the server URL, and either use **Login with Nextcloud** (Nextcloud
backend only) or test the connection directly.

## Architecture

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3, `browser.menus` permissions) |
| `background.js` | Context menu, save flow, Nextcloud Login Flow polling, notifications |
| `crypto.js` | AES-GCM encryption for stored credentials (shared design with `merlin-chrome`) |
| `options.html` / `options.js` | Settings UI: backend selection, login, connection test |
| `save-dialog.html` / `save-dialog.js` | Popup dialog for entering tags before saving |
| `i18n.js` | Localization helper |
| `_locales/` | Translated strings (`en`, `de`) |

## Notes

- Thunderbird's primary context-menu API is `browser.menus` (not `browser.contextMenus`,
  which only partially works in the message view) — see the comments in `background.js`.
- In mail tabs (message view, compose, folder list), page-content scripting is
  unavailable; saving a page there falls back to a URL-only save without full HTML
  capture.
- This extension shares its credential-encryption design with `merlin-chrome`; see
  `crypto.js` for details.

## License

AGPL-3.0-or-later — see [LICENSE](LICENSE).
