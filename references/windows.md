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

扫码页面打开在电脑本机，手机微信扫描该页面中的二维码。手机出现数字验证码时，在运行登录命令的终端输入。确认后会创建当前用户的任务计划，立即启动并在下次登录 Windows 后自动启动，无需管理员密码或 SYSTEM 账户。机器需保持开机、联网、用户已登录。

```powershell
node cli.mjs status
node cli.mjs stop-service
node cli.mjs install-service
```

组织禁用任务计划时可以使用 `npm.cmd start` 前台运行。后台失败最多按一分钟间隔重启三次；凭证失效会停止并要求重新扫码。状态与日志存于运行目录的 `.state`，运行时为该目录设置当前用户及 SYSTEM 的私有 ACL；请使用用户拥有的本地 NTFS 目录。

Windows 命令定位支持原生 `.exe` 和官方 npm 包的 `.cmd` 入口。npm 入口会转换成对应 Node/原生程序直接执行，微信问题仍经 stdin 传入，不交给 `cmd.exe` 拼接。自定义批处理脚本不受支持，需配置原生程序或正常官方安装的 CLI。

本版本已完成 Windows 分支模拟测试及本机回归测试；尚未在真实 Windows 主机执行 PowerShell 安装、任务注册或微信往返测试。目标主机完成实际收发后，才能宣称该主机链路已验证。
