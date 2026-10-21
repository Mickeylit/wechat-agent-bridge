# 在 Windows 的 Codex 和 Claude Code 安装

同一份技能适用于原生 Windows 版 Codex 和 Claude Code。技能安装只复制说明与脚本，不会登录微信、启动模型或改变当前微信绑定。安装不需要 Python；Windows 10/11 自带的 PowerShell 5.1 即可。

## 安装到两个工具

解压发布包，在能看到 `wechat-agent-bridge` 文件夹的位置打开 PowerShell，运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\wechat-agent-bridge\scripts\install-windows.ps1 -Target both
```

这里的执行策略参数仅作用于这次 PowerShell 进程，不修改机器或用户的长期策略；组织策略限制下应按组织要求执行。

默认安装位置：

| 工具 | 技能目录 |
| --- | --- |
| Codex | `%USERPROFILE%\.agents\skills\wechat-agent-bridge` |
| Claude Code | `%USERPROFILE%\.claude\skills\wechat-agent-bridge` |

只安装到一个工具，用 `-Target codex` 或 `-Target claude`。已有版本需要更新时加 `-Update`，旧版本会保留在技能搜索目录之外的 `.skill-backups` 目录中，安装器会显示完整路径。同名目录内容无法确认是本技能时会拒绝覆盖。

若某个 Codex 版本使用旧路径，可以显式指定，不要在两个 Codex 搜索路径重复安装：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\wechat-agent-bridge\scripts\install-windows.ps1 -Target codex -CodexRoot "$env:USERPROFILE\.codex\skills"
```

安装后新开 Codex/Claude Code 会话，输入：

```text
Codex:       $wechat-agent-bridge 帮我把微信接入 Codex
Claude Code: /wechat-agent-bridge 帮我把微信接入 Claude Code
```

在聊天输入框中输入这些调用语句，不是在 PowerShell 执行。也可以用自然语言要求工具使用此技能。

如果你的 Codex/Claude Code 实际运行在 WSL，应在 WSL 的 Linux 用户目录里安装技能；Windows 的 `%USERPROFILE%` 和 WSL 的 `~` 是不同位置，原生 Windows 安装不会自动安装进 WSL。

## 需要实际接入微信时

准备 Node.js 24+ 及已安装、已登录的对应 CLI。Claude Code 的系统依赖按其官方 Windows 安装指南准备（包括版本要求涉及的 Git for Windows/Git Bash）；`CLAUDE_CODE_GIT_BASH_PATH` 如已配置会保留给后台任务。不要向助手提供账户密钥文件。

助手可以使用已安装技能中的 PowerShell 部署入口，无需 Python。例如：

```powershell
$skillPath = Join-Path $env:USERPROFILE '.agents\skills\wechat-agent-bridge'
$runtimePath = Join-Path $env:LOCALAPPDATA 'WeChatAgentBridge'
& (Join-Path $skillPath 'scripts\prepare-windows.ps1') -Destination $runtimePath -Engine codex
Set-Location -LiteralPath $runtimePath
npm.cmd ci --ignore-scripts --no-audit --no-fund
node cli.mjs doctor
node cli.mjs login --web --auto-start
```

在 Claude Code 技能目录中运行时，将 `.agents` 改成 `.claude`；回答引擎选 Claude 时用 `-Engine claude`。如果 PowerShell 脚本策略不允许直接执行，可像安装示例一样通过单次 `powershell -File` 调用部署脚本。已存在且非空的运行目录会被保护，不会覆盖。

扫码页面打开在电脑本机，手机微信扫描该页面中的二维码。手机出现数字验证码时，在运行登录命令的终端输入。确认后会创建当前用户的任务计划，立即启动并在下次登录 Windows 后自动启动，无需管理员密码或 SYSTEM 账户。1.0.1 按 Windows SID 核对任务所属用户，兼容短用户名、域用户名与 SID 的返回格式；不会仅按用户名后缀匹配。安装时会检查目录访问并等待本次后台 worker 的启动状态，未确认启动会返回失败。机器需保持开机、联网、用户已登录。

```powershell
node cli.mjs status
node cli.mjs stop-service
node cli.mjs install-service
```

组织禁用任务计划时可以使用 `npm.cmd start` 前台运行。后台失败最多按一分钟间隔重启三次；凭证失效会停止并要求重新扫码。状态与日志存于运行目录的 `.state`，运行时为该目录设置当前用户及 SYSTEM 的私有 ACL；请使用用户拥有的本地 NTFS 目录。

Windows 命令定位支持原生 `.exe` 和官方 npm 包的 `.cmd` 入口。npm 入口会转换成对应 Node/原生程序直接执行，微信问题仍经 stdin 传入，不交给 `cmd.exe` 拼接。自定义批处理脚本不受支持，需配置原生程序或正常官方安装的 CLI。

## Windows background-service recovery

如果旧版本能在前台回答，却无法后台启动，先更新技能，再按[运行时升级到 1.0.1](operations.md#upgrade-an-existing-runtime-to-101)更新已经部署的程序。只更新技能不会改变旧计划任务使用的代码，修复也不能只留在某个本地副本中。

安装失败时保留输出中的阶段（stage）、任务状态和数字结果码。检查实际运行目录下的 `.state\service.log`，以及“任务计划程序”中该 `local.wechat-agent-bridge.*` 任务的“上次运行结果”。不要把整个 `.state` 目录或凭证文件发给他人。

- 身份不符：确认用扫码、登录 CLI 的同一 Windows 账号安装服务。新版本以 SID 比较身份；无法解析或属于其他用户时会拒绝接管。不要删除其他人的同名任务，也不要用管理员或 SYSTEM 绕过检查。
- 目录访问失败：优先使用当前用户的本地 `%LOCALAPPDATA%\WeChatAgentBridge`。检查运行目录和 Node/CLI 程序是否实际存在、当前用户是否可读取、`.state` 是否可写；检查任务中记录的路径是否还是旧位置。映射网络盘、离线同步目录或会话临时目录可能在后台不可用。不要为解决访问问题给所有用户开放权限。
- 注册成功但启动验证失败：根据阶段和任务结果码检查路径、用户策略及日志。先运行 `node cli.mjs stop-service` 取消失败任务，再在可见且持续运行的终端执行 `npm.cmd start` 作为临时方案。该模式不会在重启后自动恢复；必须如实告知使用者。
- 恢复后台运行：停止前台进程，确认 `node cli.mjs status` 的 `running` 为 false，再执行 `node cli.mjs doctor` 和 `node cli.mjs install-service`。安装验证通过后，确认 `running: true`，从微信发问题并检查 `lastModelReplyAt` 更新。需要验证登录自启动时，实际重新登录 Windows 后再检查，任务注册本身不能替代这一步。

不要为了排查目录问题重新扫码。有效绑定和 `.state` 应保留；如果必须迁移运行目录，先停止所有旧进程、备份，并核对配置中的状态路径和旧任务，再由同一用户在新目录启动。不要同时运行两个轮询进程。

**已报告的 `0x8007010B` 情形**：运行目录已经位于 `%LOCALAPPDATA%\WeChatAgentBridge`，手动启动正常；计划任务使用相同 SID，但任务内部 `Test-Path` 为 false、`Get-Item` 报路径不存在，TaskScheduler 事件 101/203 返回 2147942667。这是任务环境下的目录不可见证据，不能直接解释为 `0x80070005` 权限不足。先核对任务 XML 中原始 `WorkingDirectory`/执行路径、实际展开的环境变量、用户配置文件和重解析点/虚拟化差异；不要盲目放宽 ACL 或让用户重复扫码。若当前有已验证的临时后台进程，应保留它直至替代方案验证通过，并明确它尚无登录自动恢复保证。当前补丁会识别启动未就绪并报告 `0x8007010B`，不声称已修复所有主机上的目录可见性根因。

## 在微信读取本机文件

程序只响应扫码绑定者本人的私聊消息。Claude 默认启用 `Read`、`Grep`、`Glob`，用于读取文件、搜索内容和按名称查找文件；命令执行、写入、编辑及 MCP 工具保持禁用。可以直接在微信发送：

```text
读取 C:\Users\你的用户名\Documents\项目\README.md，概括启动步骤。
在 C:\Users\你的用户名\Documents\项目 中查找名称含 config 的文件，并搜索端口配置。
```

这里填写运行桥接程序的电脑上的绝对路径。明确的读取请求无需再次开启读取权限；文件位置不清楚时，助手会请你提供路径。

已有服务需要先[更新已部署的 Claude 适配器](operations.md#update-an-existing-claude-runtime)才能获得该功能。仅更新技能不会修改运行目录：停止服务，备份并替换 `lib\claude.mjs`，通过 `doctor` 后重启，配置与 `.state` 保留，无需重新扫码。

## 验证状态

本补丁在 macOS 通过 113 项 Node 测试和 25 项 Python 测试，另有 2 项测试仅在 Windows 运行。GitHub Actions 的 Windows 作业执行原生 PowerShell 5.1 的身份解析/启动状态测试，以及安装、更新、备份、运行目录准备；计划任务状态在测试中使用模拟数据，不注册真实任务。流水线的实际执行结果见仓库 Actions。

这些检查不替代目标机器的计划任务启动、重新登录后的自动恢复和微信往返验收。用户报告的临时后台进程收发成功，也不能证明该机器计划任务正常或所有 Windows 环境均已兼容。
