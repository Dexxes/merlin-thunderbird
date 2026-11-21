# Merlin for Thunderbird

[![Merlin – Get the extension](store/get-extension-en.svg)](https://reviewers.addons.thunderbird.net/en-GB/thunderbird/addon/merlin/)

A Thunderbird add-on for saving links and pages to [Merlin](https://github.com/Dexxes/merlin-nextcloud), a
cross-platform read-it-later app backed by either a Nextcloud instance
([`merlin-nextcloud`](https://github.com/Dexxes/merlin-nextcloud/)) or an independent standalone server ([`merlin-standalone-server`](https://github.com/Dexxes/merlin-standalone-server)).

Save a link straight from an email — or the page you're currently viewing — to your
Merlin reading list via the context menu, optionally tagging it on the way in.

## Features

- **Save link / save page** from the right-click context menu, with or without tags
- **Save an email** itself as an article — from the message list (also several at once), from the context menu inside an open email, via the button in the message header, or with `Alt+Shift+M`, optionally with tags
- Tag dialog with existing tags as a tree (nested tags) that filters while you type
- Works against either backend: a Nextcloud instance running the Merlin app, or a
  [`merlin-standalone-server`](https://github.com/Dexxes/merlin-standalone-server)
- **Nextcloud Login Flow** support — connect without typing an app password by hand
- Credentials are stored locally (`storage.local`), not in plain text (AES-GCM with a
  random key stored in the same profile — the app password never appears as a readable
  string, but anyone with full access to the Thunderbird profile can decrypt it);
  never synced
- Desktop notifications report success or failure of each save
- Localized UI (English, German)

## Requirements

- Thunderbird 128 or later
- A reachable Merlin backend: either a Nextcloud instance with the [`merlin-nextcloud`](https://github.com/Dexxes/merlin-nextcloud/)
  app installed, or a [`merlin-standalone-server`](https://github.com/Dexxes/merlin-standalone-server) instance

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
| `common.js` | Shared helpers: credentials, URL checks, tag API, notifications |
| `crypto.js` | AES-GCM encryption for stored credentials |
| `options.html` / `options.js` | Settings UI: backend selection, login, connection test |
| `save-dialog.html` / `save-dialog.js` | Popup dialog for entering tags before saving |
| `i18n.js` | Localization helper |
| `_locales/` | Translated strings (`en`, `de`), generated from [`merlin-translations`](https://github.com/Dexxes/merlin-translations) (`python3 export.py --platform webext`) — never edit by hand |

## Notes

- Thunderbird's primary context-menu API is `browser.menus` (not `browser.contextMenus`,
  which only partially works in the message view) — see the comments in `background.js`.
- In tabs that show an email, the context menu offers "Send email content to Merlin"
  instead of "Save page"; the email is read via `browser.messages`, not page scripting.
- Several selected emails are saved as separate articles (at most 50 at a time).
- See `crypto.js` for what the credential encryption does and does not protect against.

## Development

```sh
npm install
npx playwright install chromium   # only needed once, for the page tests
npm test
```

The tests run the background script in a Node VM and the settings page and
save dialog in headless Chromium, each with a mocked WebExtension API, plus
static checks (icon sizes, translations, files in the `.xpi` build). They run
on every pull request (`.github/workflows/test.yml`). They don't replace a
quick check in a real Thunderbird ("Debug Add-ons → Load Temporary Add-on").

## License

AGPL-3.0-or-later — see [LICENSE](LICENSE).