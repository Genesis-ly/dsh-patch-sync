/**
 * dsh-patch-sync —— 宿主半。
 *
 * 职责：
 * 1. 启动后对账：已有记录但插件版本变了（被官方更新覆盖）→ 自动恢复补丁，
 *    逐文件校验，冲突文件保留上游并提示；
 * 2. 常驻监听：profile 里所有已启用插件的包目录；用户保存修改后约 3 秒自动
 *    记录（对照 npm 官方基线计算 diff，补丁本体存进状态目录）；
 * 3. 更新完成检测：监听文件变化 + 等目录静默 + 检查自动更新插件是否正在安装，
 *    然后触发恢复；
 * 4. 状态/报告/HTTP 路由供浏览器半提示，CLI 也可查看。
 *
 * 状态目录默认 `~/.dsh/patch-sync/`，与插件包目录分离，插件更新不会影响记录。
 * 本插件自身通过 `link:` 安装，自动更新插件会跳过非 registry 依赖。
 * @module dsh-patch-sync
 */

import { existsSync, readFileSync, watch as fsWatch } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  cleanupStaleTemps,
  ensureDir,
  listRecords,
  readJson,
  readPluginVersion,
  reconcilePlugin,
  writeFileAtomic,
  writeJsonAtomic,
} from './core.mjs'

export const name = 'dsh-patch-sync'
export const inject = ['webServer']

/** 本插件目录（<plugin>/lib）。 */
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROFILE = process.env.DSH_PATCH_SYNC_PROFILE || process.env.DSH_PROFILE || 'desktop'
const STATE_DIR = process.env.DSH_PATCH_SYNC_STATE_DIR || path.join(DSH_HOME, 'patch-sync')
const LOG_DIR = path.join(STATE_DIR, 'logs')
const REPORT_DIR = path.join(STATE_DIR, 'reports')
const STATUS_FILE = path.join(STATE_DIR, 'state', 'status.json')
const ROUTE_PREFIX = '/dsh-patch-sync'
/** 同一进程内多实例（插件热重载）的接管标记。 */
const RUNTIME_KEY = Symbol.for('dsh-patch-sync.runtime')
const SELF_NAMES = new Set(['dsh-patch-sync', '@local/dsh-patch-sync'])
const DEBOUNCE_MS = 2500
const STARTUP_DELAY_MS = Number(process.env.DSH_PATCH_SYNC_STARTUP_DELAY_MS || 3000)
const PERIODIC_MS = 5 * 60 * 1000
const RESCAN_MS = 60 * 1000
/** 全量重建目录监听的兜底周期（每分钟重扫插件列表，但不必每分钟重建监听）。 */
const WATCHER_REBUILD_MS = 10 * 60 * 1000

/** 已提示过“本地/私有插件跳过自动对账”的插件，避免每次文件变化都刷日志。 */
const unmanagedNotices = new Set()

/** 对客户端暴露的运行状态。 */
const state = {
  phase: 'booting', // booting | idle | reconciling | conflict | error
  eventId: 0,
  dismissedEventId: 0,
  updatedAt: null,
  lastEvent: null,
  records: 0,
  tracked: [],
  conflicts: [],
  pendingRestart: false,
  error: null,
}

let disposed = false
let profileDir = null
let webServer = null
let disposeRoute = null
/** @type {Map<string, {name: string, dir: string, version?: string}>} */
let plugins = new Map()
/** @type {Map<string, import('node:fs').FSWatcher>} */
const watchers = new Map()
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const timers = new Map()
let startupTimer = null
let periodicTimer = null
let rescanTimer = null
let lastWatcherRebuildAt = 0
/** profile 目录 / node_modules 的兜底监听（更新重装会替换插件目录，插件目录自身的 watch 可能失效）。 */
const profileWatchers = []
let globalRefreshTimer = null
let profileWatchArmed = false

/* --------------------------------------------------------------------- utils */

function log(line) {
  try {
    ensureDir(LOG_DIR)
    const file = path.join(LOG_DIR, 'patch-sync.log')
    const payload = `${new Date().toISOString()} ${line}\n`
    // 小体量日志直接 append，避免引入额外依赖。
    import('node:fs').then(({ appendFileSync }) => {
      try {
        appendFileSync(file, payload, 'utf8')
      } catch {
        /* ignore */
      }
    }).catch(() => {})
  } catch {
    /* ignore */
  }
}

function loadPersistedStatus() {
  try {
    const parsed = JSON.parse(readFileSync(STATUS_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      state.eventId = Number.isFinite(parsed.eventId) ? parsed.eventId : 0
      state.dismissedEventId = Number.isFinite(parsed.dismissedEventId) ? parsed.dismissedEventId : 0
    }
  } catch {
    /* 首次运行 */
  }
}

function snapshot() {
  return {
    phase: state.phase,
    profile: PROFILE,
    stateDir: STATE_DIR,
    records: state.records,
    tracked: state.tracked,
    conflicts: state.conflicts,
    pendingRestart: state.pendingRestart,
    eventId: state.eventId,
    dismissedEventId: state.dismissedEventId,
    lastEvent: state.lastEvent,
    updatedAt: state.updatedAt,
    error: state.error,
  }
}

async function writeStatus() {
  state.updatedAt = new Date().toISOString()
  try {
    await writeJsonAtomic(STATUS_FILE, snapshot())
  } catch (error) {
    log(`写状态失败：${String(error?.message ?? error)}`)
  }
}

/* ------------------------------------------------------------------- plugins */

async function refreshPlugins({ watch = true, restart = false } = {}) {
  const { collectProfilePlugins } = await import('./core.mjs')
  const result = await collectProfilePlugins({
    dshHome: DSH_HOME,
    profile: PROFILE,
    exclude: [...SELF_NAMES],
  })
  profileDir = result.profileDir
  const next = new Map(result.plugins.map((plugin) => [plugin.name, plugin]))
  const removed = []
  // 重装插件会替换整个包目录，目录级 fs.watch 可能已静默失效：profile 变化时立即重建；
  // 周期性重扫只在超过 WATCHER_REBUILD_MS 后才重建，避免每分钟重建 20+ 个监听与刷屏日志。
  const rebuild = restart || Date.now() - lastWatcherRebuildAt >= WATCHER_REBUILD_MS
  if (rebuild) {
    for (const watcher of watchers.values()) {
      try {
        watcher.close()
      } catch {
        /* ignore */
      }
    }
    watchers.clear()
    lastWatcherRebuildAt = Date.now()
  }
  for (const [pluginName, watcher] of watchers) {
    if (next.has(pluginName)) continue
    try {
      watcher.close()
    } catch {
      /* ignore */
    }
    watchers.delete(pluginName)
    removed.push(pluginName)
  }
  plugins = next
  state.tracked = [...next.keys()].sort()
  if (removed.length > 0) log(`停止监听已移除/禁用的插件：${removed.join('、')}`)
  const started = []
  if (watch) {
    for (const plugin of next.values()) {
      if (startWatch(plugin)) started.push(plugin.name)
    }
  }
  if (rebuild && watchers.size > 0) log(`重建监听：${watchers.size} 个插件`)
  else if (started.length > 0) log(`新增监听 ${started.length} 个插件：${started.join('、')}`)
  await writeStatus()
  return next
}

/** 开始监听某个插件目录；已监听返回 false。 */
function startWatch(plugin) {
  if (disposed || watchers.has(plugin.name)) return false
  try {
    const watcher = fsWatch(plugin.dir, { recursive: true }, () => {
      scheduleReconcile(plugin.name, 'watch')
    })
    watcher.on('error', (error) => {
      log(`监听失败 ${plugin.name}: ${String(error?.message ?? error)}`)
      try {
        watcher.close()
      } catch {
        /* ignore */
      }
      watchers.delete(plugin.name)
      // 目录被重装替换（更新场景）时会短暂报错：稍后重建监听并补一次对账。
      scheduleProfileRefresh(500)
      scheduleReconcile(plugin.name, 'watch-recover', 5000)
    })
    watchers.set(plugin.name, watcher)
    return true
  } catch (error) {
    log(`无法监听 ${plugin.name}: ${String(error?.message ?? error)}`)
    return false
  }
}

/** 自动更新插件是否正在安装（安装期间避免抢写文件）。 */
function installerBusy() {
  if (!profileDir) return false
  const autoUpdateDir = path.join(profileDir, 'node_modules', '@sueleven', 'dsh-auto-update')
  try {
    if (existsSync(path.join(autoUpdateDir, 'state', 'update.lock'))) return true
    const snapshotFile = path.join(autoUpdateDir, 'state', 'plugin-state.json')
    if (existsSync(snapshotFile)) {
      const parsed = JSON.parse(readFileSync(snapshotFile, 'utf8'))
      if (parsed?.phase === 'updating') return true
    }
  } catch {
    /* ignore */
  }
  return false
}

/* ----------------------------------------------------------------- reconcile */

/** profile 级兜底：node_modules 里任何增删改都可能是更新安装，触发重扫＋对账。 */
function scheduleProfileRefresh(delay = 1200) {
  if (disposed) return
  if (globalRefreshTimer !== null) clearTimeout(globalRefreshTimer)
  globalRefreshTimer = setTimeout(() => {
    globalRefreshTimer = null
    void onProfileChanged().catch((error) => log(`profile 变化处理失败：${String(error?.message ?? error)}`))
  }, delay)
  globalRefreshTimer.unref?.()
}

async function onProfileChanged() {
  if (disposed) return
  log('profile 目录发生变化：重扫插件并重建监听')
  await refreshPlugins({ watch: true, restart: true })
  await reconcileRecordedPlugins('profile-change')
}

/** 监听 profile 根目录与 node_modules（仅兜底，不做全量递归）。 */
function watchProfile() {
  if (profileWatchArmed || disposed || profileDir === null) return
  profileWatchArmed = true
  const targets = [profileDir, path.join(profileDir, 'node_modules')]
  for (const target of targets) {
    try {
      const watcher = fsWatch(target, { recursive: false }, () => scheduleProfileRefresh())
      watcher.on('error', () => {
        try {
          watcher.close()
        } catch {
          /* ignore */
        }
        // profile 目录被整体替换（极少见）时重新武装兜底监听。
        profileWatchArmed = false
        for (const item of profileWatchers.splice(0)) {
          try {
            item.close()
          } catch {
            /* ignore */
          }
        }
        const retry = setTimeout(() => watchProfile(), 3000)
        retry.unref?.()
      })
      profileWatchers.push(watcher)
      log(`监听 profile 路径：${target}`)
    } catch (error) {
      log(`无法监听 ${target}: ${String(error?.message ?? error)}`)
    }
  }
}

function scheduleReconcile(pluginName, trigger, delay = DEBOUNCE_MS) {
  if (disposed) return
  const existing = timers.get(pluginName)
  if (existing !== undefined) clearTimeout(existing)
  const timer = setTimeout(() => {
    timers.delete(pluginName)
    void runReconcile(pluginName, trigger).catch((error) => {
      log(`对账异常 ${pluginName}: ${String(error?.message ?? error)}`)
    })
  }, delay)
  timer.unref?.()
  timers.set(pluginName, timer)
}

/**
 * 每个插件同一时刻只跑一次对账。
 * 旧实现允许重叠：旧一轮还在读 record.json 时，新一轮的 saveRecord 会 rename 同一个文件，
 * Windows 上直接 EPERM（目标文件有打开句柄）。这里把重叠触发合并成"跑完再补一次"。
 */
const reconcileQueue = new Map()

async function runReconcile(pluginName, trigger, pluginOverride) {
  if (disposed) return
  const active = reconcileQueue.get(pluginName)
  if (active !== undefined) {
    active.pending = { trigger, pluginOverride }
    return
  }
  const slot = { pending: null }
  reconcileQueue.set(pluginName, slot)
  try {
    let current = { trigger, pluginOverride }
    let rounds = 0
    while (current !== null && rounds < 10) {
      rounds += 1
      await reconcileOnce(pluginName, current.trigger, current.pluginOverride)
      if (disposed) break
      current = slot.pending
      slot.pending = null
    }
    if (!disposed && slot.pending !== null) {
      const next = slot.pending
      slot.pending = null
      scheduleReconcile(pluginName, next.trigger, 500)
    }
  } finally {
    reconcileQueue.delete(pluginName)
  }
}

async function reconcileOnce(pluginName, trigger, pluginOverride) {
  const plugin = pluginOverride ?? plugins.get(pluginName)
  if (plugin === undefined) return
  if (installerBusy()) {
    scheduleReconcile(pluginName, trigger, 2000)
    return
  }
  state.phase = 'reconciling'
  let result
  try {
    result = await reconcilePlugin({
      plugin: pluginName,
      pluginDir: plugin.dir,
      stateDir: STATE_DIR,
      profile: PROFILE,
      // profile 里的依赖声明（link:/file:/版本号）：用于识别没有 registry 基线的本地插件。
      spec: plugin.spec ?? plugins.get(pluginName)?.spec,
    })
  } catch (error) {
    result = {
      plugin: pluginName,
      action: 'error',
      changed: true,
      recorded: [],
      restored: [],
      failed: [],
      conflicts: [],
      conflictsAdded: [],
      error: String(error?.message ?? error),
    }
  }
  await handleResult(result, trigger)
}

async function refreshAggregates() {
  const records = await listStateRecords()
  state.records = records.length
  state.conflicts = records.flatMap((record) => (record.conflicts ?? []).map((conflict) => ({
    plugin: record.plugin,
    path: conflict.path,
    reason: conflict.reason,
    upstreamSha256: conflict.upstreamSha256,
    expectedBaseSha256: conflict.expectedBaseSha256,
    at: conflict.at,
  })))
}

/** 读全部记录；单条读失败只记日志，避免拖垮状态/报告。 */
function listStateRecords() {
  return listRecords(STATE_DIR, {
    onError: (plugin, error) => log(`记录读取失败 ${plugin}: ${String(error?.message ?? error)}`),
  })
}

function eventKind(result) {
  if (result.action === 'error') return 'error'
  if (result.action === 'restored') return (result.conflictsAdded ?? []).length > 0 ? 'conflict' : 'restored'
  if (result.action === 'recorded' && result.changed) return 'recorded'
  if (result.action === 'cleaned' && result.changed) return 'cleaned'
  return null
}

function eventMessage(result) {
  switch (result.action) {
    case 'restored': {
      const restored = (result.restored ?? []).length
      const conflicts = (result.conflictsAdded ?? []).length
      const failed = (result.failed ?? []).length
      const parts = [`已恢复 ${result.plugin} 的补丁（${restored} 个文件`]
      if (conflicts > 0) parts.push(`，${conflicts} 个文件因上游变更保留原文件`)
      if (failed > 0) parts.push(`，${failed} 个文件恢复失败`)
      parts.push('），重启 DSH 后生效。')
      return parts.join('')
    }
    case 'conflict':
      return `检测到 ${result.plugin} 的上游文件冲突，已保留原文件：${(result.conflictsAdded ?? []).map((item) => item.path).slice(0, 5).join('、')}${(result.conflictsAdded ?? []).length > 5 ? ' 等' : ''}。`
    case 'error':
      return `补丁同步失败：${result.error ?? '未知错误'}`
    case 'recorded':
      return `已记录 ${result.plugin} 的 ${(result.recorded ?? []).length} 个修改文件。`
    case 'cleaned':
      return `已清除 ${result.plugin} 的补丁记录（文件已与官方一致）。`
    default:
      return ''
  }
}

async function writeReport(event, result) {
  const lines = [
    `# 补丁同步报告 · ${event.at}`,
    '',
    `- 事件：${event.kind}`,
    `- 插件：${event.plugin}`,
    `- 触发：${event.trigger}`,
    `- 版本：${result.version ?? '?'}`,
    `- 恢复：${(result.restored ?? []).length} 个文件`,
    `- 记录：${(result.recorded ?? []).length} 个文件`,
    `- 失败：${(result.failed ?? []).length} 个文件`,
    `- 冲突：${(result.conflictsAdded ?? []).length} 个文件`,
    '',
  ]
  if (event.message) lines.push(event.message, '')
  const conflicts = result.conflictsAdded ?? []
  if (conflicts.length > 0) {
    lines.push('## 冲突（已保留上游文件）', '')
    for (const conflict of conflicts) {
      lines.push(`- \`${event.plugin}\` → \`${conflict.path}\`：${conflict.reason ?? '上游变更'}`)
    }
    lines.push('')
    lines.push('解决方式：手动把你的修改重新应用到该文件后，运行 `node <插件目录>/lib/cli.mjs scan` 重新记录；或接受上游：`node <插件目录>/lib/cli.mjs resolve <插件名> --accept-upstream`。')
    lines.push('')
  }
  const failed = result.failed ?? []
  if (failed.length > 0) {
    lines.push('## 恢复失败', '')
    for (const item of failed) lines.push(`- \`${item.path}\`：${item.reason}`)
    lines.push('')
  }
  lines.push(`补丁记录目录：\`${path.join(STATE_DIR, 'records')}\``)
  lines.push('')
  const text = lines.join('\n')
  try {
    await ensureDir(REPORT_DIR)
    await writeJsonAtomic(path.join(REPORT_DIR, 'latest.json'), event)
    await writeFileAtomic(path.join(REPORT_DIR, 'latest.md'), text)
    await writeFileAtomic(path.join(REPORT_DIR, `${event.at.replace(/[:.]/g, '-')}-${event.kind}.md`), text)
  } catch (error) {
    log(`写报告失败：${String(error?.message ?? error)}`)
  }
}

async function handleResult(result, trigger) {
  await refreshAggregates()
  if (result.action === 'unmanaged') {
    // 本地/私有插件没有官方基线：只记一次日志，不弹失败提示卡、不写失败报告。
    if (!unmanagedNotices.has(result.plugin)) {
      unmanagedNotices.add(result.plugin)
      log(`跳过自动对账 ${result.plugin}：${result.warning ?? '本地/私有插件没有官方基线'}`)
    }
    state.phase = state.conflicts.length > 0 ? 'conflict' : 'idle'
    state.error = null
    await writeStatus()
    return
  }
  const kind = eventKind(result)
  if (kind === null) {
    state.phase = state.conflicts.length > 0 ? 'conflict' : 'idle'
    state.error = result.action === 'error' ? result.error ?? null : state.error
    await writeStatus()
    return
  }
  state.eventId += 1
  const event = {
    id: state.eventId,
    at: new Date().toISOString(),
    kind,
    plugin: result.plugin,
    trigger,
    version: result.version ?? null,
    recorded: (result.recorded ?? []).length,
    restored: (result.restored ?? []).length,
    failed: result.failed ?? [],
    conflictsAdded: (result.conflictsAdded ?? []).map((conflict) => ({
      path: conflict.path,
      reason: conflict.reason,
      upstreamSha256: conflict.upstreamSha256,
      expectedBaseSha256: conflict.expectedBaseSha256,
    })),
    warning: result.warning ?? null,
    message: eventMessage(result),
  }
  state.lastEvent = event
  state.error = kind === 'error' ? result.error ?? event.message : null
  state.phase = kind === 'error' ? 'error' : kind === 'conflict' ? 'conflict' : 'idle'
  if ((result.restored ?? []).length > 0) state.pendingRestart = true
  log(`[${kind}] ${event.message}`)
  await writeReport(event, result)
  await writeStatus()
}

/* ----------------------------------------------------------------- lifecycle */

async function bootstrap() {
  if (disposed) return
  try {
    const selfPkg = await readJson(path.join(SELF_DIR, '..', 'package.json'))
    log(`启动 pid=${process.pid} version=${selfPkg?.version ?? '?'} profile=${PROFILE} state=${STATE_DIR}`)
    // 清掉上次崩溃/rename 长期失败留下的 *.tmp-<pid>-* 残留。
    const staleTemps = await cleanupStaleTemps(STATE_DIR).catch(() => [])
    if (staleTemps.length > 0) log(`已清理 ${staleTemps.length} 个残留临时文件`)
    await refreshPlugins({ watch: false })
    state.phase = 'booting'
    await writeStatus()
    const records = await listStateRecords()
    for (const record of records) {
      if (disposed) return
      const dir = path.join(profileDir ?? '', 'node_modules', record.plugin)
      const version = await readPluginVersion(dir).catch(() => null)
      if (!version) {
        log(`记录 ${record.plugin} 未安装，跳过启动恢复`)
        continue
      }
      await runReconcile(record.plugin, 'startup', { name: record.plugin, dir })
    }
    await refreshPlugins({ watch: true })
    watchProfile()
    state.phase = state.conflicts.length > 0 ? 'conflict' : 'idle'
    await writeStatus()

    periodicTimer = setInterval(() => {
      void reconcileRecordedPlugins('periodic').catch(() => {})
    }, PERIODIC_MS)
    periodicTimer.unref?.()
    rescanTimer = setInterval(() => {
      if (!profileWatchArmed) watchProfile()
      // 只重扫插件列表；全量重建监听由 refreshPlugins 内部的 10 分钟兜底策略决定。
      void refreshPlugins({ watch: true }).catch((error) => log(`重新扫描插件失败：${String(error?.message ?? error)}`))
    }, RESCAN_MS)
    rescanTimer.unref?.()
    log(`初始化完成：跟踪 ${state.tracked.length} 个插件，记录 ${state.records} 个`)
  } catch (error) {
    state.phase = 'error'
    state.error = String(error?.message ?? error)
    log(`初始化失败：${state.error}`)
    await writeStatus()
  }
}

async function reconcileRecordedPlugins(trigger) {
  const records = await listStateRecords()
  for (const record of records) {
    if (disposed) return
    const dir = path.join(profileDir ?? '', 'node_modules', record.plugin)
    const version = await readPluginVersion(dir).catch(() => null)
    if (!version) continue
    await runReconcile(record.plugin, trigger, { name: record.plugin, dir })
  }
}

/* -------------------------------------------------------------------- routes */

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function createHandler() {
  return (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const pathname = url.pathname
      if (!pathname.startsWith(ROUTE_PREFIX)) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      const route = pathname.slice(ROUTE_PREFIX.length) || '/'
      const method = req.method ?? 'GET'
      if (method === 'GET' && route === '/status') {
        sendJson(res, 200, snapshot())
        return
      }
      if (method === 'POST' && route === '/dismiss') {
        state.dismissedEventId = state.eventId
        void writeStatus()
        sendJson(res, 200, snapshot())
        return
      }
      if (method === 'POST' && route === '/scan') {
        void (async () => {
          await refreshPlugins({ watch: true })
          await reconcileRecordedPlugins('manual')
        })().catch((error) => log(`手动扫描失败：${String(error?.message ?? error)}`))
        sendJson(res, 202, snapshot())
        return
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }
}

/* --------------------------------------------------------------------- entry */

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  // 插件热重载（link 目标文件变化 / profile 变化）会再次执行 apply。
  // 旧实例必须先彻底退出：否则 webServer 会拒绝重复注册 prefix 路由，且两个
  // 实例会同时监听、重复写状态。旧实例把自己的 shutdown 挂在进程级 Symbol 上。
  const previous = globalThis[RUNTIME_KEY]
  if (previous !== undefined && typeof previous.shutdown === 'function') {
    try {
      previous.shutdown('replaced-by-reload')
    } catch {
      /* ignore */
    }
  }
  disposed = false

  loadPersistedStatus()
  try {
    ensureDir(STATE_DIR)
    ensureDir(LOG_DIR)
  } catch {
    /* ignore */
  }
  if (process.env.DSH_PATCH_SYNC_DISABLE === '1') {
    log('已被 DSH_PATCH_SYNC_DISABLE=1 关闭')
    return
  }

  let stopped = false
  const handle = {
    /** 幂等退出：清定时器、关监听、注销路由、释放单例标记。 */
    shutdown(reason) {
      if (stopped) return
      stopped = true
      disposed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      if (startupTimer !== null) clearTimeout(startupTimer)
      if (periodicTimer !== null) clearInterval(periodicTimer)
      if (rescanTimer !== null) clearInterval(rescanTimer)
      if (globalRefreshTimer !== null) clearTimeout(globalRefreshTimer)
      startupTimer = null
      periodicTimer = null
      rescanTimer = null
      globalRefreshTimer = null
      for (const watcher of watchers.values()) {
        try {
          watcher.close()
        } catch {
          /* ignore */
        }
      }
      watchers.clear()
      for (const watcher of profileWatchers) {
        try {
          watcher.close()
        } catch {
          /* ignore */
        }
      }
      profileWatchers.length = 0
      profileWatchArmed = false
      try {
        disposeRoute?.()
      } catch {
        /* ignore */
      }
      disposeRoute = null
      if (globalThis[RUNTIME_KEY] === handle) delete globalThis[RUNTIME_KEY]
      log(`插件退出（${reason}）：监听/定时器已停止`)
    },
  }
  globalThis[RUNTIME_KEY] = handle

  try {
    webServer = ctx.webServer
    if (webServer !== undefined && typeof webServer.register === 'function') {
      disposeRoute = webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: createHandler() })
    } else {
      log('未找到 webServer，提示卡不可用；记录/恢复仍会运行')
    }
  } catch (error) {
    log(`注册路由失败（可能仍有旧实例未退出）：${String(error?.message ?? error)}`)
  }

  startupTimer = setTimeout(() => {
    void bootstrap().catch((error) => log(`启动失败：${String(error?.message ?? error)}`))
  }, STARTUP_DELAY_MS)
  startupTimer.unref?.()

  // 注意：当前 DSH 所带 cordis 运行时不会 emit 'dispose' 事件（ctx.on('dispose') 为空挂）；
// 必须用 ctx.effect 注册清理，否则 25 个插件目录 + 2 个 profile 的 fs.watch 句柄
// 会在 Host 退出时残留，把进程拖到 10~15s 后被强杀。
ctx.effect(() => () => handle.shutdown('ctx-dispose'), 'dsh-patch-sync.dispose')
}
