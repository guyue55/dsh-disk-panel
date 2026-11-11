# dsh-disk-panel

[![npm version](https://img.shields.io/npm/v/dsh-disk-panel)](https://www.npmjs.com/package/dsh-disk-panel)
[![npm downloads](https://img.shields.io/npm/dm/dsh-disk-panel)](https://www.npmjs.com/package/dsh-disk-panel)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-4d6bfe)](https://github.com/deepseek-ai/deepseek-harness)

A left sidebar disk panel for the DeepSeek Harness (DSH) Web UI: see free space
per volume, measure what each Workspace is using, move build artifacts to the
macOS Trash with an audit log and restore, hand a scan to an agent, and get a
low-space warning from a host-side watchdog.

English | [中文](README.zh.md)

## Features

- **Volume overview** — free/total/used per backing volume for `/`, the home
  directory and every registered Workspace; volumes backed by the same container
  are merged into one card. Warning at 20 GB / 10% free, critical at 5 GB / 5%
  (multi-terabyte volumes need half the ratio).
- **Workspace usage** — measure one Workspace on demand: the Host runs
  `du -kx -d 1` on the Workspace root (after `realpath`, so migrated projects
  that are symlinks work) and the panel lists the largest top-level folders,
  with a 60 second cache, a 30 second timeout and a busy error instead of
  queueing unbounded scans.
- **Guarded cleanup** — allow-listed build artifacts (`node_modules`, `dist`,
  `build`, `out`, `target`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`,
  `.parcel-cache`, `.cache`, `coverage`, `__pycache__`, `.pytest_cache`,
  `.mypy_cache`, `.ruff_cache`, `.nyc_output`, `.eslintcache`, `.vite`) can be
  moved to the macOS Trash. A dry-run validates the paths first, the panel shows
  an inline confirmation with the exact paths and sizes, and the Host re-validates
  before running `/usr/bin/trash -v`. Nothing is ever removed with `rm`.
- **Audit log and restore** — every real cleanup writes a JSONL entry with the
  Trash destination. The panel lists recent cleanups and can restore one with
  `rename` while the Trashed copy is still there.
- **Agent hand-off** — build a Markdown snapshot of a scan (volume free space,
  top-level folder sizes, measurement time) and start a new session with a
  prompt prefilled — nothing is sent automatically. The same snapshot can be
  copied to the clipboard.
- **Low-space watchdog** — the Host samples `statfs` every 60 seconds even when
  the page is closed, with hysteresis, a per-volume cooldown and per-volume
  mute. The sidebar icon shows a warning dot, and a new alert raises a Web
  Notification when the window is unfocused.
- **Settings and trend** — the panel edits the watchdog settings and shows the
  last 6 hours of free-space samples.

## Requirements

- **DSH 0.2.2-rc.1** (declared through `engines.dsh`).
- **Node.js 22 or newer.**
- **macOS 15 or newer** for the Trash cleanup (`/usr/bin/trash`). On Linux the
  panel, scan, trend and watchdog work, but the cleanup action is disabled
  because moving to the system Trash is only implemented on macOS. Scanning
  uses `du`, so Windows is not supported.

## Install

Inside the DSH desktop app: **Settings → Plugins**, install `dsh-disk-panel`
(or pass the same spec to the `plugin_manager` tool).

For a `dsh web` profile with the CLI:

```sh
dsh plugin --profile web add dsh-disk-panel
```

Replace `web` with your host's profile name, then restart the host (or let the
desktop app reload its plugins). Other install forms:

```sh
# straight from GitHub (no build step in this package)
dsh plugin --profile web add github:guyue55/dsh-disk-panel

# prebuilt tarball attached to a GitHub release
dsh plugin --profile web add https://github.com/guyue55/dsh-disk-panel/releases/latest/download/dsh-disk-panel.tgz
```

## Usage

Open the **Disk & workspaces** entry in the left sidebar. Expand a Workspace and
choose **Measure usage** to see its largest folders. Use the trash button next
to an allow-listed folder, confirm, then find the action under **Recent
cleanups** and restore it if needed. `Send to agent` starts a new session with
the scan already described in the prompt.

## Configuration

The panel's **Panel settings** card writes
`$DSH_HOME/dev-panel/settings.json`:

| Field | Default | Meaning |
| --- | --- | --- |
| `monitor` | `true` | Run the watchdog and raise alerts |
| `notify` | `true` | Raise Web Notifications |
| `warnRatio` / `warnFreeGB` | `0.10` / `20` | Warning thresholds (ratio or absolute free space) |
| `critRatio` / `critFreeGB` | `0.05` / `5` | Critical thresholds |
| `cooldownHours` | `6` | Per-volume, per-level alert cooldown |
| `ignoredVolumes` | `[]` | Volume keys whose alerts are muted |

The client also reads `localStorage['sidebar-panel.options']` for
`onlyWhenUnfocused` (default `true`) and `monitor` (a client-side mute).

Data written by the plugin, all under `$DSH_HOME/dev-panel/`:

- `settings.json` — watchdog settings.
- `cleanup-audit.jsonl` — cleanup and restore audit (append-only JSONL, pruned to the most recent 2000 entries over 512 KiB).
- `history.jsonl` — free-space samples, one per minute (pruned to the most recent 5000 samples over 2 MiB).

Multiple profiles or DSH instances that share the same `DSH_HOME` share these
files.

## Security and permissions

This plugin reads disk statistics and directory sizes and can move allow-listed
directories to the Trash. Its Host half registers routes under
`/dev-panel/api`:

- read-only routes: `overview`, `scan`, `watch`;
- token-gated routes: `config`, `audit`, `history`, `cleanup`, `restore`.

Mutating routes require a per-process capability token from the overview, pass
`ctx.connection.requestRejection()`, and also check same-origin headers. Cleanup
only accepts direct children of registered Workspaces, matching the allow-list,
that are not symlinks; the Host re-validates them before moving anything. The
routes are served by the local DSH Host; if you bind the webserver to a
non-loopback address, add your own access control.

## Limitations

- Cleanup is macOS-only; Linux and Windows can view and measure but not clean.
- `du` scans of very large or external-disk folders may hit the 30 second
  timeout; the panel reports it instead of a wrong size.
- Restore only works while the Trashed copy still exists and is reachable by the
  Host user; otherwise the panel tells you to restore it from Finder.
- Notifications use the browser Web Notification API: the desktop shell grants
  permission, a plain browser asks on the first gesture, and macOS may still
  block notifications at the system level.
- The watchdog raises alerts only for volumes that are not muted and has a six
  hour cooldown per volume and level.

## Development

No build step: the Host half is `index.js` and the browser half is `client.js`
(the `window.__ModuleLoader__` format). The package is plain JavaScript.

```sh
node --check index.js
node --check client.js
npm test          # manifest checks + headless client behaviour tests
```

| Path | Purpose |
| --- | --- |
| `index.js` | Host half: routes, `du`, Trash cleanup/restore, audit, watchdog |
| `client.js` | Browser half: sidebar icon, panel, notifications |
| `cordis.patch.yml` | Bundle patch inserting the plugin row |
| `locale/` | Plugin Manager title/description in English and Chinese |
| `test/` | Manifest checks and headless client tests (no browser required) |

## License

[MIT](LICENSE)
