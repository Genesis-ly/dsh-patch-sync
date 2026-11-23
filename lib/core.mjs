/**
 * dsh-patch-sync —— 核心逻辑（纯函数 + 文件系统操作），宿主半与 CLI 共用。
 *
 * 概念：
 * - baseline：某个插件某个版本的官方文件哈希快照。来源优先级：
 *     `--base-dir` 指定的目录 > 从 npm registry 下载该版本 tarball 计算。
 *   缓存在 <state>/baseline/<encoded-plugin>/<version>.json。
 * - record：一个插件当前"用户修改"的完整记录，包括被修改/新增/删除的文件、
 *   每个文件的官方基线哈希、打过补丁后的哈希，以及补丁文件本体
 *   （<state>/records/<encoded-plugin>/patched/<path>）。
 * - reconcile：对账入口。没有记录时对比 baseline 自动生成记录；版本变了
 *   （插件被官方更新覆盖）时按记录恢复并校验；同版本变化视为用户继续修改，
 *   更新记录。
 * - 冲突：更新后上游文件哈希与记录里的 baseline 哈希不一致（上游改过这个
 *   文件）——保留上游文件、不覆盖，记入 conflicts 供宿主/CLI 提示用户。
 *
 * 记录范围（与宿主半一致）：插件包目录内除 node_modules/、state/、logs/、
 * cache/ 等运行时目录与 *.log/*.tmp/*.lock 之外的普通文件。
 * @module dsh-patch-sync/core
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fetchRegistryBaseline } from './registry.mjs'

/** 记录格式版本。 */
export const SCHEMA_VERSION = 1

/** 目录名黑名单（任意层级命中即跳过）。 */
const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'state',
  'logs',
  'cache',
  '.cache',
  'tmp',
  '.turbo',
  '.plugin-manager',
])

/** 文件名黑名单。 */
const EXCLUDED_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** 运行时文件后缀黑名单。 */
const EXCLUDED_FILE_PATTERN = /\.(?:log|tmp|lock|swp|swo|bak-\d+)$/i

/** 是否为不该参与记录/恢复的相对路径（用 `/` 分隔）。 */
export function isExcludedRel(rel) {
  const parts = rel.split('/').filter(Boolean)
  if (parts.length === 0) return true
  if (parts.some((part) => EXCLUDED_DIR_NAMES.has(part))) return true
  const base = parts[parts.length - 1]
  if (EXCLUDED_FILE_NAMES.has(base)) return true
  if (EXCLUDED_FILE_PATTERN.test(base)) return true
  if (base.includes('.pe-patch.tmp')) return true
  return false
}

/** 计算一段字节的 sha256（hex）。 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** 递归创建目录。 */
export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

/* --------------------------------------------------------------- 原子写加固 */

/**
 * Windows 上 `rename(tmp, target)` 在目标文件被短暂占用时会返回 EPERM：
 * - 同进程/其它进程正在读取目标文件（Windows 不允许替换有打开句柄的文件）；
 * - 杀毒/索引服务刚扫描过临时文件或目标文件；
 * - 两个写者同时对同一目标 rename（也可能出现 EPERM/ENOENT）。
 * 旧实现只尝试一次，失败就把整个对账判为 error，并留下 *.tmp-<pid>-<ms> 残留。
 * 这里改为：临时名唯一（同毫秒不重名）+ 按目标路径串行 + 瞬时错误退避重试。
 */
const WRITE_ATTEMPTS = 10
const WRITE_RETRY_BASE_MS = 8
const WRITE_RETRY_MAX_MS = 250

/** 可重试的瞬时文件系统错误码。 */
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST', 'ENOENT', 'EMFILE', 'ENFILE'])

/** 原子写临时文件名：<目标>.tmp-<pid>-<毫秒>-<自增序号>。 */
const TEMP_FILE_PATTERN = /\.tmp-\d+-\d+(?:-\d+)?$/

let tempSeq = 0

/** 是否为可重试的瞬时文件系统错误。 */
function isTransientFsError(error) {
  return Boolean(error) && typeof error.code === 'string' && TRANSIENT_FS_CODES.has(error.code)
}

/** 睡眠（毫秒）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 生成临时文件路径；同一进程同一毫秒内多次调用也互不相同。 */
export function tempPathFor(file) {
  tempSeq = (tempSeq + 1) % 1_000_000_007
  return `${file}.tmp-${process.pid}-${Date.now()}-${tempSeq}`
}

/** 是否为原子写临时文件名（用于清理残留）。 */
export function isTempFileName(name) {
  return TEMP_FILE_PATTERN.test(name)
}

/** 进程内按目标路径串行化写入：避免并发写同一文件互相踩踏（Windows 上 rename 会 EPERM/ENOENT）。 */
const writeLocks = new Map()

function lockKey(file) {
  const resolved = path.resolve(file)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function withFileLock(file, task) {
  const key = lockKey(file)
  const previous = writeLocks.get(key) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(task)
  const tail = run.catch(() => {})
  writeLocks.set(key, tail)
  tail.then(() => {
    if (writeLocks.get(key) === tail) writeLocks.delete(key)
  })
  return run
}

/** 写一次临时文件并 rename；失败时清理临时文件。 */
async function writeTempAndRename(file, data) {
  const tmp = tempPathFor(file)
  try {
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** 原子写文件字节：按路径串行 + 唯一临时名 + 瞬时错误退避重试。 */
export async function writeFileAtomic(file, data, options = {}) {
  const target = path.resolve(file)
  return withFileLock(target, async () => {
    const attempts = Number.isFinite(options.attempts) ? options.attempts : WRITE_ATTEMPTS
    let lastError
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await ensureDir(path.dirname(target))
        await writeTempAndRename(target, data)
        return
      } catch (error) {
        lastError = error
        if (!isTransientFsError(error) || attempt === attempts - 1) break
        const delay = Math.min(WRITE_RETRY_MAX_MS, WRITE_RETRY_BASE_MS * 2 ** attempt)
        await sleep(Math.max(1, Math.round(delay * (0.5 + Math.random() * 0.5))))
      }
    }
    const detail = lastError?.message ?? String(lastError)
    const wrapped = new Error(`原子写失败（尝试 ${attempts} 次）：${target}：${detail}`)
    wrapped.code = lastError?.code
    wrapped.cause = lastError
    throw wrapped
  })
}

/** 原子写 JSON（唯一临时文件 + 串行 + 重试）。 */
export async function writeJsonAtomic(file, value, options = {}) {
  return writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options)
}

/**
 * 读文件（瞬时错误重试）。
 * @returns {Promise<Buffer|string>}
 */
async function readFileRetry(file, encoding) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fs.readFile(file, encoding)
    } catch (error) {
      lastError = error
      if (!isTransientFsError(error) || attempt === 2) break
      await sleep(10 * (attempt + 1))
    }
  }
  throw lastError
}

/** 读 JSON；瞬时错误重试，最终失败返回 fallback。 */
export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFileRetry(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * 清理原子写残留的临时文件（进程崩溃、rename 长期失败留下的 *.tmp-<pid>-<ms>[-<seq>]）。
 * 只删除超过 maxAgeMs 的，避免误删正在写入的临时文件。
 * @param {string} rootDir
 * @param {{maxAgeMs?: number, now?: number}} [options]
 * @returns {Promise<string[]>} 被删除的文件路径
 */
export async function cleanupStaleTemps(rootDir, options = {}) {
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : 10 * 60 * 1000
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const removed = []
  async function walk(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        await walk(abs)
        continue
      }
      if (!entry.isFile() || !isTempFileName(entry.name)) continue
      let stat
      try {
        stat = await fs.stat(abs)
      } catch {
        continue
      }
      if (now - stat.mtimeMs < maxAgeMs) continue
      try {
        await fs.rm(abs, { force: true })
        removed.push(abs)
      } catch {
        // 删不掉就下次启动再试。
      }
    }
  }
  if (typeof rootDir === 'string' && rootDir !== '') await walk(rootDir)
  return removed
}

/** 插件名 → 目录安全键（可逆编码，保留 scoped 名称信息）。 */
export function pluginKey(name) {
  return encodeURIComponent(name)
}

/** 记录目录。 */
export function recordDir(stateDir, plugin) {
  return path.join(stateDir, 'records', pluginKey(plugin))
}

/** 记录文件。 */
export function recordFile(stateDir, plugin) {
  return path.join(recordDir(stateDir, plugin), 'record.json')
}

/** 补丁文件本体路径。 */
export function patchedFile(stateDir, plugin, rel) {
  return path.join(recordDir(stateDir, plugin), 'patched', ...rel.split('/'))
}

/** 基线缓存路径。 */
export function baselineFile(stateDir, plugin, version) {
  return path.join(stateDir, 'baseline', pluginKey(plugin), `${version}.json`)
}

/** 断言相对路径安全（不允许绝对路径/穿越）。 */
export function assertSafeRel(rel) {
  if (typeof rel !== 'string' || rel === '') throw new Error('空的相对路径')
  if (path.isAbsolute(rel)) throw new Error(`不安全的绝对路径: ${rel}`)
  const normalized = rel.split('/').filter(Boolean)
  if (normalized.some((part) => part === '..' || part === '.')) throw new Error(`不安全的相对路径: ${rel}`)
  return normalized.join('/')
}

/** 读取插件 package.json 里的版本。 */
export async function readPluginVersion(pluginDir) {
  const pkg = await readJson(path.join(pluginDir, 'package.json'))
  return typeof pkg?.version === 'string' ? pkg.version : null
}

/**
 * 计算一棵目录树内（排除规则见 isExcludedRel）的文件哈希。
 * @returns {Promise<Map<string, string>>} relPath(/) → sha256
 */
export async function hashTree(root) {
  /** @type {Map<string, string>} */
  const files = new Map()
  async function walk(dir, prefix) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (isExcludedRel(rel)) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs, rel)
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      try {
        files.set(rel, sha256(await fs.readFile(abs)))
      } catch {
        // 读不到的文件（权限/瞬时删除）不参与记录。
      }
    }
  }
  await walk(root, '')
  return files
}

/** 单文件哈希；不存在返回 undefined。 */
export async function hashFile(pluginDir, rel) {
  try {
    return sha256(await fs.readFile(path.join(pluginDir, ...assertSafeRel(rel).split('/'))))
  } catch {
    return undefined
  }
}

/** 对比两个哈希表，返回改动列表。 */
export function diffTrees(baseFiles, currentFiles) {
  const paths = new Set([...baseFiles.keys(), ...currentFiles.keys()])
  const diff = []
  for (const rel of [...paths].sort()) {
    const base = baseFiles.get(rel)
    const current = currentFiles.get(rel)
    if (base === current) continue
    if (base === undefined) diff.push({ path: rel, kind: 'added' })
    else if (current === undefined) diff.push({ path: rel, kind: 'deleted' })
    else diff.push({ path: rel, kind: 'modified' })
  }
  return diff
}

/* ------------------------------------------------------------------ baseline */

/** 非 registry 来源的依赖声明（本地目录/链接安装）。 */
const NON_REGISTRY_SPEC_PATTERN = /^(?:link|file|workspace|portal|patch|git\+|github|gitlab|bitbucket|https?):/i

/** 依赖声明是否指向本地/非 registry 来源。 */
export function isLocalPluginSpec(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') return false
  const value = spec.trim()
  if (NON_REGISTRY_SPEC_PATTERN.test(value)) return true
  if (path.isAbsolute(value)) return true
  if (value.startsWith('.') || value.includes('://')) return true
  return false
}

/**
 * 判断插件是否来自本地/私有来源（没有 npm 官方基线可拉取）。
 * 优先信任 profile 里的依赖声明；没传 spec（如 CLI 直接调用）时退回
 * 「安装目录是符号链接」或「package.json private:true」判断。
 */
async function looksLikeLocalPlugin(pluginDir, spec) {
  if (typeof spec === 'string' && spec.trim() !== '') return isLocalPluginSpec(spec)
  try {
    const stat = await fs.lstat(pluginDir)
    if (stat.isSymbolicLink()) return true
  } catch {
    // 目录不存在时交给后续版本检查报错
  }
  const pkg = await readJson(path.join(pluginDir, 'package.json'))
  return pkg?.private === true
}

/**
 * 读取已缓存的基线（不联网）。
 * @returns {Promise<{plugin: string, version: string, source: string, files: Map<string,string>} | null>}
 */
export async function cachedBaseline(stateDir, plugin, version) {
  const cached = await readJson(baselineFile(stateDir, plugin, version))
  if (!cached || !cached.files || typeof cached.files !== 'object') return null
  return {
    plugin,
    version,
    source: String(cached.source ?? 'cache'),
    files: new Map(Object.entries(cached.files)),
  }
}

/**
 * 获取（或计算）某插件某版本的官方基线哈希。
 * @param {{plugin: string, version: string, stateDir: string, baseDir?: string}} options
 * @returns {Promise<{plugin: string, version: string, source: string, files: Map<string,string>} | null>}
 */
export async function ensureBaseline({ plugin, version, stateDir, baseDir }) {
  const cached = await cachedBaseline(stateDir, plugin, version)
  if (cached) return cached
  const cachePath = baselineFile(stateDir, plugin, version)
  let files = null
  let source = null
  if (typeof baseDir === 'string' && baseDir !== '') {
    files = await hashTree(baseDir)
    source = 'dir'
  } else {
    try {
      const fetched = await fetchRegistryBaseline(plugin, version)
      files = fetched.files
      source = 'registry'
    } catch {
      return null
    }
  }
  if (files === null) return null
  await writeJsonAtomic(cachePath, {
    plugin,
    version,
    source,
    capturedAt: new Date().toISOString(),
    files: Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b))),
  })
  return { plugin, version, source, files }
}

/* -------------------------------------------------------------------- record */

/**
 * 读取记录。
 * 记录不存在返回 null；读失败（权限/占用）或 JSON 损坏时抛错——
 * 不能静默当成"没有记录"，否则后续会自动重建记录、丢掉已有补丁信息。
 */
export async function loadRecord(stateDir, plugin) {
  const file = recordFile(stateDir, plugin)
  let raw
  try {
    raw = await readFileRetry(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  let record
  try {
    record = JSON.parse(raw)
  } catch (error) {
    throw new Error(`补丁记录损坏（${file}）：${error.message}`)
  }
  if (!record || record.schema !== SCHEMA_VERSION || !Array.isArray(record.files)) return null
  if (!Array.isArray(record.conflicts)) record.conflicts = []
  return record
}

/** 写入记录。 */
export async function saveRecord(stateDir, plugin, record) {
  await writeJsonAtomic(recordFile(stateDir, plugin), record)
}

/** 删除记录（含补丁文件本体）。 */
export async function deleteRecord(stateDir, plugin) {
  await fs.rm(recordDir(stateDir, plugin), { recursive: true, force: true })
}

/**
 * 列出所有插件记录（按插件名排序）。
 * 单条记录损坏/暂时读不到只跳过，不拖垮整体状态；`options.onError` 可拿到失败详情。
 * @param {string} stateDir
 * @param {{onError?: (plugin: string, error: Error) => void}} [options]
 */
export async function listRecords(stateDir, options = {}) {
  const root = path.join(stateDir, 'records')
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const records = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let name
    try {
      name = decodeURIComponent(entry.name)
    } catch {
      name = entry.name
    }
    let record
    try {
      record = await loadRecord(stateDir, name)
    } catch (error) {
      if (typeof options.onError === 'function') options.onError(name, error)
      continue
    }
    if (record) records.push(record)
  }
  return records.sort((a, b) => String(a.plugin).localeCompare(String(b.plugin)))
}

/** 记录指纹，用于判断本次对账是否真的有变化。 */
export function recordSignature(record) {
  if (!record) return 'none'
  return JSON.stringify({
    version: record.recordedVersion,
    files: (record.files ?? []).map((file) => [file.path, file.kind, file.baseSha256 ?? null, file.patchedSha256 ?? null]),
    conflicts: (record.conflicts ?? []).map((conflict) => [conflict.path, conflict.upstreamSha256 ?? null]),
  })
}

/* ------------------------------------------------------------------- helpers */

async function storePatched(stateDir, plugin, pluginDir, rel) {
  const data = await fs.readFile(path.join(pluginDir, ...assertSafeRel(rel).split('/')))
  const sha = sha256(data)
  const target = patchedFile(stateDir, plugin, rel)
  // 内容没变就不重写：减少状态目录写入，也缩小 Windows 上 rename 的竞争窗口。
  const existing = await fs.readFile(target).catch(() => null)
  if (existing !== null && existing.equals(data)) return sha
  await writeFileAtomic(target, data)
  return sha
}

async function readPatched(stateDir, plugin, rel) {
  return fs.readFile(patchedFile(stateDir, plugin, rel))
}

async function removePatched(stateDir, plugin, rel) {
  await fs.rm(patchedFile(stateDir, plugin, rel), { force: true })
}

/** 清理不再被记录引用的补丁文件本体。 */
async function prunePatched(stateDir, plugin, record) {
  const used = new Set(
    (record.files ?? [])
      .filter((file) => file.kind !== 'deleted' && file.patchedSha256 !== undefined)
      .map((file) => file.path),
  )
  const root = path.join(recordDir(stateDir, plugin), 'patched')
  async function walk(dir, prefix) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs, rel)
        continue
      }
      if (!used.has(rel)) await fs.rm(abs, { force: true })
    }
  }
  await walk(root, '')
}

/** 从 diff 生成记录条目（同时落盘补丁文件本体）。 */
async function entriesFromDiff({ diff, baselineFiles, plugin, pluginDir, stateDir }) {
  const entries = []
  for (const item of diff) {
    const rel = assertSafeRel(item.path)
    const baseSha256 = baselineFiles.get(rel)
    if (item.kind === 'deleted') {
      entries.push({ path: rel, kind: 'deleted', baseSha256 })
      await removePatched(stateDir, plugin, rel)
      continue
    }
    let patchedSha256
    try {
      patchedSha256 = await storePatched(stateDir, plugin, pluginDir, rel)
    } catch {
      continue // 读不到就跳过，下一次对账再试
    }
    entries.push({ path: rel, kind: item.kind, baseSha256, patchedSha256 })
  }
  return entries
}

/** 建一条冲突记录。 */
function conflictOf(entry, upstreamSha256, reason) {
  return {
    path: entry.path,
    kind: entry.kind,
    expectedBaseSha256: entry.baseSha256,
    upstreamSha256: upstreamSha256 ?? null,
    reason,
    at: new Date().toISOString(),
  }
}

/* ------------------------------------------------------------ record / restore */

/**
 * 用当前安装内容 + 官方基线重新对齐记录（同版本编辑，或恢复之后刷新版本基线）。
 * 已存在冲突的文件不会被静默清掉：除非用户已手动写回与补丁一致的内容。
 */
async function realignRecord({ record, plugin, pluginDir, stateDir, version, baseline }) {
  const current = await hashTree(pluginDir)
  const baselineFiles = baseline?.files ?? new Map()
  const diff = diffTrees(baselineFiles, current)
  const diffMap = new Map(diff.map((item) => [item.path, item]))
  const conflictMap = new Map((record.conflicts ?? []).map((conflict) => [conflict.path, conflict]))
  const oldMap = new Map((record.files ?? []).map((file) => [file.path, file]))
  const paths = new Set([...diffMap.keys(), ...oldMap.keys(), ...conflictMap.keys()])
  const files = []
  for (const rel of [...paths].sort()) {
    const conflict = conflictMap.get(rel)
    const old = oldMap.get(rel)
    const currentSha = current.get(rel)
    if (conflict) {
      if (currentSha !== undefined && old?.patchedSha256 === currentSha) {
        // 用户已把补丁内容写回（或恢复成功）：解除冲突，按正常条目处理。
        conflictMap.delete(rel)
      } else {
        conflict.upstreamSha256 = currentSha ?? null
        if (baselineFiles.get(rel) !== undefined) conflict.expectedBaseSha256 = baselineFiles.get(rel)
        files.push({
          ...(old ?? { path: rel, kind: 'modified' }),
          path: rel,
          kind: old?.kind ?? (baselineFiles.get(rel) === undefined ? 'added' : 'modified'),
          baseSha256: baselineFiles.get(rel) ?? old?.baseSha256,
          patchedSha256: old?.patchedSha256,
          conflict: true,
        })
        continue
      }
    }
    const item = diffMap.get(rel)
    if (!item) {
      // 与基线一致且无冲突：用户撤回了补丁，丢弃该条目。
      await removePatched(stateDir, plugin, rel)
      continue
    }
    if (item.kind === 'deleted') {
      files.push({ path: rel, kind: 'deleted', baseSha256: baselineFiles.get(rel) })
      await removePatched(stateDir, plugin, rel)
      continue
    }
    let patchedSha256
    try {
      patchedSha256 = await storePatched(stateDir, plugin, pluginDir, rel)
    } catch {
      continue
    }
    files.push({
      path: rel,
      kind: item.kind,
      baseSha256: baselineFiles.get(rel),
      patchedSha256,
    })
  }
  record.files = files
  record.conflicts = [...conflictMap.values()]
  record.recordedVersion = version
  record.updatedAt = new Date().toISOString()
  return record
}

/**
 * 恢复一条记录：对每个补丁文件，若当前文件仍是记录里的"官方基线版本"则写回
 * 补丁；若上游已经改过则保留上游、记为冲突；若已经是补丁内容则跳过。
 * 恢复后逐文件校验哈希。
 */
async function restoreRecord({ record, plugin, pluginDir, stateDir }) {
  const restored = []
  const failed = []
  const newConflicts = []
  const resolved = []
  const conflicts = [...(record.conflicts ?? [])]
  const conflictIndexByPath = new Map(conflicts.map((conflict, index) => [conflict.path, index]))

  for (const entry of record.files ?? []) {
    const rel = assertSafeRel(entry.path)
    const target = path.join(pluginDir, ...rel.split('/'))
    const currentSha = await hashFile(pluginDir, rel)
    const conflictIndex = conflictIndexByPath.get(rel)

    if (entry.kind === 'deleted') {
      if (currentSha === undefined) {
        if (conflictIndex !== undefined) {
          conflicts.splice(conflictIndex, 1)
          conflictIndexByPath.clear()
          conflicts.forEach((item, index) => conflictIndexByPath.set(item.path, index))
          resolved.push(rel)
        }
        continue
      }
      if (currentSha === entry.baseSha256) {
        try {
          await fs.rm(target, { force: true })
          if ((await hashFile(pluginDir, rel)) === undefined) restored.push(rel)
          else failed.push({ path: rel, reason: '删除后文件仍存在' })
        } catch (error) {
          failed.push({ path: rel, reason: String(error?.message ?? error) })
        }
        continue
      }
      if (conflictIndex === undefined) {
        conflicts.push(conflictOf(entry, currentSha, '上游文件内容与记录基线不一致，未删除'))
        conflictIndexByPath.set(rel, conflicts.length - 1)
      }
      continue
    }

    if (currentSha === entry.patchedSha256) {
      if (conflictIndex !== undefined) {
        conflicts.splice(conflictIndex, 1)
        conflictIndexByPath.clear()
        conflicts.forEach((item, index) => conflictIndexByPath.set(item.path, index))
        resolved.push(rel)
      }
      continue
    }
    if (conflictIndex !== undefined) continue // 既有冲突：不自动覆盖上游

    if (entry.kind === 'modified') {
      if (currentSha === undefined) {
        conflicts.push(conflictOf(entry, undefined, '上游删除了该文件'))
        conflictIndexByPath.set(rel, conflicts.length - 1)
        continue
      }
      if (currentSha !== entry.baseSha256) {
        conflicts.push(conflictOf(entry, currentSha, '上游修改了该文件'))
        conflictIndexByPath.set(rel, conflicts.length - 1)
        continue
      }
      try {
        const data = await readPatched(stateDir, plugin, rel)
        await writeFileAtomic(target, data)
        const checkSha = await hashFile(pluginDir, rel)
        if (checkSha === entry.patchedSha256) restored.push(rel)
        else failed.push({ path: rel, reason: '写入后哈希校验失败' })
      } catch (error) {
        failed.push({ path: rel, reason: String(error?.message ?? error) })
      }
      continue
    }

    if (entry.kind === 'added') {
      if (currentSha !== undefined) {
        conflicts.push(conflictOf(entry, currentSha, '上游已存在同名文件'))
        conflictIndexByPath.set(rel, conflicts.length - 1)
        continue
      }
      try {
        const data = await readPatched(stateDir, plugin, rel)
        await writeFileAtomic(target, data)
        const checkSha = await hashFile(pluginDir, rel)
        if (checkSha === entry.patchedSha256) restored.push(rel)
        else failed.push({ path: rel, reason: '写入后哈希校验失败' })
      } catch (error) {
        failed.push({ path: rel, reason: String(error?.message ?? error) })
      }
    }
  }

  record.conflicts = conflicts
  record.updatedAt = new Date().toISOString()
  return { restored, failed, conflicts, newConflicts, resolved }
}

/* ------------------------------------------------------------------ reconcile */

/**
 * 对账一个插件。模式：
 * - auto（默认）：没有记录→按基线自动生成记录；有记录且版本变化→恢复；
 *   同版本→把用户的继续修改记录进去。
 * - recordOnly：即使版本变化也只记录、不恢复（备用/诊断）。
 * - restoreOnly：只做恢复，不自动记录。
 *
 * 本地/私有插件（link:/file:/workspace:/绝对路径，或 package.json private:true）
 * 没有 npm 官方基线：没有记录时不自动纳管，返回 action='unmanaged'（不报错）；
 * 已记录插件升级到没有缓存基线的版本时也返回 unmanaged，并提示重新 adopt。
 *
 * @param {{plugin: string, pluginDir: string, stateDir: string, profile?: string,
 *   baseDir?: string, mode?: string, spec?: string}} options
 * @returns {Promise<{plugin: string, version: string, action: string, changed: boolean,
 *   recorded: string[], restored: string[], failed: {path: string, reason: string}[],
 *   conflictsAdded: object[], conflicts: object[], warning?: string, error?: string}>}
 */
export async function reconcilePlugin({
  plugin,
  pluginDir,
  stateDir,
  profile = 'desktop',
  baseDir,
  mode = 'auto',
  spec,
}) {
  const result = {
    plugin,
    version: null,
    action: 'none',
    changed: false,
    recorded: [],
    restored: [],
    failed: [],
    conflictsAdded: [],
    conflicts: [],
    warning: undefined,
    error: undefined,
  }
  const version = await readPluginVersion(pluginDir)
  result.version = version
  if (!version) {
    result.error = '插件未安装或 package.json 缺少 version'
    result.action = 'error'
    return result
  }

  let record = await loadRecord(stateDir, plugin)
  if (record?.baseline?.source === 'unavailable') {
    // 之前已判定"没有该版本的官方基线"：不再重复联网/报错，等用户重新 adopt。
    result.action = 'unmanaged'
    result.warning = '该插件没有可用的官方基线（本地/私有插件），已跳过自动对账；如需继续跟踪，请运行 adopt --base-dir <官方原版目录>'
    return result
  }
  const beforeSignature = recordSignature(record)

  if (!record) {
    if (mode === 'restoreOnly') return result
    if (await looksLikeLocalPlugin(pluginDir, spec)) {
      // 本地/私有插件没有 registry 基线，自动纳管只会每次报错（旧行为）。
      result.action = 'unmanaged'
      result.warning = '本地/私有插件（link:/file:/private）没有 npm 官方基线，已跳过自动记录；如需纳管，请运行 adopt --base-dir <官方原版目录>'
      return result
    }
    const baseline = await ensureBaseline({ plugin, version, stateDir, baseDir })
    if (!baseline) {
      result.action = 'error'
      result.error = '无法获取该插件版本的官方基线（registry 不可用且没有 --base-dir）'
      return result
    }
    const current = await hashTree(pluginDir)
    const diff = diffTrees(baseline.files, current)
    if (diff.length === 0) {
      result.action = 'pristine'
      return result
    }
    const entries = await entriesFromDiff({ diff, baselineFiles: baseline.files, plugin, pluginDir, stateDir })
    record = {
      schema: SCHEMA_VERSION,
      plugin,
      profile,
      recordedVersion: version,
      recordedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      baseline: { version, source: baseline.source },
      files: entries.sort((a, b) => a.path.localeCompare(b.path)),
      conflicts: [],
    }
    await saveRecord(stateDir, plugin, record)
    await prunePatched(stateDir, plugin, record)
    result.action = 'recorded'
    result.changed = true
    result.recorded = record.files.map((file) => file.path)
    return result
  }

  if (record.recordedVersion !== version) {
    if (await looksLikeLocalPlugin(pluginDir, spec)) {
      // 本地/私有插件升级：没有新版本官方基线时不自动恢复/realign（也无法判断上游改了什么）。
      const cached = await cachedBaseline(stateDir, plugin, version)
      if (!cached) {
        record.recordedVersion = version
        record.baseline = { version, source: 'unavailable' }
        record.updatedAt = new Date().toISOString()
        await saveRecord(stateDir, plugin, record)
        result.action = 'unmanaged'
        result.warning = `本地/私有插件 ${plugin} 升级到 ${version}，但没有该版本的官方基线；已跳过自动恢复与对账。如需继续跟踪，请运行 adopt --base-dir <官方原版目录> 重新纳管。`
        return result
      }
    }
    // 插件被官方更新覆盖：恢复补丁并逐文件校验。
    // 先快照旧冲突：restoreRecord 会就地更新 record.conflicts。
    const previousConflicts = (record.conflicts ?? []).map((conflict) => ({ ...conflict }))
    const restore = await restoreRecord({ record, plugin, pluginDir, stateDir })
    const newConflicting = restore.conflicts.filter(
      (conflict) => !previousConflicts.some((old) => old.path === conflict.path && old.upstreamSha256 === conflict.upstreamSha256),
    )
    record = { ...record, conflicts: restore.conflicts }
    const baseline = await ensureBaseline({ plugin, version, stateDir, baseDir })
    if (mode === 'recordOnly') {
      record.recordedVersion = version
    } else {
      if (baseline) {
        record = await realignRecord({ record, plugin, pluginDir, stateDir, version, baseline })
      } else {
        record.recordedVersion = version
        result.warning = '已恢复，但无法获取新版本官方基线；冲突检测可能不准确'
      }
    }
    await saveRecord(stateDir, plugin, record)
    await prunePatched(stateDir, plugin, record)
    result.action = restore.restored.length > 0 || restore.failed.length > 0 || restore.conflicts.length > 0
      ? 'restored'
      : 'aligned'
    result.restored = restore.restored
    result.failed = restore.failed
    result.conflictsAdded = newConflicting
    result.conflicts = restore.conflicts
    result.changed = true
    return result
  }

  if (mode === 'restoreOnly') {
    result.action = 'none'
    return result
  }

  const baseline = await ensureBaseline({ plugin, version, stateDir, baseDir })
  if (!baseline) {
    result.action = 'error'
    result.error = '无法获取该插件版本的官方基线（registry 不可用且没有 --base-dir）'
    return result
  }
  record = await realignRecord({ record, plugin, pluginDir, stateDir, version, baseline })
  const nextSignature = recordSignature(record)
  if ((record.files ?? []).length === 0 && (record.conflicts ?? []).length === 0) {
    await deleteRecord(stateDir, plugin)
    result.action = 'cleaned'
    result.changed = beforeSignature !== 'none'
    return result
  }
  // 内容没变就不重写记录：周期对账（每 5 分钟）不再产生无意义的原子写。
  if (nextSignature !== beforeSignature) {
    await saveRecord(stateDir, plugin, record)
    await prunePatched(stateDir, plugin, record)
  }
  result.action = 'recorded'
  result.changed = nextSignature !== beforeSignature
  result.recorded = record.files.map((file) => file.path)
  result.conflicts = record.conflicts
  return result
}

/**
 * 显式把当前安装内容记录为补丁（用于首次纳管已经改过的插件）。
 * @returns {Promise<object>} 记录摘要
 */
export async function adoptPlugin({ plugin, pluginDir, stateDir, profile = 'desktop', baseDir }) {
  const version = await readPluginVersion(pluginDir)
  if (!version) throw new Error('插件未安装或缺少 version')
  const baseline = await ensureBaseline({ plugin, version, stateDir, baseDir })
  if (!baseline) throw new Error('无法获取官方基线（registry 不可用且没有 --base-dir）')
  const current = await hashTree(pluginDir)
  const diff = diffTrees(baseline.files, current)
  const existing = await loadRecord(stateDir, plugin)
  const existingConflicts = existing?.conflicts ?? []
  if (diff.length === 0) {
    await deleteRecord(stateDir, plugin)
    return { plugin, version, baselineSource: baseline.source, files: 0, message: '当前内容与官方一致，无需记录' }
  }
  const entries = await entriesFromDiff({ diff, baselineFiles: baseline.files, plugin, pluginDir, stateDir })
  const record = {
    schema: SCHEMA_VERSION,
    plugin,
    profile,
    recordedVersion: version,
    recordedAt: existing?.recordedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    baseline: { version, source: baseline.source },
    files: entries.sort((a, b) => a.path.localeCompare(b.path)),
    // 纳管时用户尚未面对的旧冲突保留下来。
    conflicts: existingConflicts.filter((conflict) => entries.some((entry) => entry.path === conflict.path)),
  }
  await saveRecord(stateDir, plugin, record)
  await prunePatched(stateDir, plugin, record)
  return {
    plugin,
    version,
    baselineSource: baseline.source,
    files: entries.length,
    added: entries.filter((entry) => entry.kind === 'added').map((entry) => entry.path),
    modified: entries.filter((entry) => entry.kind === 'modified').map((entry) => entry.path),
    deleted: entries.filter((entry) => entry.kind === 'deleted').map((entry) => entry.path),
  }
}

/** 解决冲突：接受上游文件（删除该路径的补丁条目）。 */
export async function acceptUpstream({ plugin, stateDir, paths }) {
  const record = await loadRecord(stateDir, plugin)
  if (!record) throw new Error(`没有 ${plugin} 的记录`)
  const wanted = paths === undefined || paths.length === 0 ? null : new Set(paths.map((item) => assertSafeRel(item)))
  const removed = []
  record.files = (record.files ?? []).filter((entry) => {
    if (wanted !== null && !wanted.has(entry.path)) return true
    if (!(record.conflicts ?? []).some((conflict) => conflict.path === entry.path)) return true
    removed.push(entry.path)
    return false
  })
  record.conflicts = (record.conflicts ?? []).filter((conflict) => !removed.includes(conflict.path))
  record.updatedAt = new Date().toISOString()
  if (record.files.length === 0 && record.conflicts.length === 0) {
    await deleteRecord(stateDir, plugin)
  } else {
    await saveRecord(stateDir, plugin, record)
    await prunePatched(stateDir, plugin, record)
  }
  return { plugin, accepted: removed }
}

/* -------------------------------------------------------------- profile scan */

/**
 * 读取某个 profile 里"已下载且已启用"的插件列表。
 * @param {{dshHome: string, profile: string, exclude?: Iterable<string>}} options
 */
export async function collectProfilePlugins({ dshHome, profile, exclude = [] }) {
  const profileDir = path.join(dshHome, 'profiles', profile)
  const pkg = await readJson(path.join(profileDir, 'package.json'))
  if (!pkg) throw new Error(`找不到 profile package.json: ${profileDir}`)
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  const dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  let patchText = ''
  try {
    patchText = await fs.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
  } catch {
    patchText = ''
  }
  const market = await readJson(path.join(profileDir, '.dsh-market', 'state.json'), {}) ?? {}
  const disabled = new Set(Array.isArray(market.disabled) ? market.disabled : [])
  const excluded = new Set(exclude)
  const plugins = []
  for (const [name, spec] of Object.entries(dependencies)) {
    if (excluded.has(name)) continue
    const enabled = bundles.includes(name) || patchText.includes(name)
    if (!enabled || disabled.has(name)) continue
    const dir = path.join(profileDir, 'node_modules', name)
    const version = await readPluginVersion(dir)
    if (!version) continue
    plugins.push({ name, spec: typeof spec === 'string' ? spec : '', dir, version })
  }
  return { profileDir, plugins }
}
