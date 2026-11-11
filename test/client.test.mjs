/**
 * Headless behavioural test for the plugin's client half.
 *
 * No browser control is available in this session, so this harness runs the real
 * client.js against a tiny React-compatible renderer (createElement / useState /
 * useEffect / useSyncExternalStore are all the client uses), a stubbed Cordis
 * ctx, and a stubbed fetch. It exercises the real component tree: loading, data,
 * scan results, threshold banner, cleanup confirmation, agent hand-off, copy,
 * auto-refresh and the error state.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)))

// ---------------------------------------------------------------- React stub
let currentStore = new Map()
let renderDirty = false
let effectQueue = []
let hookCursor = 0
let currentPath = 'root'

const React = {
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) }
    const kids = children.length > 0 ? children : merged.children
    if (kids !== undefined) merged.children = kids
    return { $$el: true, type, props: merged }
  },
  useState(initial) {
    const index = hookCursor++
    const cell = getCell(index)
    if (cell.initialized !== true) {
      cell.value = typeof initial === 'function' ? initial() : initial
      cell.initialized = true
    }
    const set = (next) => {
      cell.value = typeof next === 'function' ? next(cell.value) : next
      renderDirty = true
    }
    return [cell.value, set]
  },
  useEffect(effect, deps) {
    const index = hookCursor++
    const cell = getCell(index)
    const depsKey = deps === undefined ? `always:${index}` : JSON.stringify(deps)
    if (cell.executed === true && cell.depsKey === depsKey) return
    cell.executed = true
    cell.depsKey = depsKey
    effectQueue.push(effect)
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    hookCursor++
    return getSnapshot()
  },
}

function getCell(index) {
  const key = `${currentPath}#${index}`
  let cell = currentStore.get(key)
  if (cell === undefined) {
    cell = {}
    currentStore.set(key, cell)
  }
  return cell
}

function render(el, path) {
  if (el === null || el === undefined || el === false) return null
  if (typeof el === 'string' || typeof el === 'number') return { text: String(el) }
  if (Array.isArray(el)) {
    return { wrap: true, children: el.map((child, index) => render(child, `${path}.${index}`)).filter(Boolean) }
  }
  if (typeof el.type === 'function') {
    const savedPath = currentPath
    const savedCursor = hookCursor
    currentPath = path
    hookCursor = 0
    let output
    try {
      output = el.type(el.props)
    } finally {
      currentPath = savedPath
      hookCursor = savedCursor
    }
    return render(output, `${path}>`)
  }
  const props = el.props ?? {}
  const kids = props.children
  const list = kids === undefined ? [] : Array.isArray(kids) ? kids : [kids]
  return {
    host: true,
    type: el.type,
    props,
    children: list.map((child, index) => render(child, `${path}.${index}`)).filter(Boolean),
  }
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (node.text !== undefined) return node.text
  return (node.children ?? []).map(textOf).join('')
}

function collectText(node, sink) {
  if (node === null || node === undefined) return
  if (node.text !== undefined) {
    sink.push(node.text)
    return
  }
  if (node.host === true) sink.push(' ')
  for (const child of node.children ?? []) collectText(child, sink)
}

function collectClickables(node, collected) {
  if (node === null || node === undefined) return
  if (node.host === true && typeof node.props.onClick === 'function') {
    collected.push({ text: textOf(node), title: node.props.title, onClick: node.props.onClick })
  }
  for (const child of node.children ?? []) collectClickables(child, collected)
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function createHarness(element) {
  const store = new Map()
  let rootTree = null

  async function settle() {
    for (let round = 0; round < 15; round += 1) {
      renderDirty = false
      effectQueue = []
      hookCursor = 0
      currentStore = store
      rootTree = render(element, 'root')
      const effects = effectQueue
      effectQueue = []
      for (const effect of effects) await effect()
      await flush()
      if (!renderDirty) break
    }
    return rootTree
  }

  return {
    async text() {
      const sink = []
      collectText(rootTree, sink)
      return sink.join('')
    },
    clickables() {
      const collected = []
      collectClickables(rootTree, collected)
      return collected
    },
    async click(predicate) {
      const target = this.clickables().find((entry) => predicate(entry))
      if (target === undefined) return false
      target.onClick()
      await settle()
      return true
    },
    settle,
  }
}

// ------------------------------------------------------------------- fixtures
const overviewFixture = {
  ok: true,
  home: '/Users/test',
  platform: 'darwin',
  generatedAt: 1794361227462,
  token: 'test-token',
  cleanup: { canTrash: true, allowlist: ['node_modules', 'dist', '.next'] },
  volumes: [
    {
      key: '245107195904|26982285312',
      labels: [
        { kind: 'root', text: '系统盘' },
        { kind: 'home', text: '主目录' },
        { kind: 'workspace', text: 'disk-demo' },
      ],
      paths: ['/', '/Users/test', '/Users/test/Projects/disk-demo'],
      total: 245107195904,
      free: 18 * 1024 ** 3,
      used: 245107195904 - 18 * 1024 ** 3,
    },
    {
      key: '321912791040|299766919168',
      labels: [{ kind: 'workspace', text: 'demo-volume' }],
      paths: ['/Volumes/demo'],
      total: 321912791040,
      free: 299766919168,
      used: 22145871872,
    },
  ],
  workspaces: [
    { id: 'w1', path: '/Users/test/Projects/disk-demo', title: 'disk-demo', volumeKey: '245107195904|26982285312' },
    { id: 'w2', path: '/Volumes/demo', title: 'demo-volume', volumeKey: '321912791040|299766919168' },
  ],
}

const workspacePath = '/Users/test/Projects/disk-demo'

const scanFixture = {
  ok: true,
  cached: false,
  path: workspacePath,
  total: 135168 * 1024,
  entries: [
    { path: `${workspacePath}/node_modules`, name: 'node_modules', size: 77824 * 1024 },
    { path: `${workspacePath}/dsh-plugins`, name: 'dsh-plugins', size: 4096 * 1024 },
  ],
  rest: { count: 3, size: 1024 * 1024 },
  durationMs: 12,
  scannedAt: 1794361227474,
}

let configState = { monitor: true, notify: true, warnRatio: 0.1, warnFreeGB: 20, critRatio: 0.05, critFreeGB: 5, cooldownHours: 6, ignoredVolumes: [] }
const configPath = '/Users/test/.dsh/dev-panel/settings.json'
const auditPath = '/Users/test/.dsh/dev-panel/cleanup-audit.jsonl'
const historySamples = [
  { at: 1794363000000, volumes: [{ key: '245107195904', free: 20 * 1024 ** 3, total: 245107195904 }, { key: '321912791040', free: 279 * 1024 ** 3, total: 321912791040 }] },
  { at: 1794363300000, volumes: [{ key: '245107195904', free: 18 * 1024 ** 3, total: 245107195904 }, { key: '321912791040', free: 279 * 1024 ** 3, total: 321912791040 }] },
  { at: 1794363600000, volumes: [{ key: '245107195904', free: 19 * 1024 ** 3, total: 245107195904 }, { key: '321912791040', free: 279 * 1024 ** 3, total: 321912791040 }] },
]
const restoreCalls = []
let auditEntries = [
  {
    at: 1794361227000,
    workspacePath: '/Users/test/Projects/disk-demo',
    items: [{ path: '/Users/test/Projects/disk-demo/.cache', name: '.cache', size: 2048, dest: '/Users/test/Library/Mobile Documents/.Trash/.cache' }],
    ok: true,
  },
]
const configCalls = []
let watchPayload = { ok: true, seq: 0, level: 0, since: 0, volumes: [], lastAlert: undefined }
function makeWatch(level, seq, lastAlert) {
  const volume = overviewFixture.volumes[0]
  watchPayload = {
    ok: true,
    seq,
    level,
    since: 0,
    volumes: overviewFixture.volumes.map((item) => ({ key: item.key, labels: item.labels, paths: item.paths, free: item.free, total: item.total })),
    lastAlert: lastAlert === undefined ? undefined : { at: 0, level, volume: { key: volume.key, labels: volume.labels, paths: volume.paths, free: volume.free, total: volume.total } },
  }
  return watchPayload
}

const source = readFileSync(join(pluginDir, 'client.js'), 'utf8')

// ------------------------------------------------------------------ fake env
const dicts = { zh: {}, en: {} }
let activeLocale = 'zh'
const requestedKeys = new Set()
const startSessionCalls = []
const openWorkspaceCalls = []
const registrations = []
const fetchCalls = []
const intervals = []
let clipboardText = undefined
let clipboardWorks = true

const translate = (key, params) => {
  requestedKeys.add(key)
  const dict = dicts[activeLocale]
  const template = dict[key]
  if (template === undefined) return `MISSING:${key}`
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  get: () => ({
    clipboard: {
      writeText: async (text) => {
        if (!clipboardWorks) throw new Error('denied')
        clipboardText = text
      },
    },
  }),
})

const notifications = []
const panelSelections = []
class FakeNotification {
  static permission = 'granted'
  static requestPermission = async () => 'granted'
  constructor(title, options) {
    this.title = title
    this.options = options
    this.onclick = undefined
    notifications.push(this)
  }
}
globalThis.Notification = FakeNotification
globalThis.document = {
  hidden: true,
  hasFocus: () => false,
  addEventListener: () => {},
  createElement: () => ({ style: {}, select: () => {}, value: '' }),
  execCommand: () => false,
  body: { appendChild: () => {}, removeChild: () => {} },
}
let optionsOverride = undefined
globalThis.localStorage = {
  getItem: (key) => (key === 'sidebar-panel.options' && optionsOverride !== undefined ? JSON.stringify(optionsOverride) : null),
  setItem: () => {},
}

const ctx = {
  get: () => undefined,
  effect: (fn) => fn(),
  on: () => () => {},
  locale: {
    bind: () => translate,
    register: (_ns, locale, dict) => {
      Object.assign(dicts[locale], dict)
      return () => {}
    },
    subscribe: () => () => {},
    getLocale: () => ({ active: activeLocale, locales: [{ id: 'zh', label: '中文' }], revision: 1 }),
    getSnapshot: () => ({ active: activeLocale, locales: [{ id: 'zh', label: '中文' }], revision: 1 }),
  },
  layout: { selectPanel: (id) => panelSelections.push(id) },
  uiWorkspace: {
    startSession: (workspaceId, options) => startSessionCalls.push({ workspaceId, options }),
    openWorkspace: (workspaceId) => {
      openWorkspaceCalls.push(workspaceId)
      return Promise.resolve()
    },
  },
  slots: {
    inject: (_key, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

let pluginDefinition
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      void id
      pluginDefinition = factory((name) => {
        if (name === 'react') return React
        throw new Error(`unexpected require(${name})`)
      })
    },
  },
  setInterval: (callback, ms) => {
    intervals.push({ callback, ms })
    return intervals.length
  },
  clearInterval: () => {},
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => clearTimeout(id),
}
// eslint-disable-next-line no-new-func
new Function(source)()
if (pluginDefinition === undefined) throw new Error('client.js registered no plugin definition')
pluginDefinition.apply(ctx)

const iconRegistration = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
const panelRegistration = registrations.find((entry) => entry.options.name === 'main')
const panel = (extra) => React.createElement(panelRegistration.component, { t: translate, ...extra })

let failures = 0
let checks = 0
function check(name, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}${detail === undefined ? '' : `\n      ${String(detail).slice(0, 600)}`}`)
  }
}

let fetchHandler = () => new Response(JSON.stringify({ ok: false }), { status: 200 })
globalThis.fetch = async (input, init) => {
  fetchCalls.push({ url: String(input), init })
  return fetchHandler(String(input), init ?? {})
}
function stubFetch(handler) {
  fetchHandler = handler
}
const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200 })
const countFetches = (needle) => fetchCalls.filter((call) => call.url.includes(needle)).length

async function run() {
  console.log('0) registrations and dictionaries')
  check('sidebar icon registered for sidebar.panellist', iconRegistration !== undefined)
  check('sidebar entry id is disk-panel', iconRegistration?.options.id === 'disk-panel')
  check('sidebar entry order is 20', iconRegistration?.options.order === 20)
  check('sidebar entry label is a thunk', typeof iconRegistration?.options.label === 'function')
  check('panel registered under main/sidebar-panel', panelRegistration?.options.name === 'main' && panelRegistration?.options.key === 'disk-panel')
  const zhKeys = Object.keys(dicts.zh)
  const enKeys = Object.keys(dicts.en)
  check('zh dictionary is non-empty', zhKeys.length > 40, zhKeys.length)
  check(
    'en dictionary covers the same keys',
    zhKeys.length === enKeys.length && zhKeys.every((key) => enKeys.includes(key)),
    `zh=${zhKeys.length} en=${enKeys.length} missingInEn=${zhKeys.filter((key) => !enKeys.includes(key)).join(',')}`,
  )

  console.log('1) sidebar icon component')
  const iconTree = render(React.createElement(iconRegistration.component, { size: 20, active: true }), 'icon')
  check('icon renders an svg host', iconTree?.host === true && iconTree.type === 'svg')
  check('icon uses the requested edge', iconTree?.props?.width === 20 && iconTree?.props?.height === 20)
  check('icon color follows active state', String(iconTree?.props?.style?.color).includes('brand-primary'))

  console.log('1b) sidebar warning dot')
  stubFetch((url) => {
    if (url.includes('/watch')) return jsonResponse(watchPayload)
    if (url.includes('/overview')) return jsonResponse(overviewFixture)
    return jsonResponse({ ok: false })
  })
  const watcher = intervals[0]
  check('background watcher interval registered', watcher !== undefined && watcher.ms === 60000, JSON.stringify(intervals.map((entry) => entry.ms)))
  makeWatch(1, 1)
  if (watcher !== undefined) await watcher.callback()
  await flush()
  const warnIcon = render(React.createElement(iconRegistration.component, { size: 20, active: false }), 'icon-warn')
  const warnDot = (warnIcon?.children ?? []).find((child) => child?.props?.cx === 16.5)
  check('host warn level draws a warning dot on the sidebar icon', warnDot !== undefined && String(warnDot.props.fill).includes('warn-primary'), JSON.stringify(warnIcon?.children?.length))
  makeWatch(0, 2)
  if (watcher !== undefined) await watcher.callback()
  await flush()
  const healthyIcon = render(React.createElement(iconRegistration.component, { size: 20, active: false }), 'icon-ok')
  const noDot = (healthyIcon?.children ?? []).find((child) => child?.props?.cx === 16.5)
  check('healthy host level draws no warning dot', noDot === undefined)

  console.log('1c) low-disk notifications')
  const noticesBefore = notifications.length
  makeWatch(2, 3, true)
  if (watcher !== undefined) await watcher.callback()
  await flush()
  const criticalNotice = notifications[notifications.length - 1]
  check('a new host alert seq raises an OS notification', notifications.length === noticesBefore + 1 && criticalNotice !== undefined && criticalNotice.title.includes('严重不足'), JSON.stringify(notifications.map((item) => item.title)))
  check('notification body carries free space and percent', String(criticalNotice?.options?.body ?? '').includes('剩余') && String(criticalNotice?.options?.body ?? '').includes('%'), criticalNotice?.options?.body)
  if (criticalNotice !== undefined && typeof criticalNotice.onclick === 'function') criticalNotice.onclick()
  check('clicking the notification opens the disk panel', panelSelections.includes('disk-panel'), JSON.stringify(panelSelections))
  const afterFirstAlert = notifications.length
  if (watcher !== undefined) await watcher.callback()
  await flush()
  check('the same host seq does not notify twice', notifications.length === afterFirstAlert, `${afterFirstAlert} -> ${notifications.length}`)
  optionsOverride = { monitor: false }
  makeWatch(2, 4, true)
  if (watcher !== undefined) await watcher.callback()
  await flush()
  check('monitor can be disabled through localStorage options', notifications.length === afterFirstAlert)
  optionsOverride = undefined
  makeWatch(0, 5)

  console.log('2) data render')
  stubFetch((url, init) => {
    if (url.includes('/watch')) return jsonResponse(watchPayload)
    if (url.includes('/config')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        configCalls.push(body)
        configState = Object.assign({}, configState, body)
        return jsonResponse({ ok: true, settings: configState, path: configPath })
      }
      return jsonResponse({ ok: true, settings: configState, path: configPath })
    }
    if (url.includes('/audit')) return jsonResponse({ ok: true, entries: auditEntries, path: auditPath })
    if (url.includes('/history')) return jsonResponse({ ok: true, samples: historySamples, path: '/Users/test/.dsh/dev-panel/history.jsonl' })
    if (url.includes('/restore')) {
      const body = JSON.parse(String(init?.body))
      restoreCalls.push(body)
      auditEntries = [{ at: Date.now(), action: 'restore', ok: true, target: body.target, workspacePath }, ...auditEntries]
      return jsonResponse({ ok: true, target: body.target, dest: body.dest })
    }
    if (url.includes('/overview')) return jsonResponse(overviewFixture)
    if (url.includes('/scan')) return jsonResponse(scanFixture)
    if (url.includes('/cleanup')) {
      const body = init?.body === undefined ? '{}' : String(init.body)
      if (body.includes('"dryRun":true')) return jsonResponse({ ok: true, dryRun: true, items: [{ path: `${workspacePath}/node_modules`, name: 'node_modules' }] })
      auditEntries = [{ at: Date.now(), workspacePath, items: [{ path: `${workspacePath}/node_modules`, name: 'node_modules', size: 77824 * 1024 }], ok: true }, ...auditEntries]
      return jsonResponse({ ok: true, dryRun: false, results: [{ path: `${workspacePath}/node_modules`, name: 'node_modules', ok: true, method: 'trash' }] })
    }
    return jsonResponse({ ok: false, error: { message: 'unexpected' } })
  })
  const harness = createHarness(panel())
  await harness.settle()
  const text = await harness.text()
  check('renders system disk title', text.includes('系统盘'), text.slice(0, 300))
  check('renders workspace count summary', text.includes('1 个工作区'), text.slice(0, 400))
  check('renders free space', /剩余\s*[\d.]+\s*(GB|MB|TB)/.test(text), text.slice(0, 500))
  check('lists registered workspaces', text.includes('disk-demo') && text.includes('demo-volume'))
  check('shows scan affordance', text.includes('计算占用'))
  check('shows quick cleanup prompts', ['分析大目录', '清理构建缓存', '迁移大目录', '排查磁盘不足'].every((label) => text.includes(label)))
  check('shows threshold banner', text.includes('磁盘空间紧张') || text.includes('磁盘空间严重不足'), text.slice(0, 500))
  check('shows refresh interval note', text.includes('每分钟自动刷新'))
  check('settings card renders the host config', text.includes('面板设置') && text.includes('配置文件'), text.slice(-900))
  check('audit card renders recent cleanups', text.includes('最近清理') && text.includes('.cache'), text.slice(-900))
  check('history card renders a free-space trend', text.includes('剩余空间趋势'), text.slice(-900))
  check('no missing locale keys', !text.includes('MISSING:'), [...requestedKeys].filter((key) => dicts.zh[key] === undefined).join(','))
  check('auto-refresh interval registered', intervals.some((entry) => entry.ms === 60000), JSON.stringify(intervals.map((entry) => entry.ms)))

  console.log('3) scan interaction')
  const scanClicked = await harness.click((entry) => entry.text.includes('计算占用'))
  const afterScan = await harness.text()
  check('scan button was clickable', scanClicked)
  check('scan results render a total', afterScan.includes('合计'))
  check('scan results list entries', afterScan.includes('node_modules/') && afterScan.includes('dsh-plugins/'))
  check('scan results mention uncounted items', afterScan.includes('其余 3 项'))
  check('agent hand-off button present', afterScan.includes('发给 Agent 分析'))
  check('copy button present', afterScan.includes('复制摘要'))

  console.log('3b) trend, mute and restore')
  const muteClicked = await harness.click((entry) => entry.text.trim() === '忽略告警')
  const muteCall = configCalls[configCalls.length - 1]
  check('mute button saves ignored volumes to the host', muteClicked && Array.isArray(muteCall?.ignoredVolumes) && muteCall.ignoredVolumes.includes(overviewFixture.volumes[0].key), JSON.stringify(muteCall))
  const unmuteClicked = await harness.click((entry) => entry.text.trim() === '恢复告警' || entry.text.trim() === '忽略告警')
  check('mute state can be toggled back', unmuteClicked)
  const restoreClicked = await harness.click((entry) => entry.text.trim() === '恢复')
  const restoreCall = restoreCalls[restoreCalls.length - 1]
  check('restore button POSTs the audit coordinates', restoreClicked && restoreCall !== undefined && restoreCall.target === '/Users/test/Projects/disk-demo/.cache' && typeof restoreCall.at === 'number' && typeof restoreCall.dest === 'string', JSON.stringify(restoreCall))
  const afterRestore = await harness.text()
  check('restore reports success', afterRestore.includes('已恢复'), afterRestore.slice(-600))

  console.log('4) cleanup confirmation')
  const trashClicked = await harness.click((entry) => typeof entry.title === 'string' && entry.title.includes('node_modules'))
  const confirmText = await harness.text()
  check('cleanup card appears after choosing an artifact', trashClicked && confirmText.includes('把构建产物移入废纸篓'), confirmText.slice(-600))
  check('cleanup explains Trash semantics', confirmText.includes('清空废纸篓后'))
  const scansBefore = countFetches('/scan')
  const dryRunCall = fetchCalls.find((call) => call.url.includes('/cleanup') && String(call.init?.body).includes('"dryRun":true'))
  check('choosing an artifact validates it with a dry-run', dryRunCall !== undefined && dryRunCall.init?.method === 'POST', JSON.stringify(dryRunCall?.init?.body))
  const confirmClicked = await harness.click((entry) => entry.text.trim() === '移入废纸篓')
  const afterCleanup = await harness.text()
  const cleanupCall = fetchCalls.find((call) => call.url.includes('/cleanup') && String(call.init?.body).includes('"dryRun":false'))
  check('cleanup confirm POSTs to the host', confirmClicked && cleanupCall !== undefined && cleanupCall.init?.method === 'POST')
  check('cleanup sends the capability token', cleanupCall?.init?.headers?.['x-dev-panel-token'] === 'test-token' && dryRunCall?.init?.headers?.['x-dev-panel-token'] === 'test-token', JSON.stringify(cleanupCall?.init?.headers))
  const cleanupBody = cleanupCall?.init?.body === undefined ? {} : JSON.parse(String(cleanupCall.init.body))
  check(
    'cleanup sends only the chosen path',
    Array.isArray(cleanupBody.paths) && cleanupBody.paths.length === 1 && cleanupBody.paths[0] === `${workspacePath}/node_modules` && cleanupBody.dryRun === false,
    cleanupCall?.init?.body,
  )
  check('cleanup reports success', afterCleanup.includes('已移入废纸篓'), afterCleanup.slice(-600))
  check('cleanup re-scans the workspace', countFetches('/scan') > scansBefore, `${scansBefore} -> ${countFetches('/scan')}`)

  console.log('5) agent hand-off and copy')
  const analyzeClicked = await harness.click((entry) => entry.text.trim() === '发给 Agent 分析')
  const analyzeCall = startSessionCalls[startSessionCalls.length - 1]
  check('send-to-agent starts a session with a report', analyzeClicked && analyzeCall !== undefined && typeof analyzeCall.options.prompt === 'string' && analyzeCall.options.prompt.includes('磁盘占用') && analyzeCall.options.prompt.includes('node_modules/'), JSON.stringify(analyzeCall).slice(0, 600))
  const copyClicked = await harness.click((entry) => entry.text.trim() === '复制摘要')
  await flush()
  check('copy writes the report to the clipboard', copyClicked && typeof clipboardText === 'string' && clipboardText.includes('node_modules/') && clipboardText.includes('磁盘占用'))
  const afterCopy = await harness.text()
  check('copy shows feedback', afterCopy.includes('已复制'), afterCopy.slice(-300))

  console.log('6) auto-refresh')
  const overviewBefore = countFetches('/overview')
  const panelIntervals = intervals.filter((entry) => entry.ms === 60000)
  const interval = panelIntervals[panelIntervals.length - 1]
  globalThis.document.hidden = false
  await interval.callback()
  await harness.settle()
  globalThis.document.hidden = true
  check('auto-refresh reloads the overview', countFetches('/overview') > overviewBefore, `${overviewBefore} -> ${countFetches('/overview')}`)

  console.log('7) refresh interaction')
  const refreshBefore = countFetches('/overview')
  const refreshClicked = await harness.click((entry) => entry.text.trim() === '刷新')
  check('refresh button triggers another overview request', refreshClicked && countFetches('/overview') > refreshBefore)

  console.log('7b) settings save')
  const configCallsBefore = configCalls.length
  const saveClicked = await harness.click((entry) => entry.text.trim() === '保存设置')
  check('settings save button POSTs the host config', saveClicked && configCalls.length === configCallsBefore + 1, JSON.stringify(configCalls.map((call) => call.monitor)))
  const savedPayload = configCalls[configCalls.length - 1]
  check(
    'settings payload carries the watchdog thresholds',
    savedPayload !== undefined && savedPayload.warnRatio === 0.1 && savedPayload.warnFreeGB === 20 && savedPayload.critRatio === 0.05 && savedPayload.cooldownHours === 6,
    JSON.stringify(savedPayload),
  )
  const toggleClicked = await harness.click((entry) => typeof entry.title === 'string' && entry.title === '监控与告警')
  check('monitor switch toggles the draft', toggleClicked)
  const saveAfterToggle = await harness.click((entry) => entry.text.trim() === '保存设置')
  check('monitor=false reaches the host', saveAfterToggle && configCalls[configCalls.length - 1]?.monitor === false, JSON.stringify(configCalls[configCalls.length - 1]))
  const hoverNotify = await harness.click((entry) => typeof entry.title === 'string' && entry.title === '系统通知')
  check('notify switch toggles the draft', hoverNotify)
  await harness.click((entry) => entry.text.trim() === '保存设置')
  check('notify=false reaches the host', configCalls[configCalls.length - 1]?.notify === false, JSON.stringify(configCalls[configCalls.length - 1]))
  const noticesBeforeMuted = notifications.length
  makeWatch(2, 20, true)
  if (watcher !== undefined) await watcher.callback()
  await flush()
  check('host notify=false silences OS notifications', notifications.length === noticesBeforeMuted, `${noticesBeforeMuted} -> ${notifications.length}`)
  makeWatch(0, 21)
  configState = { monitor: true, notify: true, warnRatio: 0.1, warnFreeGB: 20, critRatio: 0.05, critFreeGB: 5, cooldownHours: 6 }

  console.log('8) error state')
  stubFetch(() => Promise.reject(new Error('boom')))
  const errorHarness = createHarness(panel())
  await errorHarness.settle()
  const errorText = await errorHarness.text()
  check('error card shown', errorText.includes('无法读取磁盘数据'))
  check('error hint shown', errorText.includes('设置 → 插件'))
  check('retry button offered', errorHarness.clickables().some((entry) => entry.text.trim() === '重试'))

  console.log('9) english dictionary')
  activeLocale = 'en'
  stubFetch((url, init) => {
    if (url.includes('/watch')) return jsonResponse(watchPayload)
    if (url.includes('/config')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        configCalls.push(body)
        configState = Object.assign({}, configState, body)
        return jsonResponse({ ok: true, settings: configState, path: configPath })
      }
      return jsonResponse({ ok: true, settings: configState, path: configPath })
    }
    if (url.includes('/audit')) return jsonResponse({ ok: true, entries: auditEntries, path: auditPath })
    if (url.includes('/history')) return jsonResponse({ ok: true, samples: historySamples, path: '/Users/test/.dsh/dev-panel/history.jsonl' })
    if (url.includes('/restore')) {
      const body = JSON.parse(String(init?.body))
      restoreCalls.push(body)
      auditEntries = [{ at: Date.now(), action: 'restore', ok: true, target: body.target, workspacePath }, ...auditEntries]
      return jsonResponse({ ok: true, target: body.target, dest: body.dest })
    }
    if (url.includes('/overview')) return jsonResponse(overviewFixture)
    if (url.includes('/scan')) return jsonResponse(scanFixture)
    return jsonResponse({ ok: false })
  })
  const enHarness = createHarness(panel())
  await enHarness.settle()
  const enText = await enHarness.text()
  check('english renders without missing keys', !enText.includes('MISSING:'), enText.slice(0, 300))
  check('english dictionary covers every requested key', [...requestedKeys].every((key) => dicts.en[key] !== undefined), [...requestedKeys].filter((key) => dicts.en[key] === undefined).join(','))
  check('english title rendered', enText.includes('Disk & workspaces'))
  check('english threshold banner rendered', enText.includes('Low disk space') || enText.includes('Critically low disk space'))

  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exitCode = 1
}

await run()
