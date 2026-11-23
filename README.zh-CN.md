# dsh-patch-sync（插件修改同步插件）

[English](README.md) | **中文**

给 DSH 用的本地插件：**记录你对其它插件做的修改，并在插件被官方更新覆盖后自动把修改恢复回来**；上游确实改过同一个文件时保留上游文件、不覆盖，并给出提示。

用于配合 `@sueleven/dsh-auto-update` 这类自动更新插件：自动更新会重装插件包、覆盖你的修改，本插件负责记录与恢复。**本插件自身通过 `link:` 安装**，自动更新会跳过非 registry 依赖，因此不会被它更新覆盖。

> 状态：源码与单元测试在本仓库根目录，安装副本在 `~/.dsh/plugins/dsh-patch-sync`（`link:` 到 profile）。覆盖安装副本不会自动生效：需要重启 DSH，或在 profile 里安装/卸载插件触发 DSH 重新加载插件。日志出现新的 `启动 pid=… version=0.1.2` 即已加载新代码。

---

## 设计决定（原需求里"待补充/待定"的部分）

| 项目 | 决定 |
|---|---|
| **记录范围** | profile 中「已下载且已启用」的插件（`dependencies ∩ bundles`，排除插件市场禁用项、排除本插件自身）；只记录插件包目录内文件，排除 `node_modules/`、`state/`、`logs/`、`cache/`、`tmp/` 等运行时目录，以及 `*.log`/`*.tmp`/`*.lock` 等运行时文件 |
| **触发方式** | ① 启动后立即对账；② 对每个已启用插件目录 `fs.watch`（递归，2.5 秒去抖），用户保存修改后约 3 秒自动生成/更新记录；③ 监听 profile 根目录与 `node_modules`（非递归）兜底：更新重装会替换整个插件目录、目录级 watch 可能静默失效，这里收到变化后重扫插件并重建监听；④ 每 5 分钟兜底对账已记录的插件；⑤ 每 60 秒重扫插件列表；⑥ 每 10 分钟（以及 profile 变化时）重建目录监听 |
| **官方基线** | 记录时从 npm registry 下载该插件**精确版本**的 tarball（内存解压），计算官方文件哈希作为基线；缓存到状态目录。离线或私有插件可用 `adopt --base-dir <官方原版目录>` 指定基线 |
| **存储位置** | `~/.dsh/patch-sync/`（与插件包分离，插件更新不会破坏记录）：`records/<plugin>/record.json` + `records/<plugin>/patched/<文件>`（补丁本体）、`baseline/<plugin>/<version>.json`（官方哈希）、`state/status.json`、`reports/latest.md`、`logs/patch-sync.log` |
| **记录内容** | 插件名、记录时版本、每个文件：相对路径 / 类型（modified/added/deleted）/ 官方基线 sha256 / 补丁后 sha256；补丁文件本体原样保存；冲突单独列出（含上游 sha256 与原因） |
| **恢复触发** | 检测到已记录插件的安装版本变化（被官方更新覆盖）→ 等目录静默、且自动更新插件不在安装中（`update.lock`/`updating` 状态）→ 自动恢复；启动时也会兜底对账一次（覆盖"更新时 DSH 没开"的情况，此时恢复后需再重启一次生效） |
| **恢复校验** | 每个写回的文件立即重新计算 sha256 与记录里的 `patchedSha256` 比对；失败记入 `failed` 并在状态/报告/提示卡中显示 |
| **冲突策略** | 恢复时如果某文件当前内容既不是官方基线（`baseSha256`）也不是补丁（`patchedSha256`）→ 判定上游改过该文件：**保留上游文件、不覆盖**，写入冲突记录并提示；用户可手动重新打补丁后 `scan` 重新记录，或 `resolve --accept-upstream` 接受上游 |
| **提示方式** | 浏览器半在右下角显示提示卡（恢复成功/冲突/失败），宿主同时写 `reports/latest.md` 与日志；CLI 可随时查看 |
| **自更新防护** | 以 `link:` 方式安装本插件（`~/.dsh/plugins/dsh-patch-sync`），自动更新插件的候选过滤会把 `link:` 依赖排除 |

## 安装（已完成，供重装参考）

```powershell
# 1. 复制到稳定目录（link 的目标不能是会被清理的临时路径）
# 在仓库根目录执行
Copy-Item -Recurse -Force .\packages\dsh-patch-sync <HOME>\.dsh\plugins\dsh-patch-sync

# 2. 用官方插件通道以 link: 安装（等价于在 profile 里 pnpm add link:...）
#    在 DSH 安装目录执行（ELECTRON_RUN_AS_NODE=1 让它以 Node 方式运行 CLI）
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = "$env:USERPROFILE\.dsh"
& '<DSH_INSTALL>\DeepSeek Harness.exe' --expose-internals `
  '<DSH_INSTALL>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js' `
  plugin --profile desktop add 'link:<HOME>\.dsh\plugins\dsh-patch-sync' --config.minimum-release-age=0

# 3. 重启 DSH
```

安装后 profile `package.json` 里应出现 `"dsh-patch-sync": "link:..."`；自动更新插件的检查会跳过它。

## 首次纳管已有修改（如 dsh-prompt-enhance）

```powershell
node <HOME>\.dsh\plugins\dsh-patch-sync\lib\cli.mjs adopt dsh-prompt-enhance
```

它会下载官方基线与当前安装内容对比，把差异写成记录；之后对该插件的修改会被自动跟踪。

## CLI

```powershell
node lib\cli.mjs status                          # 宿主状态（状态文件）
node lib\cli.mjs list                            # 所有补丁记录
node lib\cli.mjs adopt <plugin> [--base-dir <dir>]  # 首次纳管
node lib\cli.mjs scan [--plugin <name>] [--all]  # 手动对账（记录/恢复）
node lib\cli.mjs restore --plugin <name>         # 只恢复（诊断用）
node lib\cli.mjs resolve <plugin> --accept-upstream [path...]  # 接受上游文件
node lib\cli.mjs report                          # 最近一次报告
```

通用参数：`--dsh-home`、`--profile`、`--state-dir`（默认 `~/.dsh/patch-sync`）。

## 验证

```powershell
# 核心逻辑测试（fixture 模拟"纳管 → 同版本修改 → 官方更新 → 恢复/冲突/校验"）
node test\core.test.mjs

# 宿主半集成测试（假 DSH_HOME；真实 fs.watch/去抖/自动记录/更新后恢复/状态/报告/HTTP 路由，不碰真实 profile）
# 需要允许子进程与文件监听的普通 shell；在受限沙箱里会挂起，因此不纳入 npm test。
node test\host.manual.mjs
```

宿主半运行后：

1. 修改某个已记录插件的文件并保存 → 约 3 秒后 `~/.dsh/patch-sync/records/<plugin>/record.json` 更新；
2. 模拟/等待插件更新 → `~/.dsh/patch-sync/state/status.json` 出现 `lastEvent.kind = restored|conflict`，右侧提示卡出现；
3. `~/.dsh/patch-sync/reports/latest.md` 有逐文件结果与校验情况。

## 安装/升级本插件自身

本插件以 `link:` 指向 `~/.dsh/plugins/dsh-patch-sync`，修改源码后需要：
1. 把新源码覆盖复制到 `~/.dsh/plugins/dsh-patch-sync`；
2. 让 DSH 重新加载插件：重启 DSH，或在 profile 里安装/卸载任意插件（DSH 会重新加载 profile 插件）。`~/.dsh/patch-sync/logs/patch-sync.log` 出现新的 `启动 pid=… version=…` 即生效。

状态目录 `~/.dsh/patch-sync/` 与插件目录分离，覆盖插件源码不会影响已有补丁记录。

## 稳定性加固（0.1.1）

Windows 上 `rename(临时文件, 目标)` 在目标文件被其它句柄占用时会返回 `EPERM`（对账读取 record.json、杀毒/索引服务扫描、两个并发写者都会造成）。0.1.0 只尝试一次，偶发失败会把整次对账记为 error，并留下 `*.tmp-<pid>-<ms>` 残留——即提示卡里的“补丁同步失败：EPERM ... rename `record.json`”。0.1.1 的改动：

1. **临时文件名唯一**：`<目标>.tmp-<pid>-<毫秒>-<自增序号>`，同一毫秒内多次写入也不重名（0.1.0 会重名，后一次 rename 得到 `ENOENT`）。
2. **按目标路径串行**：同一进程内对 `record.json` / `status.json` 的并发原子写排队执行。
3. **瞬时错误退避重试**：`EPERM`/`EACCES`/`EBUSY`/`ENOENT` 等最多重试 9 次、约 1.2 秒；最终失败会清理临时文件并把可读原因写进状态/报告。
4. **同一插件的对账串行合并**：重叠触发（watcher 抖动、周期任务、手动扫描）合并成“跑完再补一次”，避免“一轮正在读 record.json，另一轮 rename 它”。
5. **启动清理残留**：启动时删除状态目录里超过 10 分钟的 `*.tmp-<pid>-<ms>[-<seq>]`。
6. **减少无意义写入**：记录/补丁内容没变就不重写；目录监听从头每分钟重建改为 10 分钟兜底重建（日志不再每分钟刷几十行）。

重试只能覆盖“短暂占用”。如果某个进程持续十几秒占着 `record.json`，写入仍会失败（状态里会看到“原子写失败（尝试 10 次）…”），此时临时文件已被清理，记录本身不会被写坏，下一次对账会重试。

## 本地/私有插件（0.1.2）

`link:` / `file:` / `workspace:` / 绝对路径安装的插件，以及 `package.json` 里 `private: true` 的插件，没有 npm registry 官方基线。0.1.1 及以前，这类插件没有记录时每次文件变化都会报“无法获取该插件版本的官方基线”，弹失败提示卡；0.1.2 起：

- **没有记录时**：不再尝试 registry，直接跳过自动记录（只写一次日志，不弹提示卡、不写失败报告）；
- **已纳管插件升级到没有缓存基线的版本**：记录标记为 `baseline.source = "unavailable"`，跳过自动恢复/对账并提示一次，不再每次对账都报错；记录里的文件条目与补丁本体保留；
- **需要继续跟踪**时，仍用 `adopt --base-dir <官方原版目录>` 显式纳管（把一份原始版本目录当基线）。

CLI `scan --all` 对这类插件会显示 `action=unmanaged` 和原因，不再算作错误。

## 已知限制

- 首次纳管之前的修改无法自动发现（需要 `adopt` 一次；这也是我们给 prompt-enhance 种子记录的方式）。
- 本地 `link:` / 私有插件没有 registry 基线，不会被自动纳管（0.1.2 起静默跳过，不再报错）；要跟踪请 `adopt --base-dir <官方原版目录>`。
- 从 npm tarball 取基线需要联网；离线/私有插件用 `--base-dir`。
- 恢复发生在文件层面，不解决语义冲突：上游改过同一文件时只保留上游并提示。
- 自动更新的安装过程中本插件会等待（检测 `@sueleven/dsh-auto-update` 的 `update.lock` 与 `phase=updating`），安装完成后才恢复；如果更新时 DSH 没开，则下次启动对账恢复，但需再重启一次才能让恢复的代码生效。
- 记录/恢复范围是"插件包目录里的文件"，不涉及 profile 配置、settings 存储等包外内容。
- CLI 与宿主进程同时写同一记录时以最后写入者为准（同进程内串行；跨进程靠原子 rename + 重试，不保证互斥，但不会写出半截文件）。
