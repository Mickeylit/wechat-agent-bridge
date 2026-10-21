# Deployment and recovery

## Configuration

`scripts/prepare.py` copies only executable source, tests and locked dependency manifests, then creates this private `bridge.config.json`:

```json
{"engine":"codex","stateDir":"./.state"}
```

`engine` accepts `codex` or `claude`. Optional `binary` is the selected CLI name on PATH or its absolute path. Runtime environment overrides are `WECHAT_BRIDGE_ENGINE`, `WECHAT_BRIDGE_STATE_DIR`, `CODEX_BIN`, and `CLAUDE_BIN`. Do not set a global home variable to redirect storage. Relative state paths resolve against the deployed runtime directory.

The runtime stores `auth.json`, `state.json`, `runtime.json`, lock files, transient QR files, and `service.log` in `.state/`. On POSIX the directory is private and JSON state/credentials have mode 0600. Native Windows uses a protected ACL for the current user and SYSTEM; POSIX chmod bits alone are not a Windows privacy guarantee. The queue contains user messages and pending answers; treat it as private content. CLI session data is managed by the CLI's own normal storage.

The macOS service resolves real Node and CLI executables and gives launchd an explicit PATH. Its label is `local.wechat-agent-bridge.<hash-of-state-directory>`. CLI authentication must work for the same local account; secret environment variables present only in an interactive shell are not automatically inherited by launchd. Do not print or embed credentials into a plist to work around that.

On Windows, see [windows.md](windows.md) for native PowerShell installation, Task Scheduler lifecycle and CLI launcher behavior. The task uses the current signed-in user with limited privileges. The scheduled supervisor saves logs and preserves the selected executable paths; normal stop cancels the owned worker before removing the task.

## Upgrade an existing runtime to 1.0.1

Update the installed skill or repository first. This patch fixes Codex retry handling, Windows task identity/startup checks, and the distinction between model answers and error notices. A fresh `prepare` uses the fixed template; an existing deployment requires the separate code update below. Do not rerun `prepare` over it or move its credentials into the skill.

1. Locate the actual runtime and inspect `node cli.mjs status`. Let queued questions finish; if `pending` is nonzero, keep the old worker running until it drains. Stop its service using `node cli.mjs stop-service` (or stop its supervised foreground terminal), then check that `running` is false and `pending` is still zero. If a question arrived during shutdown, restart the old worker to finish it before upgrading.
2. Back up and replace only the eight files below. Preserve `bridge.config.json`, `.state`, CLI session storage and any unrelated local adapters. If any listed file has deliberate local modifications, review that diff and merge the fix instead of overwriting it.

Windows PowerShell, after the worker has stopped:

```powershell
$skillPath = Join-Path $env:USERPROFILE '.agents\skills\wechat-agent-bridge'
$runtimePath = Join-Path $env:LOCALAPPDATA 'WeChatAgentBridge'
$sourcePath = Join-Path $skillPath 'assets\bridge'
$files = @('cli.mjs', 'package.json', 'package-lock.json', 'lib\codex.mjs', 'lib\bridge.mjs', 'lib\weixin.mjs', 'lib\windows-service.mjs', 'lib\windows-runtime.mjs')
$backupPath = Join-Path $runtimePath ('.state\upgrade-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourcePath $file) -PathType Leaf)) { throw "Missing update source: $file" }
    if (-not (Test-Path -LiteralPath (Join-Path $runtimePath $file) -PathType Leaf)) { throw "Unsupported runtime layout: $file" }
}
New-Item -ItemType Directory -Path (Join-Path $backupPath 'lib') -ErrorAction Stop | Out-Null
foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $runtimePath $file) -Destination (Join-Path $backupPath $file) -ErrorAction Stop
}
foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $sourcePath $file) -Destination (Join-Path $runtimePath $file) -Force -ErrorAction Stop
}
Set-Location -LiteralPath $runtimePath
node cli.mjs doctor
if ($LASTEXITCODE -ne 0) { throw 'Doctor failed. Restore the backed-up files before restarting.' }
node cli.mjs install-service
if ($LASTEXITCODE -ne 0) { throw 'Background startup failed. Inspect its diagnostics; do not report automatic startup as working.' }
node cli.mjs status
```

Use `.claude` instead of `.agents` for that skill installation. Set `$runtimePath` to the existing deployment, not a new directory. Keep `$backupPath` to restore the same files if validation fails. No dependency versions change in this patch, so a working 1.0.0 deployment needs no new `npm ci`.

macOS/Linux, after the worker has stopped:

```sh
(
  set -eu
  skill_path="$HOME/.agents/skills/wechat-agent-bridge"
  runtime_path="$HOME/.local/share/wechat-agent-bridge"
  backup_path="$runtime_path/.state/upgrade-backup-$(date +%Y%m%d-%H%M%S)"
  for file in cli.mjs package.json package-lock.json lib/codex.mjs lib/bridge.mjs lib/weixin.mjs lib/windows-service.mjs lib/windows-runtime.mjs; do
    test -f "$skill_path/assets/bridge/$file"
    test -f "$runtime_path/$file"
  done
  mkdir -p "$backup_path/lib"
  for file in cli.mjs package.json package-lock.json lib/codex.mjs lib/bridge.mjs lib/weixin.mjs lib/windows-service.mjs lib/windows-runtime.mjs; do
    cp "$runtime_path/$file" "$backup_path/$file"
  done
  for file in cli.mjs package.json package-lock.json lib/codex.mjs lib/bridge.mjs lib/weixin.mjs lib/windows-service.mjs lib/windows-runtime.mjs; do
    cp "$skill_path/assets/bridge/$file" "$runtime_path/$file"
  done
  cd "$runtime_path"
  node cli.mjs doctor
)
```

Use the actual paths. After `doctor` succeeds, restart with `node cli.mjs install-service` from the runtime on macOS, or `npm start` in a supervised terminal on Linux/WSL. If copying or validation fails, leave the worker stopped, restore the backed-up code and run `doctor` before starting the old version.

3. Confirm `runtimeVersion` is `1.0.1`, `running` is true and `requiresLogin` is false. Ask the bound owner to resend a question that previously got an error notice. Confirm `lastModelReplyAt` advances and `lastReplyKind` becomes `model`; queued new questions may still be processing. A failed request is not automatically replayed, and an error notice advancing `lastReplyAt` is not proof of a model answer. No new pairing is required while the binding remains valid.

## Reconnect after unlinking or token invalidation

1. Stop the existing deployment with `node cli.mjs stop-service`. Stop any foreground poller/login process owned by this deployment as well. Do not kill unrelated agents.
2. Run `node cli.mjs login --web --auto-start` on macOS or Windows, and complete phone confirmation.
3. A new login archives old pending replies into `.state/pending-before-login-*.json` and clears the old polling cursor. Ask the user to resend interrupted questions. Old context tokens must not be reused across bindings.
4. Confirm a real incoming question has a successful reply. `bound: true` only means a credential file exists; also inspect `requiresLogin`, `running`, `pending`, `lastReplyKind` and `lastModelReplyAt`. `lastReplyAt` includes service/error messages.

One WeChat user cannot keep multiple instances independently bound. Repeated scans on old screenshots or scanning a different tool's QR can replace the currently valid instance. A manual unlink also produces `-14`. Tencent documents this as a stale bot token; reauthentication is required.

If the old deployment used a different runtime/launchd label, use its own stop command before replacing it. This package does not migrate or terminate existing deployments automatically. Skill installation alone needs no reconnect.

## Change the answering backend

First confirm the deployment supports `bridge.config.json` and both runners. Check the new CLI installation and capabilities before interrupting the working service. Let the current queue drain, stop the service, then check `pending` again for messages received during shutdown. If work remains, resume the old backend to finish it, or reconnect with the user so the old queue is archived explicitly.

Keep a local copy of the old configuration, edit `engine`, and update/remove a `binary` that points at the old CLI. Check environment overrides too: `WECHAT_BRIDGE_ENGINE` and `CODEX_BIN`/`CLAUDE_BIN` take precedence over the file. Run `doctor`, then reinstall/start the service to regenerate its background-service environment. On startup the runtime automatically clears the old CLI session ID when the engine changes; do not manually copy Codex IDs into Claude. The same valid state directory needs no new WeChat binding. If the new backend cannot start, restore the previous configuration and restart the old backend.

Legacy `wechat-codex` deployments without engine selection cannot be converted by just adding a config file. When the user requests that change, prepare a separate new deployment, validate its backend first, drain and stop the legacy service using its own command, then pair the new deployment. Preserve the legacy state for rollback; do not bundle or move its credentials into the skill. Explain that replacing the binding invalidates the old token, so rolling back after a new pairing needs another deliberate pairing. Do not claim an automatic legacy migration.

## Update an existing Claude runtime

Installing or updating the skill does not change a separately deployed runtime. To add the default `Read`/`Grep`/`Glob` capability to an existing deployment of this package, update **only `lib/claude.mjs`** from the refreshed skill asset. Keep `bridge.config.json`, `.state`, and the CLI's session storage in place. No new QR pairing is needed. This procedure is for a deployment already using the Claude backend, not the legacy Codex-only bridge.

1. Update the installed skill first, or use a freshly updated repository as the source. Let the current answer finish and the queue drain. Stop the background service with `node cli.mjs stop-service` from its runtime directory; for a foreground process, stop its terminal with `Ctrl+C`.
2. Back up the deployed adapter, then copy the updated asset over that adapter. Set both paths to the actual locations on this computer. Do not rerun `prepare` over the existing runtime.

Windows PowerShell, using an updated Claude skill installation:

```powershell
$skillPath = Join-Path $env:USERPROFILE '.claude\skills\wechat-agent-bridge'
$runtimePath = Join-Path $env:LOCALAPPDATA 'WeChatAgentBridge'
$adapterPath = Join-Path $runtimePath 'lib\claude.mjs'
$backupPath = "$adapterPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $adapterPath -Destination $backupPath -ErrorAction Stop
Copy-Item -LiteralPath (Join-Path $skillPath 'assets\bridge\lib\claude.mjs') -Destination $adapterPath -Force -ErrorAction Stop
Set-Location -LiteralPath $runtimePath
node cli.mjs doctor
if ($LASTEXITCODE -ne 0) { throw 'doctor failed; keep the service stopped and restore the adapter backup if needed.' }
```

Use `.agents` instead of `.claude` when the updated skill is installed in Codex. A refreshed repository folder may also be used as `$skillPath`.

macOS/Linux, using an updated Claude skill installation:

```sh
skill_path="$HOME/.claude/skills/wechat-agent-bridge"
runtime_path="$HOME/.local/share/wechat-agent-bridge"
adapter_path="$runtime_path/lib/claude.mjs"
backup_path="$adapter_path.bak-$(date +%Y%m%d-%H%M%S)"
cp "$adapter_path" "$backup_path" &&
cp "$skill_path/assets/bridge/lib/claude.mjs" "$adapter_path" &&
cd "$runtime_path" &&
node cli.mjs doctor
```

Use `.agents` instead of `.claude` if applicable, or set `skill_path` to the refreshed repository folder.

3. Restart **only after `doctor` succeeds**: `node cli.mjs install-service` on macOS/Windows, or `npm start` for foreground Linux/WSL. If validation fails, correct the CLI compatibility issue while the service is stopped, or restore the saved adapter to `lib/claude.mjs`, run `doctor` again, and restart the previous version.
4. From the bound owner's WeChat, request a file read using an absolute path on the bridge computer. Existing sessions use the updated instructions on resume, so `/new` and new pairing are unnecessary for this update.

## Diagnosing common failures

| Symptom | Action |
| --- | --- |
| QR expired | Keep the login process alive and use its automatic web page or newest `QR_READY` filename. Old chat images stay stale. |
| `-14` | Treat the token as invalid; stop and reconnect. Do not attribute it to answer latency. |
| CLI not found | Run `doctor`; supply its absolute executable path in `binary` if PATH differs. |
| Claude rejects a flag | Upgrade to a version whose `--help` includes all required flags. Keep permission restrictions. |
| Claude still says local reads are unavailable after a skill update | Update the deployed `lib/claude.mjs` using the procedure above, then run `doctor` and restart the service. Updating the skill alone does not update the running adapter. |
| Claude refuses nested invocation | Launch the bridge from a normal terminal/service with no nested Claude session. Do not strip authentication or permission protections as a workaround. |
| Login succeeds but model fails | Verify the chosen CLI's normal login, account access, connectivity and quota locally. The CLI errors exposed to WeChat are deliberately sanitized. |
| Replies queue during network outage | Keep the service running; it persists answers and retries with the same client IDs. An unknown delivery outcome can still cause a duplicate. |
| Codex generated an answer but WeChat received a failure notice | Upgrade both the skill and runtime to 1.0.1. A nonterminal Codex `error` can be followed by successful `turn.completed`; terminal failure, nonzero exit or incomplete answers still fail. |
| Windows task registered but no worker is running | Inspect the startup stage/result code, runtime path and state permissions using [Windows recovery](windows.md#windows-background-service-recovery). Registration or a hidden terminal process does not prove restart after sign-in. |
| `STATE_FAILED` | Fix disk/permission issues before restarting. Never move the cursor ahead of an unsaved inbox. |
| launchd cannot read runtime | Check actual logs and macOS privacy restrictions for that folder. Use an authorized location. Do not blanket-grant Full Disk Access. |
| Works until Mac sleeps | The host must stay awake and online; login service is not a cloud service. |

Do not repeatedly run model tests after the needed checks pass. The package provides offline `node --test`/`npm test`; it does not authorize sending messages or spending model calls just to verify installation.

## Capability limits

Text questions and upstream-provided voice transcripts are supported. Only the QR-bound owner's private messages are handled; other senders, groups and bot messages are rejected. Claude enables local `Read`, `Grep`, and `Glob` by default, so the owner can request file reading, content search and filename matching without repeated permission-enabling questions. Use an absolute path on the bridge computer, such as `C:\Users\Alice\Documents\demo\README.md` or `/Users/alice/Projects/demo/README.md`.

Claude shell execution, writes, edits, notebook edits, and MCP tools remain disabled. Image/video understanding, WeChat file attachments, cancellation commands, desktop thread takeover and remote file editing are not implemented. Codex uses a read-only filesystem sandbox. CLI permissions still run within the local account's operating-system permissions; this package does not grant additional OS access.

## Validation evidence for this package

The source Codex bridge was tested with a real paired WeChat account, a real Codex answer and a successful WeChat reply, including continuation of a CLI session. The dual-engine package adds portable configuration, native Windows installation helpers, Windows CLI/task support and Claude Code support. The 1.0.1 patch passed **115 Node tests and 25 Python tests on Windows CI**, plus native PowerShell 5.1 installation, update, backup and runtime preparation for both skill hosts. macOS and Ubuntu each passed **113 Node tests and 25 Python tests**, with two Windows-only tests skipped. See the [successful CI run](https://github.com/Mickeylit/wechat-agent-bridge/actions/runs/39582144820). Task readiness is tested with simulated scheduler data, not a real registered task. These tests do not prove target-host scheduled startup, automatic recovery after sign-in, or model-to-WeChat delivery. A temporary process reported working on one Windows host does not validate its scheduled task. Each account/host still needs its own end-to-end check.
