# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-11-11

### Fixed

- npm package page now uses the English `README.md`; the Chinese translation
  moved to `docs/README.zh.md` so npm does not pick it as the package readme.

### Added

- Release workflow publishes through npm trusted publishing (GitHub Actions
  OIDC) on `v*` tags, with a tag/version consistency check.

## [0.1.0] - 2026-11-11

### Added

- Left sidebar `Disk & workspaces` entry and main panel.
- Volume overview: free/total/used per backing volume, with warning and
  critical thresholds and per-volume alert muting.
- Per-Workspace `du` scan of top-level folders, 60s cache, timeout and busy
  handling, symlinked Workspace support.
- Guarded cleanup: dry-run validation, inline confirmation, allow-listed
  build artifacts moved to the macOS Trash via `/usr/bin/trash`, with
  workspace-local fallback, audit log and restore.
- Agent hand-off: build a Markdown snapshot and start a new session with the
  prompt prefilled; copy the snapshot to the clipboard.
- Host watchdog sampling `statfs` every 60 seconds with dual thresholds
  (ratio + absolute free space), hysteresis, per-volume cooldown, sidebar
  warning dot and Web Notification alerts.
- Panel settings persisted in `$DSH_HOME/dev-panel/settings.json`, audit log in
  `cleanup-audit.jsonl`, hourly trend samples in `history.jsonl`.
