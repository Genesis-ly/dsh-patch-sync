#!/usr/bin/env node
/**
 * dsh-patch-sync CLI —— 在不启动 DSH 的情况下查看/管理补丁记录。
 *
 * 用法：
 *   node lib/cli.mjs status                          # 查看宿主同步状态（状态文件）
 *   node lib/cli.mjs list                            # 列出所有插件补丁记录
 *   node lib/cli.mjs adopt <plugin> [--base-dir <dir>]  # 把当前修改纳管（首次设置用）
 *   node lib/cli.mjs scan [--plugin <name>] [--all]  # 手动对账（记录/恢复）
 *   node lib/cli.mjs restore --plugin <name>         # 只执行恢复（用于诊断）
 *   node lib/cli.mjs resolve <plugin> --accept-upstream [path...]  # 冲突时接受上游文件
 *   node lib/cli.mjs report                          # 打印最近一次同步报告
 *
 * 通用选项：--dsh-home <dir> --profile <name> --state-dir <dir>
 * @module dsh-patch-sync/cli
 */

import { readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  acceptUpstream,
  adoptPlugin,
  collectProfilePlugins,
  listRecords,
  reconcilePlugin,
  readJson,
  readPluginVersion,
} from './core.mjs'

function parseArguments(argv) {
  const flags = {}
  const positionals = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        index++
      } else {
        flags[key] = true
      }
    } else {
      positionals.push(token)
    }
  }
  return { flags, positionals }
}

const { flags, positionals } = parseArguments(process.argv.slice(2))
const command = positionals.shift() ?? 'help'
const dshHome = String(flags['dsh-home'] ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
const profile = String(flags.profile ?? process.env.DSH_PATCH_SYNC_PROFILE ?? process.env.DSH_PROFILE ?? 'desktop')
const stateDir = String(flags['state-dir'] ?? process.env.DSH_PATCH_SYNC_STATE_DIR ?? path.join(dshHome, 'patch-sync'))
const profileDir = path.join(dshHome, 'profiles', profile)

function pluginDirOf(pluginName) {
  return path.join(profileDir, 'node_modules', pluginName)
}

function print(value) {
  if (typeof value === 'string') {
    process.stdout.write(`${value}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function shortFiles(files) {
  const list = Array.isArray(files) ? files : []
  const shown = list.slice(0, 8)
  return `${shown.join('、')}${list.length > shown.length ? ` 等 ${list.length} 个` : ''}`
}

async function commandList() {
  const records = await listRecords(stateDir)
  if (records.length === 0) {
    print('（还没有任何补丁记录）')
    return 0
  }
  for (const record of records) {
    const files = record.files ?? []
    const conflicts = record.conflicts ?? []
    print(`- ${record.plugin}@${record.recordedVersion}：${files.length} 个补丁文件${conflicts.length > 0 ? `，${conflicts.length} 个冲突` : ''}`)
    print(`    ${shortFiles(files.map((file) => `${file.path}(${file.kind})`))}`)
    if (conflicts.length > 0) print(`    冲突：${shortFiles(conflicts.map((conflict) => conflict.path))}`)
  }
  return 0
}

async function commandAdopt() {
  const pluginName = positionals[0] ?? flags.plugin
  if (typeof pluginName !== 'string' || pluginName === '') {
    print('用法：node lib/cli.mjs adopt <plugin> [--base-dir <官方原版目录>]')
    return 2
  }
  const pluginDir = pluginDirOf(pluginName)
  const version = await readPluginVersion(pluginDir)
  if (!version) {
    print(`插件未安装：${pluginDir}`)
    return 1
  }
  const summary = await adoptPlugin({
    plugin: pluginName,
    pluginDir,
    stateDir,
    profile,
    baseDir: typeof flags['base-dir'] === 'string' ? flags['base-dir'] : undefined,
  })
  print(summary)
  return 0
}

/** profile 里各插件的依赖声明（版本号 / link: / file: …），用于识别本地插件。 */
async function pluginSpecMap() {
  try {
    const collected = await collectProfilePlugins({ dshHome, profile, exclude: [] })
    return new Map(collected.plugins.map((plugin) => [plugin.name, plugin.spec]))
  } catch {
    return new Map()
  }
}

async function commandScan() {
  const onlyPlugin = typeof flags.plugin === 'string' ? flags.plugin : undefined
  const specs = await pluginSpecMap()
  if (onlyPlugin !== undefined) {
    const pluginDir = pluginDirOf(onlyPlugin)
    if (!(await readPluginVersion(pluginDir))) {
      print(`插件未安装：${pluginDir}`)
      return 1
    }
    const result = await reconcilePlugin({ plugin: onlyPlugin, pluginDir, stateDir, profile, spec: specs.get(onlyPlugin) })
    print(result)
    return result.action === 'error' ? 1 : 0
  }
  const records = await listRecords(stateDir)
  const names = new Set(records.map((record) => record.plugin))
  if (flags.all) {
    for (const pluginName of specs.keys()) names.add(pluginName)
  }
  if (names.size === 0) {
    print('（没有可扫描的插件：用 --all 扫描所有已启用插件，或用 adopt 纳管）')
    return 0
  }
  let failed = 0
  for (const pluginName of [...names].sort()) {
    const pluginDir = pluginDirOf(pluginName)
    if (!(await readPluginVersion(pluginDir))) {
      print(`- ${pluginName}：未安装，跳过`)
      continue
    }
    const result = await reconcilePlugin({ plugin: pluginName, pluginDir, stateDir, profile, spec: specs.get(pluginName) })
    print(`- ${pluginName}：${result.action}${result.changed ? '（有变化）' : ''}${result.error ? ` 错误：${result.error}` : ''}`)
    if (result.warning) print(`    提示：${result.warning}`)
    if (result.restored?.length) print(`    恢复 ${shortFiles(result.restored)}`)
    if (result.recorded?.length) print(`    记录 ${shortFiles(result.recorded)}`)
    if (result.failed?.length) print(`    失败 ${shortFiles(result.failed.map((item) => item.path))}`)
    if (result.conflictsAdded?.length) print(`    冲突（保留上游） ${shortFiles(result.conflictsAdded.map((item) => item.path))}`)
    if (result.action === 'error') failed++
  }
  return failed > 0 ? 1 : 0
}

async function commandRestore() {
  const pluginName = typeof flags.plugin === 'string' ? flags.plugin : positionals[0]
  if (typeof pluginName !== 'string' || pluginName === '') {
    print('用法：node lib/cli.mjs restore --plugin <name>')
    return 2
  }
  const pluginDir = pluginDirOf(pluginName)
  const result = await reconcilePlugin({ plugin: pluginName, pluginDir, stateDir, profile, mode: 'restoreOnly' })
  print(result)
  return result.failed?.length > 0 ? 1 : 0
}

async function commandResolve() {
  const pluginName = typeof flags.plugin === 'string' ? flags.plugin : positionals.shift()
  if (typeof pluginName !== 'string' || pluginName === '') {
    print('用法：node lib/cli.mjs resolve <plugin> --accept-upstream [path...]')
    return 2
  }
  if (flags['accept-upstream']) {
    const result = await acceptUpstream({ plugin: pluginName, stateDir, paths: positionals })
    print(result)
    return 0
  }
  const parsed = await readJson(path.join(stateDir, 'records', encodeURIComponent(pluginName), 'record.json'))
  print(parsed?.conflicts ?? [])
  return 0
}

async function commandStatus() {
  const status = await readJson(path.join(stateDir, 'state', 'status.json'))
  const records = await listRecords(stateDir)
  print({
    stateDir,
    profileDir,
    status,
    records: records.map((record) => ({
      plugin: record.plugin,
      version: record.recordedVersion,
      files: (record.files ?? []).length,
      conflicts: (record.conflicts ?? []).length,
    })),
  })
  return 0
}

async function commandReport() {
  try {
    print(await fs.readFile(path.join(stateDir, 'reports', 'latest.md'), 'utf8'))
    return 0
  } catch {
    print('（还没有报告）')
    return 0
  }
}

function commandHelp() {
  print(`dsh-patch-sync CLI

用法：
  node lib/cli.mjs status
  node lib/cli.mjs list
  node lib/cli.mjs adopt <plugin> [--base-dir <官方原版目录>]
  node lib/cli.mjs scan [--plugin <name>] [--all]
  node lib/cli.mjs restore --plugin <name>
  node lib/cli.mjs resolve <plugin> --accept-upstream [path...]
  node lib/cli.mjs report

通用选项：--dsh-home <dir> --profile <name> --state-dir <dir>
状态目录（默认）：${stateDir}
profile 目录：${profileDir}`)
  return 0
}

const handlers = {
  status: commandStatus,
  list: commandList,
  adopt: commandAdopt,
  scan: commandScan,
  restore: commandRestore,
  resolve: commandResolve,
  report: commandReport,
  help: commandHelp,
}

const handler = handlers[command]
if (handler === undefined) {
  print(`未知命令：${command}`)
  commandHelp()
  process.exitCode = 2
} else {
  try {
    process.exitCode = await handler()
  } catch (error) {
    print(`失败：${String(error?.message ?? error)}`)
    process.exitCode = 1
  }
}
