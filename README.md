# dsh-patch-sync

**English** | [中文](README.zh-CN.md)

Records the local edits you make to other DSH plugins, and restores them after an official update
overwrites the package. If upstream really changed the same file, the upstream file is kept, a
conflict is recorded, and you are told — local work is never silently overwritten.

Designed to work alongside auto-update plugins. This plugin itself is installed via `link:`, so
auto-updaters skip it and cannot overwrite it.

## What is recorded

Enabled plugins in the profile (`dependencies ∩ bundles`, excluding the market's disabled entries
and this plugin). Only files inside the plugin package are recorded — `node_modules/`, `state/`,
`logs/`, `cache/`, `tmp/` and runtime files such as `*.log`, `*.tmp`, `*.lock` are ignored.

## How it works

- On startup: reconcile immediately.
- `fs.watch` each enabled plugin (recursive, 2.5 s debounce); a save creates/updates a record after
  ~3 s.
- Watch the profile root and `node_modules` (non-recursive) so a reinstall that replaces the whole
  directory is noticed and watches are rebuilt.
- Extra reconciliation every 5 minutes, plugin-list rescan every 60 s, watch rebuild every 10 min.
- Baseline: download the exact upstream version tarball from npm, hash the official files in memory.
  Offline/private plugins can use `adopt --base-dir <official-copy>`.
- Storage lives under `~/.dsh/patch-sync/` (separate from the package, so updates cannot destroy
  records): `records/<plugin>/record.json` + `patched/<file>`, `baseline/<plugin>/<version>.json`,
  `state/status.json`, `reports/latest.md`, `logs/patch-sync.log`.
- Restore: when an installed version change is detected (and no auto-update is in progress), copy
  the patched files back and verify each written file's sha256 against `patchedSha256`.
- Conflict: if the current file is neither the official baseline nor the patch, keep upstream, record
  the conflict, and surface it in the status card / report.

## CLI

```bash
node lib/cli.mjs status                          # host state
node lib/cli.mjs list                            # all records
node lib/cli.mjs adopt <plugin> [--base-dir <dir>]  # start tracking
node lib/cli.mjs scan [--plugin <name>] [--all]  # manual reconcile
node lib/cli.mjs restore --plugin <name>         # restore only (diagnostics)
node lib/cli.mjs resolve <plugin> --accept-upstream [path...]
node lib/cli.mjs report                          # latest report
```

Common flags: `--dsh-home`, `--profile`, `--state-dir` (default `~/.dsh/patch-sync`).

`link:`, private and otherwise unmanaged packages are reported as `action=unmanaged` and skipped —
they have no registry baseline. To track one, adopt it with `--base-dir`.

## Install

Install as a `link:` bundle like any other DSH plugin:

```powershell
# Quit DSH first.
pwsh -NoProfile -File .\scripts\install.ps1
```

It copies the package to `%USERPROFILE%\.dsh\plugins\dsh-patch-sync`, writes the `link:` dependency,
appends the bundle, and backs up `package.json`. Restart DSH afterwards.

Updating the runtime copy does not hot-reload: restart DSH (or trigger a plugin reload). The log
line `启动 pid=… version=0.1.2` confirms the new code is loaded.

## Tests

```powershell
npm test                  # core: 13 cases
node test\host.manual.mjs # manual: real fs.watch / child processes; needs a normal desktop host
```

The manual test is excluded from `npm test` because it needs an unrestricted environment.

## Compatibility

DSH 0.2.2-rc.5, Windows 10/11, Node >= 20.

## License

MIT — see [LICENSE](LICENSE). Security policy: [SECURITY.md](SECURITY.md).
