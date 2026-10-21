---
name: wechat-agent-bridge
description: Set up and troubleshoot a personal WeChat chat bridge to local Codex or Claude Code for continuous Q&A. Use when the user asks to 接入微信, 微信控制 Codex/Claude Code, 微信机器人问答, reconnect QR login, or package this bridge. Supports both skill hosts; uses Tencent's published iLink protocol, not enterprise group webhooks.
metadata:
  version: 1.0.1
---

# WeChat agent bridge

Skill version: `1.0.1`.

Connect ordinary WeChat to a local CLI and return final answers to the paired user. This skill works in Codex and Claude Code; the **host running the skill** and the **CLI answering WeChat messages** are separate choices. Use the requested backend. If unspecified, use the host's CLI when installed and authenticated; ask only if that cannot be inferred.

Resolve bundled paths relative to this `SKILL.md`, and invoke helper scripts by absolute path. Do not depend on Codex desktop tools, `${CLAUDE_SKILL_DIR}`, a fixed username, `/usr/local/bin`, or the current directory. For Windows installation into Codex and Claude Code, read [windows.md](references/windows.md). Its PowerShell installer needs no Python, Node, model login, or WeChat pairing just to install the skill.

## Scope and prerequisites

- To run the bridge: Node.js 24+ and the chosen CLI installed and normally authenticated. Deployment helpers use Python 3, or PowerShell 5.1 on Windows. Do not request pasted API keys or account credential files.
- Codex uses `codex exec` with a read-only sandbox and no interactive approvals. Claude uses headless print mode with `Read`, `Grep`, and `Glob` enabled and preapproved by default; `Bash`, `Write`, `Edit`, `NotebookEdit`, and all MCP tools are disabled. The runtime supports Q&A and local reading/search; file changes, computer control, group bots, and media processing require separate implementation.
- Only the QR-bound owner's private messages are handled. Their explicit request to read or search local files authorizes the default read tools; do not repeatedly ask them to enable reading. Use absolute paths on the bridge computer, such as `C:\Users\Alice\Documents\demo\README.md` or `/Users/alice/Projects/demo/README.md`. Ask for the path when the target is unclear.
- The bundled background-service commands support macOS launchd and a current-user Windows scheduled task. Foreground execution is available on other supported Node environments. Windows-specific behavior has simulated tests; verify an actual host before claiming its end-to-end connection works.
- Installing or packaging the skill does **not** authorize pairing a new account, replacing a running bridge, or sending test messages. When the user requests the working WeChat reply chain, replying to that paired user's incoming questions is within scope. Human QR confirmation and any displayed pairing code remain necessary.

## Existing connection first

If a deployment already exists, inspect its `node cli.mjs status`, configuration and redacted service logs. Reuse a working deployment unless the user requests replacement. Do not start a second poller or regenerate credentials just to validate this skill. A WeChat user can have one bound instance; binding another or manually unlinking invalidates the previous token.

For a new deployment, choose a stable user-owned runtime directory **outside the skill folder**. Ask for a location only if the environment does not provide a suitable workspace. Do not run the bundled asset directly: the helper separates code from credentials and upgrades.

```sh
python3 /absolute/path/to/wechat-agent-bridge/scripts/prepare.py --dest /absolute/runtime/wechat-bridge --engine codex
```

Use `--engine claude` for Claude Code. The parent directory must exist; the destination must be new or empty. `--dry-run` validates without writing. Then, from the created runtime:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node cli.mjs doctor
```

On Windows, use `scripts/prepare-windows.ps1 -Destination C:\absolute\runtime\wechat-bridge -Engine codex` instead of the Python helper, and `npm.cmd ci --ignore-scripts --no-audit --no-fund` from PowerShell. Choose a runtime directory under the current user's local profile. Both installed skill hosts can run these same helpers.

`doctor` verifies the selected CLI and version capabilities without invoking a model. It does not prove authentication or quota. Claude needs at least 2.1.259 and every flag required by the runtime; capability checks include `--allowedTools`, `--safe-mode`, and `--system-prompt-snapshot`. Do not infer flag availability from the version alone. Fix missing tools/login before generating the QR code. Do not silently remove permission controls for older CLI versions.

## Pair and start

On macOS or native Windows, when a running bridge is requested:

```sh
node cli.mjs login --web --auto-start
```

Keep this command alive. Open its `LOGIN_PAGE http://127.0.0.1:.../` URL on **the same computer** so the user can scan it with phone WeChat. The page automatically displays refreshed QR codes and hides them on successful binding. It exposes no account credentials and only accepts GET requests. The phone does not need to open the localhost URL.

If a browser is unavailable, omit `--web` and show the latest absolute PNG path from `QR_READY`. Each refresh uses a unique filename. When a QR expires, show the **new** file; never keep reposting a cached old PNG. If the chat only exposes output files, copy that latest PNG to the outputs directory under a new filename, then display it. Do not save or share the decoded login URL beyond pairing.

If `VERIFY_CODE_REQUIRED` appears, have the user enter the digits in the login terminal, or pass the digits they provide into that process's stdin. Do not echo codes into logs. Wait for `LOGIN_SUCCESS`; check `status` after auto-start. Pairing is bounded to 10 minutes without the web page or 30 minutes with it, with bounded QR refreshes. A failed pairing should report the actual state and allow a deliberate retry.

On other systems, omit `--auto-start`; after login use `npm start` in a supervised terminal. The computer must remain awake, online and signed in for the per-user background service to run.

## Verify the result

Ask the user to send a simple question in the newly connected WeChat conversation. Check that it is received, a final model answer is generated, and the send request succeeds (`lastModelReplyAt` advances, `lastReplyKind` is `model`, pending queue drains). `lastReplyAt` also advances for error notices and commands, so it alone does not prove a successful model answer. For older runtimes, inspect both the model result and redacted service logs. Only then describe the full chain as working. Test a follow-up if continuity is relevant. Do not send messages to unrelated contacts or make an unsolicited outbound greeting.

Available WeChat commands: `/new` or `/新对话`, `/status` or `/状态`, `/help` or `/帮助`. Normal questions continue the same local CLI session; they do not automatically continue a desktop app's open chat.

## Operations and repair

From the runtime directory:

```sh
node cli.mjs status
node cli.mjs stop-service
node cli.mjs install-service
```

Read [operations.md](references/operations.md) for reconnects, backend changes, deployment configuration, and troubleshooting. Read [protocol.md](references/protocol.md) only when changing the wire protocol or runner integration. Run the bundled isolated tests when changing code; routine login does not require running the suite again.

For the 1.0.1 compatibility fixes, follow [Upgrade an existing runtime](references/operations.md#upgrade-an-existing-runtime-to-101). Update the installed skill and separately patch the deployed runtime, preserving configuration, credentials and CLI sessions. Do not leave a fix only in a local runtime when the user asks to fix this skill. A transient Codex `error` event may be followed by a successful completion; only terminal failure, nonzero exit, or an incomplete answer should fail the invocation.

On Windows, treat scheduled-task registration and a functioning background worker as separate checks. The installer verifies account SID and worker startup. If startup fails, inspect the reported stage and task result, then follow [Windows background-service recovery](references/windows.md#windows-background-service-recovery). Do not silently substitute a hidden process and describe it as automatic startup. Keep a working foreground process until a deliberate, verified service replacement is ready; do not run duplicate pollers.

Updating an installed skill does not update a deployed runtime. For this Claude read/search update, follow [Update an existing Claude runtime](references/operations.md#update-an-existing-claude-runtime): stop the deployment, back up and replace only its `lib/claude.mjs` from the updated asset, run `doctor`, then restart. Preserve `bridge.config.json`, `.state`, and the current WeChat binding; do not rerun `prepare` over a live deployment or ask for new pairing.

Preserve these invariants when adapting the runtime:

- Only the QR-confirmed `ilink_user_id` may match inbound `from_user_id`; reject groups and bot messages. Do not grant access to the first sender.
- Bot tokens and reply context remain in private runtime state, never in skill assets, logs, exports or messages. Only send bearer tokens to validated HTTPS Weixin origins; do not follow arbitrary redirects.
- Commit inbox and cursor together, persist generated replies before sending, reuse client IDs on retry, and stop on persistence failure. Exact-once delivery cannot be promised after an ambiguous network failure.
- `-14` means the bot token is invalid. Stop the service and reconnect rather than endlessly retrying. It is not evidence of a slow model response.
- Pass user text to CLI stdin without a shell. Return only final model text. Never loosen sandbox/permission settings to make a retry succeed.

## Skill installation and sharing

Use the same folder in `~/.agents/skills/wechat-agent-bridge/` and `~/.claude/skills/wechat-agent-bridge/`; only standard `name`/`description` frontmatter is required. `agents/openai.yaml` is optional Codex UI metadata. The included `scripts/install.py --target both` installs this skill without deploying or starting the runtime. It refuses an existing destination. For a Codex installation that loads `~/.codex/skills`, use `--codex-root /absolute/path/to/.codex/skills`; avoid installing duplicate copies into both Codex discovery roots. Use `--scope project --project /absolute/repo` for repository-local `.agents/skills` and `.claude/skills` instead.

On Windows, `scripts/install-windows.ps1 -Target both` installs to `%USERPROFILE%\.agents\skills` and `%USERPROFILE%\.claude\skills`, without Python. Use `-Target codex` or `-Target claude` for one host. Existing installs require deliberate `-Update`, which retains a backup. Python installs likewise support `--update`. Never auto-update a differently named or unrecognized skill.

Invoke in Codex as `$wechat-agent-bridge`, in Claude Code as `/wechat-agent-bridge`, or ask for this workflow in natural language. If newly installed skills are not discovered in the current session, start a new chat/session.
