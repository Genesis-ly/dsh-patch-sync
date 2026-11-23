/**
 * dsh-patch-sync 核心逻辑测试（node --test）。
 * 用本地 fixture 目录模拟插件，验证：纳管记录、同版本继续修改、官方更新后的
 * 自动恢复/冲突保留/哈希校验、排除规则、接受上游冲突。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  adoptPlugin,
  acceptUpstream,
  cleanupStaleTemps,
  ensureBaseline,
  hashTree,
  isTempFileName,
  listRecords,
  loadRecord,
  reconcilePlugin,
  tempPathFor,
  writeFileAtomic,
  writeJsonAtomic,
} from '../lib/core.mjs'

/** 建一个临时目录。 */
async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'patch-sync-test-'))
}

/** 按 relPath -> content 写目录树。 */
async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'))
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content, 'utf8')
  }
}

/** 把 src 目录复制为 dst（用于"安装"）。 */
async function copyTree(src, dst) {
  await fs.cp(src, dst, { recursive: true })
}

/** 读取路径内容。 */
async function readText(root, rel) {
  return fs.readFile(path.join(root, ...rel.split('/')), 'utf8')
}

/** 建一个 v1 官方包目录。 */
async function makeOfficialV1(root) {
  await writeTree(root, {
    'package.json': JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }, null, 2),
    'lib/a.js': 'export const a = "A1"\n',
    'lib/b.js': 'export const b = "B1"\n',
    'lib/c.js': 'export const c = "C1"\n',
  })
}

test('纳管：记录修改/新增/删除文件，并保存补丁本体', async () => {
  const root = await tempRoot()
  const base = path.join(root, 'base')
  const pluginDir = path.join(root, 'node_modules', 'fixture-plugin')
  const stateDir = path.join(root, 'state')
  await makeOfficialV1(base)
  await copyTree(base, pluginDir)
  await fs.writeFile(path.join(pluginDir, 'lib/a.js'), 'export const a = "A1-patched"\n')
  await fs.writeFile(path.join(pluginDir, 'lib/new.js'), 'export const added = true\n')
  await fs.rm(path.join(pluginDir, 'lib/c.js'))

  const summary = await adoptPlugin({ plugin: 'fixture-plugin', pluginDir, stateDir, profile: 'test', baseDir: base })
  assert.equal(summary.files, 3)
  const record = await loadRecord(stateDir, 'fixture-plugin')
  const byPath = new Map(record.files.map((file) => [file.path, file]))
  assert.equal(byPath.get('lib/a.js').kind, 'modified')
  assert.equal(byPath.get('lib/new.js').kind, 'added')
  assert.equal(byPath.get('lib/c.js').kind, 'deleted')
  assert.ok(!byPath.has('lib/b.js'))
  assert.equal(record.files.find((file) => file.path === 'lib/a.js').baseSha256.length, 64)
  assert.equal(record.files.find((file) => file.path === 'lib/a.js').patchedSha256.length, 64)
  const patchBody = await readText(path.join(stateDir, 'records', encodeURIComponent('fixture-plugin'), 'patched'), 'lib/a.js')
  assert.equal(patchBody, 'export const a = "A1-patched"\n')
})

test('同版本继续修改：自动更新记录；改回官方后清除记录', async () => {
  const root = await tempRoot()
  const base = path.join(root, 'base')
  const pluginDir = path.join(root, 'node_modules', 'fixture-plugin')
  const stateDir = path.join(root, 'state')
  await makeOfficialV1(base)
  await copyTree(base, pluginDir)
  await fs.writeFile(path.join(pluginDir, 'lib/a.js'), 'export const a = "A1-patched"\n')
  await adoptPlugin({ plugin: 'fixture-plugin', pluginDir, stateDir, profile: 'test', baseDir: base })

  await fs.writeFile(path.join(pluginDir, 'lib/b.js'), 'export const b = "B1-patched"\n')
  const recorded = await reconcilePlugin({ plugin: 'fixture-plugin', pluginDir, stateDir, profile: 'test', baseDir: base })
  assert.equal(recorded.action, 'recorded')
  assert.equal(recorded.changed, true)
  let record = await loadRecord(stateDir, 'fixture-plugin')
  assert.ok(record.files.some((file) => file.path === 'lib/b.js'))

  await fs.writeFile(path.join(pluginDir, 'lib/a.js'), 'export const a = "A1"\n')
  await fs.writeFile(path.join(pluginDir, 'lib/b.js'), 'export const b = "B1"\n')
  const cleaned = await reconcilePlugin({ plugin: 'fixture-plugin', pluginDir, stateDir, profile: 'test', baseDir: base })
  assert.equal(cleaned.action, 'cleaned')
  record = await loadRecord(stateDir, 'fixture-plugin')
  assert.equal(record, null)
})

test('官方更新后：自动恢复补丁、冲突文件保留上游、逐文件校验', async () => {
  const root = await tempRoot()
  const baseV1 = path.join(root, 'base-v1')
  const baseV2 = path.join(root, 'base-v2')
  const pluginDir = path.join(root, 'node_modules', 'fixture-plugin')
  const stateDir = path.join(root, 'state')
  await makeOfficialV1(baseV1)
  await copyTree(baseV1, pluginDir)
  await fs.writeFile(path.join(pluginDir, 'lib/a.js'), 'export const a = "A1-patched"\n')
  await fs.writeFile(path.join(pluginDir, 'lib/b.js'), 'export const b = "B1-patched"\n')
  await fs.writeFile(path.join(pluginDir, 'lib/new.js'), 'export const added = true\n')
  await adoptPlugin({ plugin: 'fixture-plugin', pluginDir, stateDir, profile: 'test', baseDir: baseV1 })

  // 官方 v2：a 未变、b 改了、c 改了、新增文件消失（被重装覆盖）。
  await writeTree(baseV2, {
    'package.json': JSON.stringify({ name: 'fixture-plugin', version: '2.0.0' }, null, 2),
    'lib/a.js': 'export const a = "A1"\n',
    'lib/b.js': 'export const b = "B2"\n',
    'lib/c.js': 'export const c = "C2"\n',
  })
  await fs.rm(pluginDir, { recursive: true, force: true })
  await copyTree(baseV2, pluginDir)
  // 预置 v2 官方基线缓存（测试里不联网）。
  await ensureBaseline({ plugin: 'fixture-plugin', version: '2.0.0', stateDir, baseDir: baseV2 })

  const result = await reconcilePlugin({ plugin: 'fixture-plugin', pluginDir, stateDir, profile: 'test', baseDir: baseV2 })
  assert.equal(result.action, 'restored')
  assert.deepEqual(result.failed, [])
  assert.ok(result.restored.includes('lib/a.js'), 'a 应恢复')
  assert.ok(result.restored.includes('lib/new.js'), '新增文件应恢复')
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].path, 'lib/b.js')

  // 文件内容断言：恢复的写回补丁，冲突的保留上游。
  assert.equal(await readText(pluginDir, 'lib/a.js'), 'export const a = "A1-patched"\n')
  assert.equal(await readText(pluginDir, 'lib/new.js'), 'export const added = true\n')
  assert.equal(await readText(pluginDir, 'lib/b.js'), 'export const b = "B2"\n')

  const record = await loadRecord(stateDir, 'fixture-plugin')
  assert.equal(record.recordedVersion, '2.0.0')
  assert.equal(record.conflicts[0].path, 'lib/b.js')
  assert.equal(record.conflicts[0].upstreamSha256.length, 64)
  assert.equal(record.files.find((file) => file.path === 'lib/b.js').conflict, true)

  // 记录里的补丁哈希与实际恢复出的文件一致（恢复校验的一部分）。
  const patchedSha = record.files.find((file) => file.path === 'lib/a.js').patchedSha256
  const restoredTree = await hashTree(pluginDir)
  assert.equal(restoredTree.get('lib/a.js'), patchedSha)

  // 接受上游：b 的补丁条目/冲突被移除，a 与新增文件保留。
  const accepted = await acceptUpstream({ plugin: 'fixture-plugin', stateDir, paths: ['lib/b.js'] })
  assert.deepEqual(accepted.accepted, ['lib/b.js'])
  const after = await loadRecord(stateDir, 'fixture-plugin')
  assert.equal(after.conflicts.length, 0)
  assert.ok(!after.files.some((file) => file.path === 'lib/b.js'))
  assert.ok(after.files.some((file) => file.path === 'lib/a.js'))
})

test('排除规则：state/logs/node_modules 等运行时不进记录', async () => {
  const root = await tempRoot()
  const base = path.join(root, 'base')
  const pluginDir = path.join(root, 'node_modules', 'fixture-plugin')
  const stateDir = path.join(root, 'state')
  await makeOfficialV1(base)
  await copyTree(base, pluginDir)
  await writeTree(pluginDir, {
    'state/runtime.json': '{"x":1}',
    'logs/plugin.log': 'log line',
    'lib/session.lock': 'lock',
  })
  await fs.writeFile(path.join(pluginDir, 'lib/a.js'), 'export const a = "A1-patched"\n')
  await adoptPlugin({ plugin: 'fixture-plugin', pluginDir, stateDir, profile: 'test', baseDir: base })
  const record = await loadRecord(stateDir, 'fixture-plugin')
  assert.deepEqual(record.files.map((file) => file.path), ['lib/a.js'])
})

/* ------------------------------------------------ 原子写（Windows EPERM 回归） */

test('原子写：同毫秒临时文件名唯一，并发写同一文件不残留临时文件', async () => {
  const root = await tempRoot()
  const file = path.join(root, 'state', 'status.json')
  const names = new Set()
  for (let i = 0; i < 200; i += 1) names.add(tempPathFor(file))
  assert.equal(names.size, 200, '同一毫秒内生成的临时文件名不应重复')

  await Promise.all(Array.from({ length: 25 }, (_, i) => writeJsonAtomic(file, { i })))
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.ok(Number.isInteger(parsed.i), '并发写后文件应是完整 JSON')
  const leftovers = (await fs.readdir(path.dirname(file))).filter((name) => isTempFileName(name))
  assert.deepEqual(leftovers, [], '写入成功后不应残留临时文件')
})

test('原子写：目标短暂被占用时会重试成功（Windows EPERM 回归）', async () => {
  const root = await tempRoot()
  const target = path.join(root, 'data', 'record.json')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, '{"old":true}')
  // 同进程持有读句柄：Windows 上 rename 目标会 EPERM，直到句柄关闭。
  const handle = await fs.open(target, 'r')
  const release = new Promise((resolve) => setTimeout(resolve, 200)).then(() => handle.close())
  try {
    if (process.platform === 'win32') {
      await writeFileAtomic(target, '{"new":true}')
      assert.equal(await fs.readFile(target, 'utf8'), '{"new":true}')
    }
  } finally {
    await release
  }
})

test('原子写：目标被占用时失败会清理临时文件并给出可读错误', async () => {
  const root = await tempRoot()
  const target = path.join(root, 'data', 'locked.json')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, '{"old":true}')
  const handle = await fs.open(target, 'r') // Windows 上存在读句柄时 rename 目标会 EPERM
  try {
    if (process.platform === 'win32') {
      await assert.rejects(() => writeFileAtomic(target, '{"new":true}', { attempts: 1 }), /原子写失败/)
    }
  } finally {
    await handle.close()
  }
  const leftovers = (await fs.readdir(path.dirname(target))).filter((name) => isTempFileName(name))
  assert.deepEqual(leftovers, [], '失败后也不应残留临时文件')
})

test('清理残留：只删除过期的原子写临时文件', async () => {
  const root = await tempRoot()
  const oldPlain = path.join(root, 'records', 'p', 'record.json.tmp-123-1700000000000')
  const oldSeq = path.join(root, 'records', 'p', 'status.json.tmp-123-1700000000000-7')
  const fresh = path.join(root, 'records', 'p', `record.json.tmp-456-${Date.now()}-1`)
  const normal = path.join(root, 'records', 'p', 'record.json')
  const nested = path.join(root, 'state', 'old.json.tmp-1-2')
  for (const file of [oldPlain, oldSeq, fresh, normal, nested]) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'x')
  }
  const oldTime = new Date(Date.now() - 60 * 60 * 1000)
  for (const file of [oldPlain, oldSeq, nested]) await fs.utimes(file, oldTime, oldTime)

  const removed = await cleanupStaleTemps(root, { maxAgeMs: 10 * 60 * 1000 })
  assert.deepEqual(
    removed.map((item) => path.basename(item)).sort(),
    ['old.json.tmp-1-2', 'record.json.tmp-123-1700000000000', 'status.json.tmp-123-1700000000000-7'].sort(),
  )
  const exists = async (file) => {
    try {
      await fs.access(file)
      return true
    } catch {
      return false
    }
  }
  assert.equal(await exists(fresh), true, '新临时文件不应被删除')
  assert.equal(await exists(normal), true, '正常文件不应被删除')
})

test('重复对账：内容未变时不重写记录与补丁文件', async () => {
  const root = await tempRoot()
  const base = path.join(root, 'base')
  const pluginDir = path.join(root, 'node_modules', 'fixture-plugin')
  const stateDir = path.join(root, 'state')
  await makeOfficialV1(base)
  await copyTree(base, pluginDir)
  await fs.writeFile(path.join(pluginDir, 'lib/a.js'), 'export const a = "A1-patched"\n')
  await adoptPlugin({ plugin: 'fixture-plugin', pluginDir, stateDir, profile: 'test', baseDir: base })

  const recordFile = path.join(stateDir, 'records', 'fixture-plugin', 'record.json')
  const patchedFile = path.join(stateDir, 'records', 'fixture-plugin', 'patched', 'lib', 'a.js')
  const before = { record: (await fs.stat(recordFile)).mtimeMs, patched: (await fs.stat(patchedFile)).mtimeMs }
  await new Promise((resolve) => setTimeout(resolve, 30))

  const again = await reconcilePlugin({ plugin: 'fixture-plugin', pluginDir, stateDir, profile: 'test', baseDir: base })
  assert.equal(again.action, 'recorded')
  assert.equal(again.changed, false)
  assert.equal((await fs.stat(recordFile)).mtimeMs, before.record, '记录内容未变时不应重写 record.json')
  assert.equal((await fs.stat(patchedFile)).mtimeMs, before.patched, '补丁内容未变时不应重写补丁文件')
})

test('记录读取：单条损坏的记录被跳过并通过 onError 上报', async () => {
  const root = await tempRoot()
  const stateDir = path.join(root, 'state')
  for (const [key, body] of [
    ['ok-plugin', JSON.stringify({ schema: 1, plugin: 'ok-plugin', files: [] })],
    ['bad-plugin', '{not json'],
  ]) {
    const dir = path.join(stateDir, 'records', key)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'record.json'), body)
  }
  const errors = []
  const records = await listRecords(stateDir, { onError: (plugin, error) => errors.push([plugin, error.message]) })
  assert.deepEqual(records.map((record) => record.plugin), ['ok-plugin'])
  assert.equal(errors.length, 1)
  assert.equal(errors[0][0], 'bad-plugin')
  assert.match(errors[0][1], /损坏/)
})

/* ---------------------------------------------- 本地/私有插件（没有 registry 基线） */

test('本地 link 插件没有官方基线：跳过自动记录，不报错也不建记录', async () => {
  const root = await tempRoot()
  const pluginDir = path.join(root, 'node_modules', 'local-fixture')
  const stateDir = path.join(root, 'state')
  await writeTree(pluginDir, {
    'package.json': JSON.stringify({ name: 'local-fixture', version: '0.1.0' }),
    'lib/a.js': 'local patch\n',
  })
  const result = await reconcilePlugin({
    plugin: 'local-fixture',
    pluginDir,
    stateDir,
    profile: 'test',
    spec: 'link:C:/Users/me/.dsh/plugins/local-fixture',
  })
  assert.equal(result.action, 'unmanaged')
  assert.equal(result.error, undefined)
  assert.match(result.warning, /adopt --base-dir/)
  assert.equal(await loadRecord(stateDir, 'local-fixture'), null)
})

test('私有插件（package.json private）未传 spec 时也跳过自动记录', async () => {
  const root = await tempRoot()
  const pluginDir = path.join(root, 'node_modules', 'private-fixture')
  const stateDir = path.join(root, 'state')
  await writeTree(pluginDir, {
    'package.json': JSON.stringify({ name: 'private-fixture', version: '0.1.0', private: true }),
    'lib/a.js': 'private patch\n',
  })
  const result = await reconcilePlugin({ plugin: 'private-fixture', pluginDir, stateDir, profile: 'test' })
  assert.equal(result.action, 'unmanaged')
  assert.equal(result.error, undefined)
  assert.equal(await loadRecord(stateDir, 'private-fixture'), null)
})

test('已纳管本地插件升级且无新基线：标记跳过而不是反复报错', async () => {
  const root = await tempRoot()
  const base = path.join(root, 'base')
  const pluginDir = path.join(root, 'node_modules', 'local-fixture')
  const stateDir = path.join(root, 'state')
  await writeTree(base, {
    'package.json': JSON.stringify({ name: 'local-fixture', version: '1.0.0' }),
    'lib/a.js': 'A1\n',
  })
  await copyTree(base, pluginDir)
  await fs.writeFile(path.join(pluginDir, 'lib/a.js'), 'A1-patched\n')
  await adoptPlugin({ plugin: 'local-fixture', pluginDir, stateDir, profile: 'test', baseDir: base })

  // 版本升级，但本地插件没有该版本的官方基线。
  await fs.writeFile(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'local-fixture', version: '2.0.0' }))
  const spec = 'link:C:/Users/me/.dsh/plugins/local-fixture'
  const upgraded = await reconcilePlugin({ plugin: 'local-fixture', pluginDir, stateDir, profile: 'test', spec })
  assert.equal(upgraded.action, 'unmanaged')
  assert.equal(upgraded.error, undefined)
  assert.match(upgraded.warning, /adopt --base-dir/)

  let record = await loadRecord(stateDir, 'local-fixture')
  assert.equal(record.recordedVersion, '2.0.0')
  assert.equal(record.baseline.source, 'unavailable')
  assert.ok(record.files.some((file) => file.path === 'lib/a.js'), '补丁记录本身不应被清空')

  // 后续同版本对账：直接跳过，不再报错、不再尝试联网。
  const again = await reconcilePlugin({ plugin: 'local-fixture', pluginDir, stateDir, profile: 'test', spec })
  assert.equal(again.action, 'unmanaged')
  assert.equal(again.error, undefined)
  record = await loadRecord(stateDir, 'local-fixture')
  assert.equal(record.baseline.source, 'unavailable')
})
