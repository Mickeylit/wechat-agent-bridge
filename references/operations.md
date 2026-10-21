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

## Reconnect after unlinking or token invalidation

1. Stop the existing deployment with `node cli.mjs stop-service`. Stop any foreground poller/login process owned by this deployment as well. Do not kill unrelated agents.
2. Run `node cli.mjs login --web --auto-start` on macOS or Windows, and complete phone confirmation.
3. A new login archives old pending replies into `.state/pending-before-login-*.json` and clears the old polling cursor. Ask the user to resend interrupted questions. Old context tokens must not be reused across bindings.
4. Confirm a real incoming question has a successful reply. `bound: true` only means a credential file exists; also inspect `requiresLogin`, `running`, `pending` and `lastReplyAt`.

One WeChat user cannot keep multiple instances independently bound. Repeated scans on old screenshots or scanning a different tool's QR can replace the currently valid instance. A manual unlink also produces `-14`. Tencent documents this as a stale bot token; reauthentication is required.

If the old deployment used a different runtime/launchd label, use its own stop command before replacing it. This package does not migrate or terminate existing deployments automatically. Skill installation alone needs no reconnect.

## Change the answering backend

First confirm the deployment supports `bridge.config.json` and both runners. Check the new CLI installation and capabilities before interrupting the working service. Let the current queue drain, stop the service, then check `pending` again for messages received during shutdown. If work remains, resume the old backend to finish it, or reconnect with the user so the old queue is archived explicitly.

Keep a local copy of the old configuration, edit `engine`, and update/remove a `binary` that points at the old CLI. Check environment overrides too: `WECHAT_BRIDGE_ENGINE` and `CODEX_BIN`/`CLAUDE_BIN` take precedence over the file. Run `doctor`, then reinstall/start the service to regenerate its background-service environment. On startup the runtime automatically clears the old CLI session ID when the engine changes; do not manually copy Codex IDs into Claude. The same valid state directory needs no new WeChat binding. If the new backend cannot start, restore the previous configuration and restart the old backend.

Legacy `wechat-codex` deployments without engine selection cannot be converted by just adding a config file. When the user requests that change, prepare a separate new deployment, validate its backend first, drain and stop the legacy service using its own command, then pair the new deployment. Preserve the legacy state for rollback; do not bundle or move its credentials into the skill. Explain that replacing the binding invalidates the old token, so rolling back after a new pairing needs another deliberate pairing. Do not claim an automatic legacy migration.

## Diagnosing common failures

| Symptom | Action |
| --- | --- |
| QR expired | Keep the login process alive and use its automatic web page or newest `QR_READY` filename. Old chat images stay stale. |
| `-14` | Treat the token as invalid; stop and reconnect. Do not attribute it to answer latency. |
| CLI not found | Run `doctor`; supply its absolute executable path in `binary` if PATH differs. |
| Claude rejects a flag | Upgrade to a version whose `--help` includes all required flags. Keep permission restrictions. |
| Claude refuses nested invocation | Launch the bridge from a normal terminal/service with no nested Claude session. Do not strip authentication or permission protections as a workaround. |
| Login succeeds but model fails | Verify the chosen CLI's normal login, account access, connectivity and quota locally. The CLI errors exposed to WeChat are deliberately sanitized. |
| Replies queue during network outage | Keep the service running; it persists answers and retries with the same client IDs. An unknown delivery outcome can still cause a duplicate. |
| `STATE_FAILED` | Fix disk/permission issues before restarting. Never move the cursor ahead of an unsaved inbox. |
| launchd cannot read runtime | Check actual logs and macOS privacy restrictions for that folder. Use an authorized location. Do not blanket-grant Full Disk Access. |
| Works until Mac sleeps | The host must stay awake and online; login service is not a cloud service. |

Do not repeatedly run model tests after the needed checks pass. The package provides offline `node --test`/`npm test`; it does not authorize sending messages or spending model calls just to verify installation.

## Capability limits

Text questions and upstream-provided voice transcripts are supported. Images, videos, files, group conversations, cancellation commands, desktop thread takeover and remote file editing are not implemented. Codex's read-only filesystem sandbox does not independently prohibit configured MCP network side effects; the adapter's Q&A instructions do not replace platform policy. Claude's no-tool/safe-mode configuration is not an OS sandbox, and administrator-managed policy hooks may still run. Treat any expansion to tool actions as a separate requested change.

## Validation evidence for this package

The source Codex bridge was tested with a real paired WeChat account, a real Codex answer and a successful WeChat reply, including continuation of a CLI session. The dual-engine package adds portable configuration, native Windows installation helpers, Windows CLI/task support and Claude Code support. Windows-specific behavior has simulated tests on macOS; no real Windows installation or end-to-end success is claimed. Claude tests use simulated CLI events because Claude Code was not installed on the authoring machine; no real Claude-to-WeChat success is claimed. Each new account/host still needs its own end-to-end check.
