# 微信接入 Codex / Claude Code

在手机普通微信里发问题，由你电脑上的 Codex 或 Claude Code 回答，再把答案发回微信。支持连续对话，适合离开电脑后继续提问。

当前版本：**[v1.0.0](https://github.com/Mickeylit/wechat-agent-bridge/releases/tag/v1.0.0)** · [下载技能安装包](https://github.com/Mickeylit/wechat-agent-bridge/releases/download/v1.0.0/wechat-agent-bridge-v1.0.0.zip)。

技能版本记录在 `SKILL.md` 的 `metadata.version`，运行时版本记录在 `assets/bridge/package.json`，发布标签为 `v1.0.0`。后续修复递增补丁号、新增兼容功能递增次版本号、不兼容变更递增主版本号；每次发布保留对应标签和版本说明。

```text
手机微信发问题 → 电脑上的桥接程序 → Codex / Claude Code → 微信收到回答
```

本仓库提供可安装到两个工具的 **Agent Skill**，以及独立运行的桥接程序。安装技能后，可以让 Codex 或 Claude Code 按步骤完成接入。使用腾讯公开的微信接入协议，无需安装 OpenClaw 或配置公网服务器。

项目地址：[GitHub](https://github.com/Mickeylit/wechat-agent-bridge) · [GitLab 镜像](https://gz-gitlab.vipthink.cn/wandou/wechat-agent-bridge)

## 在 Windows 安装技能

适用于原生 Windows 版 Codex 和 Claude Code。先安装 Git，在 PowerShell 中运行：

```powershell
git clone https://github.com/Mickeylit/wechat-agent-bridge.git
Set-Location -LiteralPath .\wechat-agent-bridge
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Target both
```

**技能安装不需要 Python、Node.js 或微信扫码。** 该命令只复制技能文件，不会安装 Codex／Claude Code 本体，也不会启动模型、启动服务或改变已有微信绑定。执行策略参数只对这次 PowerShell 进程生效。

| 安装目标 | 默认位置 |
| --- | --- |
| Codex | `%USERPROFILE%\.agents\skills\wechat-agent-bridge` |
| Claude Code | `%USERPROFILE%\.claude\skills\wechat-agent-bridge` |

只安装到一个工具，将 `-Target both` 改成 `-Target codex` 或 `-Target claude`。支持 Windows PowerShell 5.1；路径有空格或中文时保持引号即可。

安装后，新开对应工具的聊天，在**聊天输入框**输入：

```text
Codex：
$wechat-agent-bridge 帮我把微信接入 Codex

Claude Code：
/wechat-agent-bridge 帮我把微信接入 Claude Code
```

也可以直接说“使用 wechat-agent-bridge 技能帮我接入微信”。安装在哪个工具、由哪个 CLI 回答微信消息，可以分别选择。

若工具运行在 **WSL**，请在 WSL 中按下面的 Linux 方法安装。Windows 用户目录和 WSL 用户目录互相独立。旧版 Codex 的技能目录、自定义位置及更多说明见 [Windows 使用指南](references/windows.md)。

## 在 macOS / Linux 安装技能

准备 Git 和 Python 3，在终端运行：

```sh
git clone https://github.com/Mickeylit/wechat-agent-bridge.git
cd wechat-agent-bridge
python3 scripts/install.py --target both
```

默认分别安装到 `~/.agents/skills/wechat-agent-bridge` 和 `~/.claude/skills/wechat-agent-bridge`。只安装一个工具时使用 `--target codex` 或 `--target claude`。安装后的聊天调用方式与上面相同。

## 真正连接微信

可以直接让已安装技能的助手完成以下步骤，也可以手动执行。

运行桥接程序需要：

- **Node.js 24 或更高版本**：[官方下载](https://nodejs.org/en/download)。
- **已安装并正常登录的 Codex CLI 或 Claude Code**：[Codex 安装说明](https://developers.openai.com/codex/cli/)、[Codex 登录说明](https://developers.openai.com/codex/auth/)、[Claude Code 安装与登录说明](https://code.claude.com/docs/en/setup)。
- 一台保持开机、联网且不休眠的电脑，以及用于扫码的手机微信。

Claude Code 至少需要 2.1.259，并具备本项目使用的全部命令参数；以 `doctor` 的检查结果为准。Windows 上 Claude Code 的 Git Bash 等依赖按其官方指南准备。请在本机完成正常登录，无需把账户密钥或凭据文件发给助手。

如果已经有微信桥接服务运行，先检查并复用现有部署。一个微信用户只能绑定一个实例，绑定另一个实例或手动解除连接会使旧凭证失效。[切换回答后端和重新绑定步骤](references/operations.md#change-the-answering-backend)中说明了如何保留状态和处理未完成的回复。

### Windows 手动接入

在克隆的仓库目录中运行。下面选择 Codex；需要 Claude Code 时，把 `-Engine codex` 改为 `-Engine claude`。

```powershell
$runtimePath = Join-Path $env:LOCALAPPDATA 'WeChatAgentBridge'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\prepare-windows.ps1 -Destination $runtimePath -Engine codex
Set-Location -LiteralPath $runtimePath
npm.cmd ci --ignore-scripts --no-audit --no-fund
node cli.mjs doctor
node cli.mjs login --web --auto-start
```

运行目录必须是新目录或空目录，不能放在技能目录里面。已有内容不会被覆盖。`doctor` 检查 CLI 是否可用及参数是否兼容，不会调用模型，也不能保证账号额度和登录有效。

保持登录终端运行，在**电脑浏览器**打开输出的 `LOGIN_PAGE` 地址，用手机微信扫描页面二维码。页面会自动更新过期二维码；若手机显示数字验证码，在登录终端输入。手机无需打开 `127.0.0.1` 地址。

绑定完成后，程序创建当前用户的 Windows 计划任务，立即运行，并在该用户下次登录时自动启动。无需管理员密码，任务不以 SYSTEM 账号运行。如果组织禁止计划任务，可在登录完成后使用 `npm.cmd start` 前台运行。

### macOS / Linux 手动接入

在仓库目录中准备独立运行目录；选择 Claude Code 时使用 `--engine claude`。

```sh
mkdir -p "$HOME/.local/share"
python3 scripts/prepare.py --dest "$HOME/.local/share/wechat-agent-bridge" --engine codex
cd "$HOME/.local/share/wechat-agent-bridge"
npm ci --ignore-scripts --no-audit --no-fund
node cli.mjs doctor
```

macOS 运行以下命令，扫码后安装当前用户的登录后台服务：

```sh
node cli.mjs login --web --auto-start
```

Linux／WSL 使用前台运行方式，不带 `--auto-start`：

```sh
node cli.mjs login --web
npm start
```

扫码后，在微信中新出现的连接会话里发一个问题。确认收到回答，再发一个追问验证上下文。完成实际往返后，才算这台电脑的链路接通。

## 日常使用

直接发送文字即可提问，后续消息会继续当前对话。程序只处理**扫码绑定者本人**发来的私聊消息，其他发送者、群聊和机器人消息不会进入模型。

Claude Code 默认启用本地文件读取和搜索工具 `Read`、`Grep`、`Glob`，可以在微信里要求它阅读文件、搜索内容或查找文件名，无需每次再开启读取权限。请写出**运行桥接程序那台电脑上的绝对路径**，例如：

```text
Windows：读取 C:\Users\你的用户名\Documents\项目\README.md，概括启动步骤。
macOS：读取 /Users/你的用户名/Projects/demo/README.md，概括启动步骤。
搜索：在 /Users/你的用户名/Projects/demo 中查找名称含 config 的文件，并搜索端口配置。
```

路径不明确时，助手会询问文件位置。Claude 的命令执行、文件写入与编辑、Notebook 编辑和 MCP 工具保持禁用。

| 微信消息 | 作用 |
| --- | --- |
| `/new` 或 `/新对话` | 开始一段新对话 |
| `/status` 或 `/状态` | 查看服务与会话状态 |
| `/help` 或 `/帮助` | 查看使用帮助 |

在电脑的**运行目录**中管理服务：

```sh
node cli.mjs status
node cli.mjs stop-service
node cli.mjs install-service
```

后两条适用于 macOS 和原生 Windows。前台运行时使用 `Ctrl+C` 停止。关闭桌面聊天窗口不影响已安装的后台服务，但电脑休眠、断网或用户退出登录会影响运行。

## 更新技能

在仓库目录中先执行 `git pull --ff-only`，再按系统运行：

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Target both -Update
```

```sh
# macOS / Linux
python3 scripts/install.py --target both --update
```

安装器只更新能确认是本技能的目录，旧版本保存在技能搜索目录之外的 `.skill-backups` 中，并打印备份位置。**更新技能不会自动更新已部署的桥接程序。** 已有 Claude 服务要启用默认读取功能，按[现有 Claude 服务升级步骤](references/operations.md#update-an-existing-claude-runtime)停止服务、备份并仅替换运行目录的 `lib/claude.mjs`，通过 `doctor` 后重启。保留配置和 `.state`，无需重新扫码。

## 常见问题

| 现象 | 处理方法 |
| --- | --- |
| 安装后找不到技能 | 新开工具会话；确认安装到了实际使用的 Windows 或 WSL 用户目录。 |
| 扫码提示过期 | 保持登录进程运行，使用自动刷新的网页；不要重复扫描旧聊天截图。 |
| 出现 `-14` | 微信凭证已失效。停止服务后重新扫码，检查是否手动解绑或绑定了另一个实例。 |
| 找不到 CLI／参数不支持 | 运行 `node cli.mjs doctor`，按提示检查安装位置或升级 CLI。 |
| 微信收到问题但没有回答 | 在运行目录检查 `status` 和 `.state/service.log`，确认本机 CLI 登录、网络及额度。 |
| Claude 提示不能嵌套运行 | 从普通终端或后台服务启动桥接，不在已有 Claude 会话中嵌套启动。 |
| 电脑休眠后停止回复 | 保持电脑唤醒并联网；本程序运行在本机。 |

状态、待发消息和微信凭证存放在运行目录的 `.state` 中，**不要提交到 Git 或分享给他人**。同一状态目录只运行一个桥接进程。重新扫码前会归档旧绑定未完成的回复；需要重新发送被中断的问题。

## 支持范围与验证状态

当前支持扫码者本人私聊中的文字，以及微信接口已提供文字转写的语音。未实现群聊、图片／文件／视频理解、远程改文件、电脑操作、取消回答命令，也不会接管桌面上已有的聊天。

Codex 使用只读问答模式；Claude Code 默认支持问答及本地文件读取、内容搜索和文件名查找，禁用命令执行、写入、编辑及 MCP 工具。模型调用使用你本机 CLI 的账号及额度。本项目是自建桥接工具，微信账号能否接入以实际扫码结果为准。

- 已在 macOS 验证原始 Codex 桥接的真实微信收发与连续对话。
- 当前版本在 macOS 通过 **92 项 Node 测试和 25 项 Python 测试**；Windows 分支使用模拟测试。
- **尚未在真实 Windows 主机验证 PowerShell 安装、任务注册及微信往返；Claude Code 后端尚未完成真实模型与微信往返验证。** 这些能力需要在目标主机验收。

开发检查在仓库根目录运行：

```sh
python3 -m unittest discover -s scripts -p 'test_*.py'
cd assets/bridge
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

这些隔离测试不发送微信消息、不扫码、不消耗模型调用。

更多说明：[Windows 安装与运行](references/windows.md) · [配置、切换后端与恢复](references/operations.md) · [协议和开发说明](references/protocol.md) · [技能执行说明](SKILL.md)
