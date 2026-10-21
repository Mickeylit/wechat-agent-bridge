# Protocol and runner notes

Sources checked while creating this skill:

- Tencent's [Weixin backend protocol](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md), [login implementation](https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts), and [API implementation](https://github.com/Tencent/openclaw-weixin/blob/main/src/api/api.ts). The template uses client metadata matching version 2.4.10, with its own `bot_agent` attribution.
- [OpenAI Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/) and [SDK](https://developers.openai.com/codex/sdk/).
- [Claude Code programmatic usage](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference), and [result event schema](https://platform.claude.com/docs/en/agent-sdk/typescript).
- [OpenAI local skill discovery](https://developers.openai.com/codex/skills/).
- [Claude Code skills](https://code.claude.com/docs/en/skills).

These are public client behavior documents, not a promise of permanent endpoint or account availability. Consult current official sources before changing flags, authentication behavior or protocol versions.

## WeChat transport

Default origin: `https://ilinkai.weixin.qq.com`. Obtain QR with `POST /ilink/bot/get_bot_qrcode?bot_type=3`; poll `GET /ilink/bot/get_qrcode_status?qrcode=...`. QR POST includes application headers, `AuthorizationType` and a random base64 `X-WECHAT-UIN`; QR GET includes only application headers. Neither carries a bot bearer token.

After confirmation, save `bot_token`, `ilink_bot_id`, `ilink_user_id`, and the validated `baseurl`. Redirects must stay on HTTPS `weixin.qq.com` or its subdomains with no credentials/custom ports. The HTTP client rejects automatic redirects, avoiding credential forwarding. Pairing states include `wait`, `scaned`, `need_verifycode`, `confirmed`, `expired`, `verify_code_blocked`, `scaned_but_redirect`, and `binded_redirect`.

Authenticated operations include `base_info` and bearer headers:

- `POST /ilink/bot/getupdates` with previous `get_updates_buf`.
- `POST /ilink/bot/sendmessage` with `message_type: 2`, `message_state: 2`, recipient, unique client ID, text item, and inbound `context_token`.
- `POST /ilink/bot/msg/notifystart` / `notifystop` for lifecycle notifications.

Preserve uint64 message IDs exactly. Node 24's JSON reviver `context.source` avoids rounding IDs before deduplication. Inbound states need not equal 2: the official receiver does not enforce that filter. Only process owner messages, and atomically persist the inbox before advancing its cursor.

The bundled login intentionally creates a new binding (`local_token_list: []`). Do not use it as a health check for an already working service. Tencent's current full client can provide existing local tokens and receive `binded_redirect`; this minimal bridge reports that state and stops rather than pretending new credentials were issued.

## Backend interfaces

Both adapters implement `run({prompt, threadId, cwd, signal, onThread, timeoutMs}) -> {text, threadId}`. CLI binaries are configurable; prompts travel through stdin with `shell: false`.

Codex uses `-a never -s read-only exec --json --skip-git-repo-check -`, adding `resume <threadId>` for continuation. Capture `thread.started` and final `agent_message`; require a completed turn and successful exit. Never forward reasoning, tool events or stderr.

Claude uses `-p --output-format stream-json --verbose --safe-mode --tools '' --disallowedTools 'mcp__*' --permission-mode dontAsk --permission-prompts none` and `--resume <sessionId>` when continuing. `--tools ''` alone does not disable MCP; both controls matter. `--safe-mode` retains normal account login while disabling ordinary customizations. Parse `system/init` session IDs and only return a successful final `result`, requiring `subtype: success`, `is_error: false` and a successful exit. `--permission-prompts` requires at least 2.1.259; verify flags with `doctor`.

Never use `--dangerously-skip-permissions`, Codex full-access/bypass flags, copied account tokens, or shell interpolation of user text to get a bridge working. The package is Q&A by design.

## Native Windows integration

See [Node child_process](https://nodejs.org/api/child_process.html) for the Windows `.cmd` limitation. The adapter reads known official npm package bin metadata and invokes Node or a native executable directly; it does not execute arbitrary batch files. PATH/PATHEXT are resolved case-insensitively. Windows cancellation invokes the system `taskkill.exe /T /F` for the numeric child PID.

Windows background tasks use Microsoft [New-ScheduledTaskPrincipal](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal), [New-ScheduledTaskSettingsSet](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset), and [Register-ScheduledTask](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/register-scheduledtask). Native argument quoting follows the [Windows CRT rules](https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments). PowerShell code is encoded as UTF-16LE and receives no user questions or credentials.
