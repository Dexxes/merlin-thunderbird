# Changelog

All notable changes to Merlin for Thunderbird are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning based on
[SemVer](https://semver.org/).

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


## [1.0.0]

Initial release.

### Added
- Save link and save page from the context menu, with or without tags
- Nextcloud Login Flow for credential setup without manual app-password entry
- AES-GCM encrypted local credential storage (no sync)
- Desktop notifications for save success/failure
- Localization (English, German)
