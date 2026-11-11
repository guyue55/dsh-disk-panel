/**
 * Host half of the sidebar-panel bundle: a read-only disk overview, an on-demand
 * `du` scan, and a guarded "move regenerable folders to Trash" action.
 *
 * Route contract (served by the plugin's own Host, not the shared /api bridge):
 *
 *   GET  /dev-panel/api/overview        volumes, workspaces, cleanup policy, token
 *   GET  /dev-panel/api/scan?path=…     `du` of one Workspace's direct children
 *   POST /dev-panel/api/cleanup         move allow-listed Workspace children to Trash
 *
 * Safety: the token in the overview response plus a same-origin check gate the
 * only mutating route; cleanup paths must be canonical direct children of a
 * registered Workspace, must not be symlinks, and must match a fixed allow-list
 * of regenerable directory names. Nothing is ever removed with `rm`.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, lstat, mkdir, readFile, realpath, rename, stat, statfs, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const API_PREFIX = '/dev-panel/api'
const SCAN_TIMEOUT_MS = 30_000
const SCAN_MAX_BUFFER = 8 * 1024 * 1024
const SCAN_CACHE_MS = 60_000
const SCAN_TOP_ENTRIES = 8
const CLEANUP_TIMEOUT_MS = 30_000
const CLEANUP_MAX_BODY = 64 * 1024
const CLEANUP_MAX_PATHS = 20
const WATCH_INTERVAL_MS = 60_000
const SETTINGS_FILE = 'settings.json'
const AUDIT_FILE = 'cleanup-audit.jsonl'
const SETTINGS_VERSION = 1

const DEFAULT_SETTINGS = {
  monitor: true,
  notify: true,
  warnRatio: 0.1,
  warnFreeGB: 20,
  critRatio: 0.05,
  critFreeGB: 5,
  cooldownHours: 6,
  ignoredVolumes: [],
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** @param {unknown} candidate */
function sanitizeSettings(candidate) {
  const input = candidate !== null && typeof candidate === 'object' ? candidate : {}
  const source = input && 'settings' in input && typeof input.settings === 'object' ? input.settings : input
  return {
    monitor: source && typeof source.monitor === 'boolean' ? source.monitor : true,
    notify: source && typeof source.notify === 'boolean' ? source.notify : true,
    warnRatio: clampNumber(source && source.warnRatio, 0.1, 0.01, 0.9),
    warnFreeGB: clampNumber(source && source.warnFreeGB, 20, 0, 1024),
    critRatio: clampNumber(source && source.critRatio, 0.05, 0.01, 0.9),
    critFreeGB: clampNumber(source && source.critFreeGB, 5, 0, 1024),
    cooldownHours: clampNumber(source && source.cooldownHours, 6, 0.1, 720),
    ignoredVolumes: Array.isArray(source && source.ignoredVolumes)
      ? source.ignoredVolumes.filter((key) => typeof key === 'string' && key.length > 0 && key.length < 64).slice(0, 32)
      : [],
  }
}

/**
 * Direct children of a Workspace that this plugin may move to Trash. Everything
 * here is a build artifact, dependency tree, or tool cache that a normal
 * install/build regenerates; user data, `.env`, and release output beyond these
 * names are never touched.
 */
const CLEANUP_ALLOWLIST = new Set([
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.cache',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.nyc_output',
  '.eslintcache',
  '.vite',
])

export const inject = ['webServer', 'workspaceRegistry']

/** @param {unknown} body @param {number} [status] */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** @param {string} path */
async function readVolume(path) {
  try {
    const stats = await statfs(path)
    const block = Number(stats.bsize)
    const total = Number(stats.blocks) * block
    const free = Number(stats.bavail) * block
    return { total, free, used: Math.max(0, total - free) }
  } catch {
    return undefined
  }
}

/** @param {string} path @param {string} home @param {Map<string, string>} titleByPath */
function labelOf(path, home, titleByPath) {
  if (path === '/') return { kind: 'root', text: '系统盘' }
  if (path === home) return { kind: 'home', text: '主目录' }
  return { kind: 'workspace', text: titleByPath.get(path) ?? path }
}

/**
 * `du -kx -d 1` lines: "<kib>\t<path>". The first line is the root itself.
 * @param {string} stdout @param {string} root
 */
function parseDu(stdout, root) {
  /** @type {{ path: string, name: string, size: number }[]} */
  const children = []
  let total = 0
  for (const line of stdout.split('\n')) {
    const match = /^(\d+)\s+(.+)$/.exec(line.trim())
    if (match === null) continue
    const size = Number(match[1]) * 1024
    const path = match[2]
    if (path === root) {
      total = size
      continue
    }
    children.push({ path, name: basename(path), size })
  }
  children.sort((left, right) => right.size - left.size)
  const top = children.slice(0, SCAN_TOP_ENTRIES)
  const rest = children.slice(SCAN_TOP_ENTRIES)
  return {
    total,
    entries: top,
    rest: {
      count: rest.length,
      size: rest.reduce((sum, entry) => sum + entry.size, 0),
    },
  }
}

/** @param {string | undefined} detail */
function destinationOf(detail) {
  if (typeof detail !== 'string') return undefined
  const match = /to\s+"([^"]+)"/.exec(detail)
  return match === null ? undefined : match[1]
}

/**
 * Move one directory to the system Trash.
 *
 * Preference order, never falling back to `rm`:
 *   1. `/usr/bin/trash` (Apple's own CLI, macOS 15+; also finds a PATH `trash`);
 *   2. `macos-trash` from Homebrew;
 *   3. a workspace-local `.dsh-clean-trash/<timestamp>/` rename (same volume,
 *      restorable by moving the folder back), for systems without either CLI.
 *
 * The original path is re-checked afterwards: a "successful" command that left
 * the directory in place is reported as a failure.
 *
 * @param {string} path
 * @param {string} workspacePath
 */
async function moveToTrash(path, workspacePath) {
  const attempts = []
  const run = async (command, args) => {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: CLEANUP_TIMEOUT_MS, encoding: 'utf8' })
    return `${stdout ?? ''}${stderr ?? ''}`.trim()
  }
  try {
    const detail = await run('/usr/bin/trash', ['-v', path])
    return { ok: true, method: 'trash', ...(detail.length > 0 ? { detail } : {}) }
  } catch (error) {
    attempts.push(error instanceof Error ? error.message : String(error))
  }
  try {
    const detail = await run('macos-trash', [path])
    return { ok: true, method: 'macos-trash', ...(detail.length > 0 ? { detail } : {}) }
  } catch (error) {
    attempts.push(error instanceof Error ? error.message : String(error))
  }
  try {
    const destination = join(workspacePath, '.dsh-clean-trash', String(Date.now()))
    await mkdir(destination, { recursive: true })
    const target = join(destination, basename(path))
    await rename(path, target)
    try {
      await lstat(path)
      return { ok: false, error: `move completed but the source still exists: ${path}` }
    } catch {
      return { ok: true, method: 'workspace-trash', detail: `moved to "${target}"` }
    }
  } catch (error) {
    attempts.push(error instanceof Error ? error.message : String(error))
  }
  return { ok: false, error: attempts.join(' / ') }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  /** @type {Map<string, { at: number, value: unknown }>} */
  const scanCache = new Map()
  let scansInFlight = 0
  const MAX_CONCURRENT_SCANS = 2
  const dataDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dev-panel')
  const settingsPath = join(dataDir, SETTINGS_FILE)
  const auditPath = join(dataDir, AUDIT_FILE)
  const historyPath = join(dataDir, 'history.jsonl')
  /** @type {{ at: number, volumes: { key: string, free: number, total: number }[] }[]} */
  let history = []

  const loadHistory = async () => {
    try {
      const raw = await readFile(historyPath, 'utf8')
      const cutoff = Date.now() - 7 * 24 * 3600_000
      history = raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return undefined
          }
        })
        .filter((sample) => sample !== undefined && sample.at >= cutoff && Array.isArray(sample.volumes))
        .slice(-5000)
    } catch {
      history = []
    }
  }

  const appendHistory = async (sample) => {
    history.push(sample)
    if (history.length > 5000) history = history.slice(-5000)
    try {
      await mkdir(dataDir, { recursive: true })
      await appendFile(historyPath, `${JSON.stringify(sample)}\n`, 'utf8')
      void pruneJsonl(historyPath, 2 * 1024 * 1024, 5000)
    } catch {
      // History is best-effort.
    }
  }
  let settings = { ...DEFAULT_SETTINGS, version: SETTINGS_VERSION }

  const loadSettings = async () => {
    try {
      const raw = await readFile(settingsPath, 'utf8')
      settings = { ...sanitizeSettings(JSON.parse(raw)), version: SETTINGS_VERSION }
    } catch {
      // First run or unreadable file: keep defaults, do not create anything yet.
    }
  }

  const persistSettings = async (candidate) => {
    const next = { ...sanitizeSettings(candidate), version: SETTINGS_VERSION }
    await mkdir(dataDir, { recursive: true })
    await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    settings = next
    return next
  }

  const appendAudit = async (entry) => {
    try {
      await mkdir(dataDir, { recursive: true })
      await appendFile(auditPath, `${JSON.stringify(entry)}\n`, 'utf8')
      void pruneJsonl(auditPath, 512 * 1024, 2000)
    } catch {
      // Auditing must never fail the action itself.
    }
  }

  const pruneJsonl = async (path, maxBytes, keepLines) => {
    try {
      const info = await stat(path)
      if (info.size <= maxBytes) return
      const raw = await readFile(path, 'utf8')
      const lines = raw.split('\n').filter((line) => line.trim().length > 0)
      await writeFile(path, `${lines.slice(-keepLines).join('\n')}\n`, 'utf8')
    } catch {
      // Pruning is best-effort.
    }
  }

  const readAudit = async (limit) => {
    try {
      const raw = await readFile(auditPath, 'utf8')
      return raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .slice(-limit)
        .reverse()
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return undefined
          }
        })
        .filter((entry) => entry !== undefined)
    } catch {
      return []
    }
  }
  /** Per-process capability token; the overview hands it to the panel. */
  const token = randomUUID()
  let cleanupBusy = false

  void loadSettings()
  void loadHistory()

  const listWorkspaces = () => {
    /** @type {{ id: string, title: string, path: string }[]} */
    const workspaces = []
    for (const workspace of ctx.workspaceRegistry.list()) {
      const path = String(workspace.path)
      workspaces.push({ id: String(workspace.id), path, title: String(workspace.title ?? path) })
    }
    return workspaces
  }

  /** @returns {Promise<Map<string, { id: string, title: string, path: string }>>} */
  const canonicalRoots = async () => {
    const roots = new Map()
    for (const workspace of listWorkspaces()) {
      roots.set(await realpath(workspace.path).catch(() => workspace.path), workspace)
    }
    return roots
  }

  /**
   * Volumes relevant to this machine: root, home, and every registered
   * Workspace, deduped by backing volume (same total + same free space).
   */
  const collectVolumes = async () => {
    const home = homedir()
    const workspaces = listWorkspaces()
    const titleByPath = new Map(workspaces.map((workspace) => [workspace.path, workspace.title]))

    /** @type {string[]} */
    const candidates = ['/', home, ...workspaces.map((workspace) => workspace.path)]
    const seenPaths = new Set()
    /** @type {Map<string, any>} */
    const volumes = new Map()
    /** @type {Map<string, string>} */
    const keyByPath = new Map()

    for (const path of candidates) {
      if (seenPaths.has(path)) continue
      seenPaths.add(path)
      const volume = await readVolume(path)
      if (volume === undefined) continue
      // One card per backing volume. Using the total capacity as the identity
      // keeps macOS `/` and `/System/Volumes/Data` (same container) together;
      // free space cannot be part of the key because two statfs calls taken
      // moments apart may differ by a few blocks.
      const key = `${volume.total}`
      keyByPath.set(path, key)
      const existing = volumes.get(key)
      if (existing === undefined) {
        volumes.set(key, {
          key,
          labels: [labelOf(path, home, titleByPath)],
          paths: [path],
          total: volume.total,
          free: volume.free,
          used: volume.used,
        })
      } else {
        existing.labels.push(labelOf(path, home, titleByPath))
        existing.paths.push(path)
      }
    }

    return { volumes: [...volumes.values()], keyByPath, workspaces }
  }

  const overview = async () => {
    const home = homedir()
    const { volumes, keyByPath, workspaces } = await collectVolumes()

    return {
      home,
      platform: process.platform,
      generatedAt: Date.now(),
      token,
      cleanup: { canTrash: process.platform === 'darwin', allowlist: [...CLEANUP_ALLOWLIST] },
      volumes,
      workspaces: workspaces.map((workspace) => ({
        ...workspace,
        volumeKey: keyByPath.get(workspace.path) ?? null,
      })),
    }
  }

  /** @param {string} requested */
  const scan = async (requested) => {
    if (process.platform === 'win32') {
      return { ok: false, error: { code: 'unsupported', message: 'Directory scanning is not supported on Windows.' } }
    }
    // Workspace paths are canonical on disk, but a Workspace may still be a
    // symlink (for example a project moved onto a mounted APFS image). Resolve
    // both sides so `du` measures the real directory instead of the link.
    const roots = await canonicalRoots()
    const canonical = await realpath(resolve(requested)).catch(() => undefined)
    if (canonical === undefined || !roots.has(canonical)) {
      return { ok: false, error: { code: 'not-a-workspace', message: 'The path is not a registered Workspace.' } }
    }
    const target = canonical
    const cached = scanCache.get(target)
    if (cached !== undefined && Date.now() - cached.at < SCAN_CACHE_MS) {
      return { ok: true, cached: true, ...cached.value }
    }

    if (scansInFlight >= MAX_CONCURRENT_SCANS) {
      return { ok: false, error: { code: 'busy', message: 'Too many scans are running; try again in a moment.' } }
    }
    scansInFlight += 1
    const startedAt = Date.now()
    try {
      const { stdout } = await execFileAsync('du', ['-kx', '-d', '1', target], {
        timeout: SCAN_TIMEOUT_MS,
        maxBuffer: SCAN_MAX_BUFFER,
        encoding: 'utf8',
      })
      const value = { path: roots.get(target).path, realPath: target, ...parseDu(stdout, target), durationMs: Date.now() - startedAt, scannedAt: Date.now() }
      scanCache.set(target, { at: Date.now(), value })
      return { ok: true, cached: false, ...value }
    } catch (error) {
      const timeout = error !== null && typeof error === 'object' && (('killed' in error && error.killed) || error.signal !== undefined)
      const message = timeout
        ? 'Scanning timed out after 30s; the directory is too large or sits on a slow disk.'
        : error instanceof Error
          ? error.message
          : String(error)
      // A partial result is still useful: du keeps writing before it is killed.
      const stdout = error !== null && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
      if (stdout.length > 0) {
        const value = { path: roots.get(target).path, realPath: target, ...parseDu(stdout, target), durationMs: Date.now() - startedAt, scannedAt: Date.now(), partial: true }
        return { ok: true, cached: false, warning: message, ...value }
      }
      return { ok: false, error: { code: timeout ? 'timeout' : 'scan-failed', message } }
    } finally {
      scansInFlight = Math.max(0, scansInFlight - 1)
    }
  }

  /** @param {unknown[]} rawPaths */
  const inspectCleanupPaths = async (rawPaths) => {
    if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
      return { error: 'cleanup: paths must be a non-empty array' }
    }
    if (rawPaths.length > CLEANUP_MAX_PATHS) {
      return { error: `cleanup: at most ${CLEANUP_MAX_PATHS} paths per request` }
    }
    const roots = await canonicalRoots()
    /** @type {{ path: string, name: string, workspacePath: string }[]} */
    const items = []
    for (const rawPath of rawPaths) {
      if (typeof rawPath !== 'string' || !isAbsolute(rawPath)) {
        return { error: `cleanup: not an absolute path: ${String(rawPath)}` }
      }
      const canonical = await realpath(rawPath).catch(() => undefined)
      if (canonical === undefined) return { error: `cleanup: path does not exist: ${rawPath}` }
      const owner = roots.get(dirname(canonical))
      if (owner === undefined) return { error: `cleanup: not a direct child of a registered Workspace: ${rawPath}` }
      const name = basename(canonical)
      if (!CLEANUP_ALLOWLIST.has(name)) return { error: `cleanup: "${name}" is not on the cleanup allow-list` }
      const info = await lstat(canonical).catch(() => undefined)
      if (info === undefined) return { error: `cleanup: cannot stat: ${rawPath}` }
      if (info.isSymbolicLink()) return { error: `cleanup: refusing to Trash a symlink: ${rawPath}` }
      if (!info.isDirectory()) return { error: `cleanup: not a directory: ${rawPath}` }
      items.push({ path: canonical, name, workspacePath: owner.path })
    }
    return { items }
  }

  /** @param {import('node:http').IncomingMessage} req */
  const readJsonBody = async (req) => {
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('application/json')) {
      const error = new Error('Content-Type must be application/json')
      error.code = 'unsupported-media'
      throw error
    }
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > CLEANUP_MAX_BODY) throw new Error('cleanup: request body too large')
      chunks.push(chunk)
    }
    if (size === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      const error = new Error('Body is not valid JSON')
      error.code = 'bad-json'
      throw error
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  const writeJson = (req, res, body, status = 200) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  /** Reject anything that is not a same-origin browser call carrying our token. */
  const authorizeMutation = (req) => {
    try {
      const connection = ctx.get('connection')
      if (connection !== undefined && typeof connection.requestRejection === 'function') {
        const rejection = connection.requestRejection(req)
        if (rejection === 403) return 'request rejected by the connection trust fence (host/origin)'
      }
    } catch {
      // The fence is an extra layer; the token below still applies.
    }
    const header = req.headers['x-dev-panel-token']
    if (typeof header !== 'string' || header !== token) {
      return 'invalid capability token'
    }
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      return `cross-site request rejected (${site})`
    }
    const origin = req.headers.origin
    if (typeof origin === 'string') {
      let expected
      try {
        expected = ctx.webServer.getOrigin()
      } catch {
        expected = undefined
      }
      if (expected !== undefined && origin !== expected) {
        return `origin mismatch (${origin})`
      }
    }
    return undefined
  }

  /**
   * Host-side watch: the only part that keeps working while the page is closed.
   * `statfs` only (never `du`), once a minute, with hysteresis and a per-volume
   * cooldown so a re-crossing does not spam. Every state change that is due to
   * notify bumps `seq`; clients treat a new `seq` as "raise a notification".
   */
  const watch = {
    seq: 0,
    level: 0,
    since: Date.now(),
    volumes: [],
    alerts: [],
    lastAlert: undefined,
    checkedAt: 0,
  }
  const watchLevels = new Map()
  const watchCooldowns = new Map()

  const levelFor = (volume, previous) => {
    if (Array.isArray(settings.ignoredVolumes) && settings.ignoredVolumes.includes(volume.key)) return 0
    const free = Number(volume.free)
    const total = Number(volume.total)
    if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return 0
    const ratio = free / total
    // Multi-terabyte volumes need a much lower ratio before they count as low.
    const scale = total >= 1024 ** 4 ? 0.5 : 1
    const warnRatio = settings.warnRatio * scale
    const critRatio = settings.critRatio * scale
    const warnFree = settings.warnFreeGB * 1024 ** 3
    const critFree = settings.critFreeGB * 1024 ** 3
    let level = ratio <= critRatio || free <= critFree ? 2 : ratio <= warnRatio || free <= warnFree ? 1 : 0
    // Hysteresis: leave a level only after recovering 5 points / 20% past it.
    if (previous === 2 && level < 2 && !(ratio > critRatio + 0.05 || free > critFree * 1.2)) level = 2
    if (previous >= 1 && level === 0 && !(ratio > warnRatio + 0.05 || free > warnFree * 1.2)) level = 1
    return level
  }

  const checkWatch = async () => {
    try {
      const { volumes } = await collectVolumes()
      let overall = 0
      for (const volume of volumes) {
        const previous = watchLevels.get(volume.key) ?? 0
        const level = levelFor(volume, previous)
        watchLevels.set(volume.key, level)
        if (level > overall) overall = level
        if (settings.monitor === true && level > 0 && (previous === 0 || level > previous)) {
          const cooldownKey = `${volume.key}|${level}`
          const last = watchCooldowns.get(cooldownKey) ?? 0
          if (Date.now() - last >= settings.cooldownHours * 3_600_000) {
            watchCooldowns.set(cooldownKey, Date.now())
            const alert = {
              at: Date.now(),
              level,
              volume: { key: volume.key, labels: volume.labels, paths: volume.paths, free: volume.free, total: volume.total },
            }
            watch.lastAlert = alert
            watch.alerts = [alert, ...watch.alerts].slice(0, 20)
            watch.seq += 1
          }
        }
      }
      watch.level = overall
      watch.checkedAt = Date.now()
      watch.volumes = volumes.map((volume) => ({
        key: volume.key,
        labels: volume.labels,
        paths: volume.paths,
        free: volume.free,
        total: volume.total,
      }))
      watch.ignored = Array.isArray(settings.ignoredVolumes) ? [...settings.ignoredVolumes] : []
      void appendHistory({ at: watch.checkedAt, volumes: watch.volumes.map((volume) => ({ key: volume.key, free: volume.free, total: volume.total })) })
    } catch {
      // A failed sample keeps the previous watch state.
    }
  }

  ctx.effect(() => {
    void checkWatch()
    const timer = setInterval(() => {
      void checkWatch()
    }, WATCH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, 'sidebar-panel: host watch')

  ctx.effect(() => {
    /** @param {Request} request */
    const resource = async (request) => {
      try {
        const url = new URL(request.url, 'http://localhost')
        if (url.pathname === `${API_PREFIX}/overview`) {
          return json({ ok: true, ...(await overview()) })
        }
        if (url.pathname === `${API_PREFIX}/watch`) {
          return json({ ok: true, ...watch })
        }
        const readToken = request.headers.get('x-dev-panel-token')
        if (url.pathname === `${API_PREFIX}/config`) {
          if (readToken !== token) return json({ ok: false, error: { code: 'forbidden', message: 'invalid capability token' } }, 403)
          return json({ ok: true, settings, path: settingsPath })
        }
        if (url.pathname === `${API_PREFIX}/history`) {
          if (readToken !== token) return json({ ok: false, error: { code: 'forbidden', message: 'invalid capability token' } }, 403)
          const hours = clampNumber(url.searchParams.get('hours'), 6, 0.25, 168)
          const cutoff = Date.now() - hours * 3600_000
          const samples = history.filter((sample) => sample.at >= cutoff)
          return json({ ok: true, samples, path: historyPath })
        }
        if (url.pathname === `${API_PREFIX}/audit`) {
          if (readToken !== token) return json({ ok: false, error: { code: 'forbidden', message: 'invalid capability token' } }, 403)
          const limit = clampNumber(url.searchParams.get('limit'), 20, 1, 100)
          return json({ ok: true, entries: await readAudit(limit), path: auditPath })
        }
        if (url.pathname === `${API_PREFIX}/scan`) {
          const requested = url.searchParams.get('path')
          if (requested === null || requested.length === 0) {
            return json({ ok: false, error: { code: 'missing-path', message: 'The `path` query parameter is required.' } }, 400)
          }
          return json({ ...(await scan(requested)) })
        }
        return json({ ok: false, error: { code: 'not-found', message: 'Unknown endpoint.' } }, 404)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ ok: false, error: { code: 'internal', message } }, 500)
      }
    }

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    const cleanupHandler = async (req, res) => {
      try {
        if (req.method !== 'POST') {
          writeJson(req, res, { ok: false, error: { code: 'method', message: 'POST required' } }, 405)
          return
        }
        const rejected = authorizeMutation(req)
        if (rejected !== undefined) {
          writeJson(req, res, { ok: false, error: { code: 'forbidden', message: rejected } }, 403)
          return
        }
        const body = await readJsonBody(req)
        const dryRun = body.dryRun === true
        const inspected = await inspectCleanupPaths(body.paths)
        if (inspected.error !== undefined) {
          writeJson(req, res, { ok: false, error: { code: 'invalid-path', message: inspected.error } }, 400)
          return
        }
        const items = inspected.items
        if (dryRun) {
          writeJson(req, res, { ok: true, dryRun: true, items, canTrash: process.platform === 'darwin' })
          return
        }
        if (process.platform !== 'darwin') {
          writeJson(req, res, { ok: false, error: { code: 'unsupported', message: 'Moving to Trash is only implemented on macOS.' } }, 400)
          return
        }
        if (cleanupBusy) {
          writeJson(req, res, { ok: false, error: { code: 'busy', message: 'Another cleanup is running.' } }, 409)
          return
        }
        cleanupBusy = true
        try {
          /** @type {{ path: string, name: string, ok: boolean, error?: string, method?: string }[]} */
          const results = []
          for (const item of items) {
            let outcome = await moveToTrash(item.path, item.workspacePath)
            if (outcome.ok === true) {
              try {
                await lstat(item.path)
                outcome = { ok: false, error: `still present after moving: ${item.path}` }
              } catch {
                // vanished as expected
              }
            }
            results.push({
              path: item.path,
              name: item.name,
              ...outcome,
              ...(outcome.detail === undefined ? {} : { dest: destinationOf(outcome.detail) }),
            })
            if (outcome.ok === true) {
              // A trashed directory invalidates the cached `du` result of its
              // Workspace; the next scan re-measures it.
              scanCache.delete(dirname(item.path))
            }
          }
          await appendAudit({
            at: Date.now(),
            workspacePath: items[0] === undefined ? undefined : items[0].workspacePath,
            items: items.map((item) => {
              const result = results.find((candidate) => candidate.path === item.path)
              return {
                path: item.path,
                name: item.name,
                size: body.sizes !== null && typeof body.sizes === 'object' ? body.sizes[item.path] : undefined,
                dest: result === undefined ? undefined : result.dest,
              }
            }),
            results,
            ok: results.every((result) => result.ok === true),
          })
          writeJson(req, res, { ok: true, dryRun: false, items, results })
        } finally {
          cleanupBusy = false
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
        const status = code === 'bad-json' || code === 'unsupported-media' ? 400 : 500
        writeJson(req, res, { ok: false, error: { code: code === 'bad-json' ? 'bad-json' : code === 'unsupported-media' ? 'unsupported-media' : 'internal', message } }, status)
      }
    }

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    const restoreHandler = async (req, res) => {
      try {
        if (req.method !== 'POST') {
          writeJson(req, res, { ok: false, error: { code: 'method', message: 'POST required' } }, 405)
          return
        }
        const rejected = authorizeMutation(req)
        if (rejected !== undefined) {
          writeJson(req, res, { ok: false, error: { code: 'forbidden', message: rejected } }, 403)
          return
        }
        const body = await readJsonBody(req)
        const at = Number(body.at)
        const entries = await readAudit(500)
        const entry = entries.find((candidate) => candidate.at === at && candidate.ok === true && candidate.action !== 'restore')
        if (entry === undefined) {
          writeJson(req, res, { ok: false, error: { code: 'entry-not-found', message: 'No successful cleanup with that timestamp.' } }, 404)
          return
        }
        const items = Array.isArray(entry.items) ? entry.items : []
        const item = items.find((candidate) => candidate.path === body.target) ?? items[0]
        if (item === undefined || typeof item.dest !== 'string' || item.dest.length === 0) {
          writeJson(req, res, { ok: false, error: { code: 'no-destination', message: 'This entry has no recorded Trash destination; restore it from Finder.' } }, 409)
          return
        }
        if (typeof body.target === 'string' && body.target !== item.path) {
          writeJson(req, res, { ok: false, error: { code: 'target-mismatch', message: 'The requested target does not match the audit entry.' } }, 400)
          return
        }
        const target = resolve(item.path)
        const destination = resolve(item.dest)
        const roots = await canonicalRoots()
        if (!roots.has(dirname(target))) {
          writeJson(req, res, { ok: false, error: { code: 'not-a-workspace', message: 'The restore target is not a direct child of a registered Workspace.' } }, 400)
          return
        }
        if (!CLEANUP_ALLOWLIST.has(basename(target))) {
          writeJson(req, res, { ok: false, error: { code: 'not-allowlisted', message: 'The restore target is not on the cleanup allow-list.' } }, 400)
          return
        }
        try {
          await lstat(target)
          writeJson(req, res, { ok: false, error: { code: 'target-exists', message: `Something already exists at ${target}` } }, 409)
          return
        } catch {
          // target is free, good
        }
        try {
          await lstat(destination)
        } catch {
          writeJson(req, res, { ok: false, error: { code: 'destination-missing', message: 'The trashed copy is no longer there; restore it from Finder manually.' } }, 409)
          return
        }
        try {
          await mkdir(dirname(target), { recursive: true })
          await rename(destination, target)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          writeJson(req, res, { ok: false, error: { code: 'restore-failed', message: `${message} — restore it from Finder manually.` } }, 500)
          return
        }
        await appendAudit({ at: Date.now(), action: 'restore', ok: true, target, dest: destination, workspacePath: roots.get(dirname(target)).path })
        writeJson(req, res, { ok: true, target, dest: destination })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
        const status = code === 'bad-json' || code === 'unsupported-media' ? 400 : 500
        writeJson(req, res, { ok: false, error: { code: code === 'bad-json' ? 'bad-json' : code === 'unsupported-media' ? 'unsupported-media' : 'internal', message } }, status)
      }
    }

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    const configHandler = async (req, res) => {
      try {
        const header = req.headers['x-dev-panel-token']
        if (req.method === 'GET') {
          if (typeof header !== 'string' || header !== token) {
            writeJson(req, res, { ok: false, error: { code: 'forbidden', message: 'invalid capability token' } }, 403)
            return
          }
          writeJson(req, res, { ok: true, settings, path: settingsPath })
          return
        }
        if (req.method !== 'POST') {
          writeJson(req, res, { ok: false, error: { code: 'method', message: 'GET or POST required' } }, 405)
          return
        }
        const rejected = authorizeMutation(req)
        if (rejected !== undefined) {
          writeJson(req, res, { ok: false, error: { code: 'forbidden', message: rejected } }, 403)
          return
        }
        const body = await readJsonBody(req)
        const saved = await persistSettings(body)
        // Re-sample immediately so the panel and sidebar reflect new thresholds.
        void checkWatch()
        writeJson(req, res, { ok: true, settings: saved, path: settingsPath })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
        const status = code === 'bad-json' || code === 'unsupported-media' ? 400 : 500
        writeJson(req, res, { ok: false, error: { code: code === 'bad-json' ? 'bad-json' : code === 'unsupported-media' ? 'unsupported-media' : 'internal', message } }, status)
      }
    }

    const disposeResourceRoute = ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      resource,
    })
    const disposeCleanupRoute = ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/cleanup`,
      handler: cleanupHandler,
    })
    const disposeConfigRoute = ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/config`,
      handler: configHandler,
    })
    const disposeRestoreRoute = ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/restore`,
      handler: restoreHandler,
    })
    return () => {
      disposeRestoreRoute()
      disposeConfigRoute()
      disposeCleanupRoute()
      disposeResourceRoute()
      scanCache.clear()
    }
  }, 'sidebar-panel: data routes')
}
