/**
 * dsh-patch-sync 宿主半集成测试（不碰真实 profile）。
 *
 * 在一个假的 DSH_HOME 里跑 lib/index.js 的 apply()：
 * - 启动后开始监听；
 * - 用户修改插件文件 → 约 3 秒后自动写入记录；
 * - 模拟官方更新覆盖（版本变化）→ 自动恢复补丁、保留冲突文件、写状态/报告；
 * - HTTP 路由 /status 与 /dismiss 可用。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { adoptPlugin, ensureBaseline, loadRecord } from '../lib/core.mjs'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check, timeoutMs = 15000, label = 'condition') {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await check()
    if (value) return value
    await delay(150)
  }
  throw new Error(`等待超时：${label}`)
}

async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'))
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content, 'utf8')
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function sha256File(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

/** 用一个假的 req/res 调用宿主路由。 */
function callRoute(handler, method, url) {
  return new Promise((resolve) => {
    const state = { status: 0, body: '' }
    const res = {
      writeHead(status) {
        state.status = status
      },
      end(chunk) {
        state.body += chunk ? String(chunk) : ''
        resolve({ status: state.status, body: state.body ? JSON.parse(state.body) : null })
      },
    }
    handler({ url, method, headers: {}, on() {} }, res)
  })
}

test('宿主半：监听自动记录 + 更新后恢复/冲突/校验 + HTTP 状态路由', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-sync-host-test-'))
  const home = path.join(root, 'home')
  const profileDir = path.join(home, 'profiles', 'desktop')
  const pluginDir = path.join(profileDir, 'node_modules', 'fixture-plugin')
  const localPluginDir = path.join(profileDir, 'node_modules', 'local-fixture')
  const stateDir = path.join(root, 'state')
  const baseV1 = path.join(root, 'official-v1')
  const baseV2 = path.join(root, 'official-v2')

  await writeTree(baseV1, {
    'package.json': JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }, null, 2),
    'lib/a.js': 'export const a = "A1"\n',
    'lib/b.js': 'export const b = "B1"\n',
    'lib/c.js': 'export const c = "C1"\n',
  })
  await writeTree(pluginDir, {
    'package.json': JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }, null, 2),
    'lib/a.js': 'export const a = "A1-patched"\n',
    'lib/b.js': 'export const b = "B1-patched"\n',
    'lib/c.js': 'export const c = "C1"\n',
  })
  // 本地 link 插件（private、没有 registry 基线）：不应自动纳管、更不应报错。
  await writeTree(localPluginDir, {
    'package.json': JSON.stringify({ name: 'local-fixture', version: '0.1.0', private: true }, null, 2),
    'lib/x.js': 'local v1\n',
  })
  await writeTree(profileDir, {
    'package.json': JSON.stringify({
      name: 'fake-profile',
      private: true,
      dependencies: { 'fixture-plugin': '1.0.0', 'local-fixture': 'link:C:/Users/me/.dsh/plugins/local-fixture' },
      dsh: { profile: { bundles: ['fixture-plugin', 'local-fixture'] } },
    }, null, 2),
    'cordis.patch.yml': '# fake profile\n',
  })

  await adoptPlugin({ plugin: 'fixture-plugin', pluginDir, stateDir, profile: 'desktop', baseDir: baseV1 })
  await writeTree(baseV2, {
    'package.json': JSON.stringify({ name: 'fixture-plugin', version: '2.0.0' }, null, 2),
    'lib/a.js': 'export const a = "A1"\n',
    'lib/b.js': 'export const b = "B2"\n',
    'lib/c.js': 'export const c = "C1"\n',
  })
  await ensureBaseline({ plugin: 'fixture-plugin', version: '2.0.0', stateDir, baseDir: baseV2 })

  process.env.DSH_HOME = home
  process.env.DSH_PATCH_SYNC_PROFILE = 'desktop'
  process.env.DSH_PATCH_SYNC_STATE_DIR = stateDir
  process.env.DSH_PATCH_SYNC_STARTUP_DELAY_MS = '150'
  delete process.env.DSH_PATCH_SYNC_DISABLE

  const module = await import(`../lib/index.js?host-test=${Date.now()}`)
  let routeHandler
  let disposeHandler
  let firstRouteDisposed = false
  const ctx = {
    webServer: {
      register(spec) {
        routeHandler = spec.handler
        return () => {
          firstRouteDisposed = true
        }
      },
    },
    on(event, handler) {
      if (event === 'dispose') disposeHandler = handler
    },
  }

  // 测试挂死保护：超时强制退出并给出明确信号。
  const watchdog = setTimeout(() => {
    console.error('WATCHDOG: host test hung')
    process.exit(3)
  }, 90_000)

  const statusFile = path.join(stateDir, 'state', 'status.json')
  const recordFile = path.join(stateDir, 'records', 'fixture-plugin', 'record.json')

  try {
    console.log('[test] apply host half')
    module.apply(ctx)

    // 模拟 DSH 插件热重载：同一进程里再次 apply 一个新实例。
    const module2 = await import(`../lib/index.js?host-test-reload=${Date.now()}`)
    let routeHandler2
    let disposeHandler2
    const ctx2 = {
      webServer: {
        register(spec) {
          routeHandler2 = spec.handler
          return () => {}
        },
      },
      on(event, handler) {
        if (event === 'dispose') disposeHandler2 = handler
      },
    }
    module2.apply(ctx2)
    assert.equal(firstRouteDisposed, true, '热重载时应先注销旧实例的 HTTP 路由')
    assert.equal(typeof routeHandler2, 'function', '新实例应成功注册 HTTP 路由')
    routeHandler = routeHandler2
    disposeHandler = () => {
      disposeHandler2?.()
      disposeHandler?.()
    }
    console.log('[test] hot reload takeover ok')

    await waitFor(async () => {
      const status = await readJson(statusFile)
      return status && status.phase === 'idle' && status.records === 1 && status.tracked.includes('fixture-plugin')
    }, 20000, '宿主启动并对账')
    console.log('[test] host bootstrapped')

    const statusResponse = await callRoute(routeHandler, 'GET', '/dsh-patch-sync/status')
    assert.equal(statusResponse.status, 200)
    assert.equal(statusResponse.body.records, 1)
    assert.ok(statusResponse.body.tracked.includes('fixture-plugin'))
    assert.ok(statusResponse.body.tracked.includes('local-fixture'), '本地 link 插件也应被跟踪')

    console.log('[test] modify lib/a.js and wait for auto record')
    await fs.writeFile(path.join(pluginDir, 'lib', 'a.js'), 'export const a = "A1-patched-v2"\n', 'utf8')
    await waitFor(async () => {
      const record = await readJson(recordFile)
      const entry = record?.files?.find((file) => file.path === 'lib/a.js')
      if (!entry) return false
      const current = await sha256File(path.join(pluginDir, 'lib', 'a.js'))
      return entry.patchedSha256 === current
    }, 20000, '自动记录用户的修改')
    const recorded = await loadRecord(stateDir, 'fixture-plugin')
    assert.equal(recorded.recordedVersion, '1.0.0')
    console.log('[test] auto record ok')

    console.log('[test] modify local (link:) fixture and expect silent skip')
    const logFile = path.join(stateDir, 'logs', 'patch-sync.log')
    await fs.writeFile(path.join(localPluginDir, 'lib', 'x.js'), 'local v2\n', 'utf8')
    await waitFor(async () => {
      try {
        return (await fs.readFile(logFile, 'utf8')).includes('跳过自动对账 local-fixture')
      } catch {
        return false
      }
    }, 20000, '本地插件跳过自动对账')
    const statusAfterLocal = await readJson(statusFile)
    assert.notEqual(statusAfterLocal?.phase, 'error', '本地插件不应把宿主状态置为 error')
    assert.ok(!(statusAfterLocal?.lastEvent?.plugin === 'local-fixture'), '本地插件不应产生失败事件')
    assert.equal(await loadRecord(stateDir, 'local-fixture'), null, '本地插件不应被自动建记录')
    console.log('[test] local plugin silent skip ok')

    console.log('[test] simulate official update to 2.0.0')
    await fs.rm(pluginDir, { recursive: true, force: true })
    await fs.cp(baseV2, pluginDir, { recursive: true })

    try {
      await waitFor(async () => {
        const status = await readJson(statusFile)
        return status?.lastEvent?.kind === 'conflict' && status.pendingRestart === true
      }, 25000, '更新后自动恢复并报告冲突')
    } catch (error) {
      console.error('[debug] status =', JSON.stringify(await readJson(statusFile), null, 2))
      console.error('[debug] record =', JSON.stringify(await readJson(recordFile), null, 2))
      try {
        const logText = await fs.readFile(path.join(stateDir, 'logs', 'patch-sync.log'), 'utf8')
        console.error('[debug] log =', logText.slice(-3000))
      } catch (logError) {
        console.error('[debug] no log:', logError.message)
      }
      try {
        console.error('[debug] plugin dir:', (await fs.readdir(pluginDir)).join(','))
        console.error('[debug] a.js =', await fs.readFile(path.join(pluginDir, 'lib', 'a.js'), 'utf8'))
        console.error('[debug] b.js =', await fs.readFile(path.join(pluginDir, 'lib', 'b.js'), 'utf8'))
        console.error('[debug] package =', await fs.readFile(path.join(pluginDir, 'package.json'), 'utf8'))
      } catch (dirError) {
        console.error('[debug] plugin dir unreadable:', dirError.message)
      }
      throw error
    }
    console.log('[test] restore + conflict detected')

    const status = await readJson(statusFile)
    assert.equal(status.lastEvent.plugin, 'fixture-plugin')
    assert.ok(status.lastEvent.restored >= 1, '应恢复 a.js')
    assert.equal(status.lastEvent.conflictsAdded[0].path, 'lib/b.js')
    assert.equal(status.conflicts.length, 1)

    assert.equal(await fs.readFile(path.join(pluginDir, 'lib', 'a.js'), 'utf8'), 'export const a = "A1-patched-v2"\n')
    assert.equal(await fs.readFile(path.join(pluginDir, 'lib', 'b.js'), 'utf8'), 'export const b = "B2"\n')
    const after = await loadRecord(stateDir, 'fixture-plugin')
    assert.equal(after.recordedVersion, '2.0.0')
    assert.equal(after.conflicts[0].path, 'lib/b.js')
    const restoredEntry = after.files.find((file) => file.path === 'lib/a.js')
    assert.equal(await sha256File(path.join(pluginDir, 'lib', 'a.js')), restoredEntry.patchedSha256)
    console.log('[test] restored files + conflicts verified')

    const report = await fs.readFile(path.join(stateDir, 'reports', 'latest.md'), 'utf8')
    assert.ok(report.includes('## 冲突（已保留上游文件）'))
    assert.ok(report.includes('lib/b.js'))

    const dismiss = await callRoute(routeHandler, 'POST', '/dsh-patch-sync/dismiss')
    assert.equal(dismiss.status, 200)
    assert.equal(dismiss.body.dismissedEventId, dismiss.body.eventId)
    console.log('[test] routes + report ok')
  } finally {
    clearTimeout(watchdog)
    try {
      disposeHandler?.()
    } catch {
      /* ignore */
    }
    await delay(300)
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
  }
})
