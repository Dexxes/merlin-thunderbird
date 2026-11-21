# Changelog

All notable changes to Merlin for Thunderbird are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning based on
[SemVer](https://semver.org/).

## [1.2.0] - 2026-11-21

### Added
- In tabs that show an email, the context menu offers "Send email content to
  Merlin" (with or without tags) instead of "Save page", which had nothing to
  save there.
- Several selected emails are saved at once, each as its own article (at most
  50), with one summary notification.
- "Save email with tags…" in the message list.
- A button in the message header and the shortcut `Alt+Shift+M` save the
  displayed email (in the 3-pane window: the selected emails).
- Tests (`npm test`) and a GitHub workflow that runs them on pull requests.
- Nested tags (merlin-nextcloud): the "save with tags" dialog lists existing
  tags as an indented tree with sub-tags below their parent instead of a row
  of chips. Selecting a sub-tag also selects its parent tags; deselecting a
  tag also deselects its sub-tags. Servers without nested tags show a flat list.
- Typing in the tag field filters the existing tags by the tag currently being
  typed (the text after the last comma), ignoring case and accents; parent tags
  of a match stay visible, dimmed, for context. Picking a tag from the filtered
  list replaces the typed fragment, so it isn't saved as an extra new tag.
- The "save with tags" window is taller (640 px) and opens centered on the
  screen the Thunderbird window is on.
- Specific error message when the server refuses a site it cannot read
  (`unsupported_site`), and an honest message when tags could not be applied
  on a standalone server.
- Link to the source code on the settings page.

### Changed
- The add-on is now just called "Merlin".
- Settings: the URL field is a normal field prefilled with `https://` instead
  of a fixed prefix, so a full URL can be pasted. A pasted URL replaces the
  prefix instead of being appended to it, and a host name without a scheme is
  saved with `https://` in front. Plain `http://` is only accepted for
  `localhost` (local development).
- A single HTTP 401 no longer logs you out; credentials are cleared after the
  second consecutive 401.
- Page HTML is only sent up to 10 MB; larger pages are saved by URL only.
- Backend labels and all texts synced with merlin-translations.

### Fixed
- Saving now times out after 60 s (tag requests after 10 s) instead of
  waiting forever.
- Standalone server: tags are no longer re-created as duplicates when the tag
  list fails to load.
- Login Flow polling survives Thunderbird suspending the background page
  (`alarms` permission) and no longer leaves the settings page stuck on
  "complete login" after a timeout.
- Several tag dialogs can be open at once without overwriting each other;
  closing a dialog with the window's close button cleans up its pending entry.
- Extension icons now come in the sizes the manifest declares (16, 32, 48, 96
  and 128 px) instead of 32/192 px images.

### Security
- "Test connection" only uses the stored server URL and backend. If another
  URL was typed in, it asks for a new login instead of sending the app
  password to that URL.
- The pending tag-dialog entry no longer stores the app password in plain text
  in `storage.local`; the dialog reads the encrypted credentials itself.
- Login Flow responses are validated: the poll endpoint must be on the entered
  server, the login page must use `https://`, the returned credentials must be
  present, and the server URL in the response may not switch to another origin.
- The background script only accepts messages from the add-on's own pages.

### Internal
- Shared helpers (credentials, URL checks, tag API, notifications) moved to
  `common.js`; the unused in-page toast code was removed (Thunderbird always
  reports via desktop notifications).
- Code comments are now consistently in English.

## [1.1.1]

### Changed
- Improved translation

## [1.1.0]

### Added
- Save the current page from the context menu in content tabs (opened links,
  RSS articles), with or without tags — sends the rendered HTML along so
  paywalled/JS-rendered pages don't need a second server-side fetch. Works
  against both Nextcloud and `merlin-server`.
- Save an email itself as an article from the message-list context menu
  ("Mail an Merlin senden"), using the subject as the article title and the
  sender as the author
  - Support for `merlin-server` as an alternative backend to Nextcloud, with a
  backend-type toggle in the settings UI
- Tag resolution against the standalone server's `/api/tags` endpoint

### Changed
- `messagesRead` permission added (required to read email content for the new mail-save feature)

### Security
- Explicit `content_security_policy` declared in `manifest.json` instead of relying on the implicit MV3 default
- Save dialog status/empty messages now built via DOM APIs instead of `innerHTML`
- Tag input capped at 100 characters per tag / 50 tags


## [1.0.0]

Initial release.

### Added
- Save link and save page from the context menu, with or without tags
- Nextcloud Login Flow for credential setup without manual app-password entry
- AES-GCM encrypted local credential storage (no sync)
- Desktop notifications for save success/failure
- Localization (English, German)
