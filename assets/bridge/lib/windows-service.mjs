import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Task Scheduler documentation:
// https://learn.microsoft.com/powershell/module/scheduledtasks/new-scheduledtaskprincipal
// https://learn.microsoft.com/powershell/module/scheduledtasks/new-scheduledtasksettingsset
// https://learn.microsoft.com/powershell/module/scheduledtasks/register-scheduledtask
// https://learn.microsoft.com/cpp/c-language/parsing-c-command-line-arguments

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function absoluteWindowsPath(value, label) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f"<>|?*]/u.test(value)) {
    throw failure('WINDOWS_SERVICE_CONFIG', `${label}必须是有效的 Windows 绝对路径。`);
  }
  const normalized = path.win32.normalize(value);
  if (!/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/u.test(normalized) ||
      normalized.slice(/^[A-Za-z]:/u.test(normalized) ? 2 : 0).includes(':')) {
    throw failure('WINDOWS_SERVICE_CONFIG', `${label}必须是有效的 Windows 绝对路径。`);
  }
  return normalized;
}

/** PowerShell single-quoted literals do not expand $, backticks or subexpressions. */
export function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Quote one native Windows argv value using the CRT backslash/quote rules. */
export function quoteWindowsArgument(value) {
  return `"${String(value)
    .replace(/(\\*)"/gu, (_match, backslashes) => `${'\\'.repeat(backslashes.length * 2 + 1)}"`)
    .replace(/\\+$/u, backslashes => backslashes + backslashes)}"`;
}

export function resolvePowerShellPath(env = process.env) {
  const key = Object.keys(env).find(name => name.toLowerCase() === 'systemroot');
  const systemRoot = absoluteWindowsPath(key ? env[key] : 'C:\\Windows', 'SystemRoot');
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function serviceOptions({ action, root, stateDir, label, nodePath }) {
  if (action !== 'install' && action !== 'stop') {
    throw failure('WINDOWS_SERVICE_CONFIG', 'Windows 服务操作必须是 install 或 stop。');
  }
  if (typeof label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(label)) {
    throw failure('WINDOWS_SERVICE_CONFIG', 'Windows 计划任务名称无效。');
  }
  const runtimeRoot = absoluteWindowsPath(root, '运行目录');
  const privateStateDir = absoluteWindowsPath(stateDir, '状态目录');
  const executable = absoluteWindowsPath(nodePath, 'Node 路径');
  if (!/\.exe$/iu.test(executable)) {
    throw failure('WINDOWS_SERVICE_CONFIG', 'Windows 后台服务需要 Node 的 .exe 绝对路径。');
  }
  const cliPath = path.win32.join(runtimeRoot, 'cli.mjs');
  return {
    action,
    taskName: label,
    root: runtimeRoot,
    nodePath: executable,
    arguments: `${quoteWindowsArgument(cliPath)} service-run --state-dir ${quoteWindowsArgument(privateStateDir)}`,
  };
}

/** Build only: callers can inspect this script without registering any task. */
export function buildWindowsServiceScript(options) {
  const config = serviceOptions(options);
  return `# No prompts, secrets, or model messages are included in this script.
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:bridgeStage = 'query'
$bridgeTaskName = ${powerShellLiteral(config.taskName)}
$bridgeTaskPath = '\\'
$bridgeRoot = ${powerShellLiteral(config.root)}
$bridgeNode = ${powerShellLiteral(config.nodePath)}
$bridgeArguments = ${powerShellLiteral(config.arguments)}

function Get-BridgeTask {
  try {
    return Get-ScheduledTask -TaskName $bridgeTaskName -TaskPath $bridgeTaskPath -ErrorAction Stop
  } catch {
    if ($_.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound -and
        $_.FullyQualifiedErrorId.StartsWith('CmdletizationQuery_NotFound', [StringComparison]::Ordinal)) {
      return $null
    }
    throw
  }
}

function Assert-BridgeTaskOwner($candidate) {
  $script:bridgeStage = 'ownership'
  $bridgeActions = @($candidate.Actions)
  if ($bridgeActions.Count -ne 1 -or
      $bridgeActions[0].Execute -ine $bridgeNode -or
      $bridgeActions[0].Arguments -cne $bridgeArguments -or
      $bridgeActions[0].WorkingDirectory -ine $bridgeRoot -or
      ($candidate.Principal.UserId -ine $bridgeUserSid -and $candidate.Principal.UserId -ine $bridgeUserName)) {
    throw 'Task ownership mismatch'
  }
}

function Stop-BridgeTask($candidate) {
  Assert-BridgeTaskOwner $candidate
  $script:bridgeStage = 'stop'
  Disable-ScheduledTask -TaskName $bridgeTaskName -TaskPath $bridgeTaskPath -ErrorAction Stop | Out-Null
  if ([string]$candidate.State -eq 'Running' -or [string]$candidate.State -eq 'Queued') {
    Stop-ScheduledTask -TaskName $bridgeTaskName -TaskPath $bridgeTaskPath -ErrorAction Stop | Out-Null
  }
  for ($bridgeAttempt = 0; $bridgeAttempt -lt 20; $bridgeAttempt++) {
    $script:bridgeStage = 'query'
    $bridgeCurrent = Get-BridgeTask
    if ($null -eq $bridgeCurrent) { return }
    Assert-BridgeTaskOwner $bridgeCurrent
    if ([string]$bridgeCurrent.State -ne 'Running' -and [string]$bridgeCurrent.State -ne 'Queued') { return }
    Start-Sleep -Milliseconds 250
  }
  $script:bridgeStage = 'stop'
  throw 'Task did not stop'
}

try {
  $script:bridgeStage = 'identity'
  $bridgeIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $bridgeUserSid = $bridgeIdentity.User.Value
  $bridgeUserName = $bridgeIdentity.Name
  if ($bridgeIdentity.IsSystem -or $bridgeUserSid -in @('S-1-5-18', 'S-1-5-19', 'S-1-5-20')) {
    throw 'An ordinary signed-in user is required'
  }
  $script:bridgeStage = 'query'
  $bridgeExisting = Get-BridgeTask
  if ($null -ne $bridgeExisting) { Assert-BridgeTaskOwner $bridgeExisting }
${config.action === 'stop' ? `  if ($null -eq $bridgeExisting) {
    Write-Output '{"ok":true,"status":"absent"}'
    exit 0
  }
  Stop-BridgeTask $bridgeExisting
  $script:bridgeStage = 'query'
  $bridgeExisting = Get-BridgeTask
  if ($null -ne $bridgeExisting) {
    Assert-BridgeTaskOwner $bridgeExisting
    $script:bridgeStage = 'unregister'
    Unregister-ScheduledTask -TaskName $bridgeTaskName -TaskPath $bridgeTaskPath -Confirm:$false -ErrorAction Stop | Out-Null
  }
  Write-Output '{"ok":true,"status":"stopped"}'` : `  if ($null -ne $bridgeExisting) { Stop-BridgeTask $bridgeExisting }
  $script:bridgeStage = 'configure'
  $bridgeAction = New-ScheduledTaskAction -Execute $bridgeNode -Argument $bridgeArguments -WorkingDirectory $bridgeRoot
  $bridgePrincipal = New-ScheduledTaskPrincipal -UserId $bridgeUserSid -LogonType Interactive -RunLevel Limited
  $bridgeTrigger = New-ScheduledTaskTrigger -AtLogOn -User $bridgeUserSid
  $bridgeSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $script:bridgeStage = 'query'
  $bridgeExisting = Get-BridgeTask
  if ($null -ne $bridgeExisting) {
    Assert-BridgeTaskOwner $bridgeExisting
    $script:bridgeStage = 'register'
    Register-ScheduledTask -TaskName $bridgeTaskName -TaskPath $bridgeTaskPath -Action $bridgeAction -Principal $bridgePrincipal -Trigger $bridgeTrigger -Settings $bridgeSettings -Description 'Local WeChat agent bridge' -Force -ErrorAction Stop | Out-Null
  } else {
    $script:bridgeStage = 'register'
    Register-ScheduledTask -TaskName $bridgeTaskName -TaskPath $bridgeTaskPath -Action $bridgeAction -Principal $bridgePrincipal -Trigger $bridgeTrigger -Settings $bridgeSettings -Description 'Local WeChat agent bridge' -ErrorAction Stop | Out-Null
  }
  $script:bridgeStage = 'start'
  Start-ScheduledTask -TaskName $bridgeTaskName -TaskPath $bridgeTaskPath -ErrorAction Stop
  Write-Output '{"ok":true,"status":"installed"}'`}
  exit 0
} catch {
  # Emit only a fixed phase; exception messages may contain paths or account data.
  Write-Output ('{"ok":false,"stage":"' + $script:bridgeStage + '"}')
  exit 1
}
`;
}

export function buildWindowsServiceCommand(options, env = process.env) {
  const script = buildWindowsServiceScript(options);
  return {
    executable: resolvePowerShellPath(env),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}

const STAGE_ERRORS = {
  identity: ['WINDOWS_SERVICE_IDENTITY', '请使用当前已登录的普通 Windows 用户安装服务，不要使用系统服务账号。'],
  query: ['WINDOWS_SERVICE_QUERY_FAILED', '无法读取 Windows 计划任务，请检查任务计划程序服务和当前用户权限。'],
  ownership: ['WINDOWS_SERVICE_OWNERSHIP', '同名 Windows 计划任务不属于此运行目录或用户，已拒绝修改。'],
  configure: ['WINDOWS_SERVICE_CONFIGURE_FAILED', '无法配置 Windows 计划任务，请检查系统是否提供 ScheduledTasks PowerShell 模块。'],
  register: ['WINDOWS_SERVICE_REGISTER_FAILED', '无法注册 Windows 登录任务，请检查当前用户的任务计划权限；可改用前台运行。'],
  start: ['WINDOWS_SERVICE_START_FAILED', 'Windows 任务已注册但未能启动，请检查任务状态和本地服务日志。'],
  stop: ['WINDOWS_SERVICE_STOP_FAILED', 'Windows 任务未能停止，未声明服务已停止；请检查任务计划程序。'],
  unregister: ['WINDOWS_SERVICE_UNREGISTER_FAILED', 'Windows 任务已停用但未能删除，请检查任务计划程序。'],
};

/** Register or remove only this deployment's task. Never requests elevation/passwords. */
export function windowsService({ action, root, stateDir, label, nodePath, binary, engine, env = process.env, run = spawnSync }) {
  // binary/engine are stored by the caller in private service-config.json, never
  // in the task's command line. Only service-run may load those settings.
  void binary;
  void engine;
  const options = { action, root, stateDir, label, nodePath };
  const command = buildWindowsServiceCommand(options, env);
  let result;
  try {
    result = run(command.executable, command.args, {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      env,
      timeout: 45_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw failure('WINDOWS_POWERSHELL_UNAVAILABLE', '无法启动 Windows PowerShell 5.1，请检查系统组件是否可用。');
  }
  if (result?.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw failure('WINDOWS_SERVICE_TIMEOUT', 'Windows 服务操作超时，请先检查任务实际状态再重试。');
    }
    throw failure('WINDOWS_POWERSHELL_UNAVAILABLE', '无法启动 Windows PowerShell 5.1，请检查系统组件是否可用。');
  }
  let response;
  try { response = JSON.parse(String(result?.stdout || '').replace(/^\uFEFF/u, '').trim()); }
  catch { /* Do not forward PowerShell stderr or unexpected output. */ }
  if (response?.ok === false && Object.hasOwn(STAGE_ERRORS, response.stage)) {
    throw failure(...STAGE_ERRORS[response.stage]);
  }
  const expected = action === 'install' ? ['installed'] : ['stopped', 'absent'];
  if (result?.status !== 0 || response?.ok !== true || !expected.includes(response.status)) {
    throw failure('WINDOWS_SERVICE_FAILED', 'Windows 服务操作未确认成功，请检查任务实际状态；未输出原始系统错误。');
  }
  return { taskName: label, action, status: response.status };
}
