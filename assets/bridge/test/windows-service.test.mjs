import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  buildWindowsServiceCommand,
  buildWindowsServiceScript,
  powerShellLiteral,
  quoteWindowsArgument,
  resolvePowerShellPath,
  windowsService,
} from '../lib/windows-service.mjs';

const BASE = {
  action: 'install',
  root: 'C:\\Users\\Mickey\\Agent Bridge',
  stateDir: 'D:\\Private State\\微信',
  label: 'local.wechat-agent-bridge.abcdef1234',
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  binary: 'C:\\Tools\\codex.exe',
  engine: 'codex',
};

function response(status = 'installed') {
  return { status: 0, stdout: JSON.stringify({ ok: true, status, ...(status === 'installed' ? { ready: true } : {}) }), stderr: '' };
}

test('PowerShell and native Windows quoting preserve spaces, unicode and literal metacharacters', () => {
  assert.equal(powerShellLiteral("C:\\O'Brien\\$name`$(cmd)"), "'C:\\O''Brien\\$name`$(cmd)'");
  assert.equal(quoteWindowsArgument('C:\\path with space\\'), '"C:\\path with space\\\\"');
  assert.equal(quoteWindowsArgument('a\\"b'), '"a\\\\\\"b"');
  assert.equal(quoteWindowsArgument('微信'), '"微信"');
  const command = buildWindowsServiceCommand({ ...BASE, root: "C:\\O'Brien\\$name`$(cmd)" }, { SystemRoot: 'D:\\Windows' });
  assert.equal(command.executable, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(command.args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(command.args.at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes("$bridgeRoot = 'C:\\O''Brien\\$name`$(cmd)'"));
  assert.ok(script.includes('service-run --state-dir "D:\\Private State\\微信"'));
  assert.ok(!script.includes(BASE.binary));
});

test('installation uses current interactive user with limited privileges and persistent settings', () => {
  const script = buildWindowsServiceScript(BASE);
  assert.match(script, /WindowsIdentity\]::GetCurrent\(\)/u);
  assert.match(script, /New-ScheduledTaskPrincipal -UserId \$bridgeUserSid -LogonType Interactive -RunLevel Limited/u);
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn -User \$bridgeUserSid/u);
  assert.match(script, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/u);
  assert.match(script, /-MultipleInstances IgnoreNew/u);
  assert.match(script, /-RestartCount 3 -RestartInterval \(New-TimeSpan -Minutes 1\)/u);
  assert.match(script, /-WorkingDirectory \$bridgeRoot/u);
  assert.match(script, /Start-ScheduledTask -TaskName \$bridgeTaskName -TaskPath \$bridgeTaskPath/u);
  assert.doesNotMatch(script, /-RunLevel Highest|-Password|-Verb RunAs|-LogonType ServiceAccount/u);
});

test('exact task action, executable, working directory and user are validated before any mutation', () => {
  for (const action of ['install', 'stop']) {
    const script = buildWindowsServiceScript({ ...BASE, action });
    assert.match(script, /\$bridgeActions\.Count -ne 1/u);
    assert.match(script, /\.Execute -ine \$bridgeNode/u);
    assert.match(script, /\.Arguments -cne \$bridgeArguments/u);
    assert.match(script, /\.WorkingDirectory -ine \$bridgeRoot/u);
    assert.match(script, /Resolve-BridgeUserSid \$candidate\.Principal\.UserId\) -cne \$bridgeUserSid/u);
    assert.match(script, /NTAccount\]::new\(\$userId\)\)\.Translate\(\[Security\.Principal\.SecurityIdentifier\]\)/u);
    assert.doesNotMatch(script, /Principal\.UserId -ine|bridgeUserName|Split\(/u);
    assert.ok(script.indexOf('Assert-BridgeTaskOwner $candidate') < script.indexOf('Disable-ScheduledTask'));
    assert.match(script, /Get-ScheduledTask -TaskName \$bridgeTaskName -TaskPath \$bridgeTaskPath -ErrorAction Stop/u);
    assert.doesNotMatch(script, /-like|-match/u);
  }
});

test('install checks runtime access and waits for a new live worker instead of accepting task registration alone', () => {
  const script = buildWindowsServiceScript(BASE);
  assert.ok(script.indexOf('  Assert-BridgeRuntimeAccess\n') < script.indexOf("  $script:bridgeStage = 'configure'"));
  assert.match(script, /service-config\.json/u);
  assert.match(script, /\[IO\.FileMode\]::CreateNew/u);
  assert.match(script, /\$bridgeRuntime\.runId -cne \$previousRunId/u);
  assert.match(script, /\$bridgeRuntime\.pid -eq \$bridgeLock\.pid/u);
  assert.match(script, /Get-Process -Id \$bridgeRuntime\.pid/u);
  assert.match(script, /\$bridgeReadySamples -ge 5/u);
  assert.ok(script.indexOf('  Wait-BridgeTaskReady $bridgePreviousRunId') < script.indexOf('"status":"installed","ready":true'));
  assert.throws(() => windowsService({ ...BASE, run: () => ({ status: 0, stdout: '{"ok":true,"status":"installed"}' }) }), {
    code: 'WINDOWS_SERVICE_FAILED',
  });
});

test('stop disables, stops, waits and unregisters only the exact named owned task', () => {
  const script = buildWindowsServiceScript({ ...BASE, action: 'stop' });
  assert.match(script, /if \(\$null -eq \$bridgeExisting\) \{\s+Write-Output '\{"ok":true,"status":"absent"\}'\s+exit 0/u);
  assert.ok(script.indexOf('Disable-ScheduledTask') < script.indexOf('Stop-ScheduledTask'));
  assert.ok(script.indexOf('Stop-BridgeTask $bridgeExisting') < script.indexOf('Unregister-ScheduledTask'));
  assert.match(script, /Unregister-ScheduledTask -TaskName \$bridgeTaskName -TaskPath \$bridgeTaskPath -Confirm:\$false -ErrorAction Stop/u);
  assert.match(script, /\$bridgeAttempt -lt 20/u);
  assert.doesNotMatch(script, /Register-ScheduledTask -TaskName|Start-ScheduledTask -TaskName/u);
});

test('PowerShell missing-task handling does not hide permission or provider errors', () => {
  const script = buildWindowsServiceScript(BASE);
  assert.match(script, /CategoryInfo\.Category -eq \[System.Management.Automation.ErrorCategory\]::ObjectNotFound/u);
  assert.match(script, /FullyQualifiedErrorId\.StartsWith\('CmdletizationQuery_NotFound'/u);
  assert.doesNotMatch(script, /Get-ScheduledTask[^\n]*SilentlyContinue/u);
  assert.match(script, /return \$null\s+\}\s+throw/u);
});

test('runner is hidden without a shell, reports installed status, and does not expose model arguments', () => {
  const env = { SystemRoot: 'C:\\Windows', PRIVATE_TOKEN: 'do-not-print' };
  const calls = [];
  const value = windowsService({ ...BASE, env, run: (...args) => { calls.push(args); return response(); } });
  assert.deepEqual(value, { taskName: BASE.label, action: 'install', status: 'installed' });
  assert.equal(calls.length, 1);
  const [executable, args, options] = calls[0];
  assert.equal(executable, resolvePowerShellPath(env));
  assert.equal(options.windowsHide, true);
  assert.equal(options.shell, false);
  assert.equal(options.env, env);
  assert.equal(options.timeout, 45_000);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.doesNotMatch(script, /do-not-print|PRIVATE_TOKEN/u);
});

test('stop is idempotent and requires successful exit plus the matching controlled status', () => {
  for (const status of ['stopped', 'absent']) {
    assert.deepEqual(windowsService({ ...BASE, action: 'stop', run: () => response(status) }), {
      taskName: BASE.label, action: 'stop', status,
    });
  }
  for (const result of [
    { ...response('stopped'), status: 1 },
    { ...response('stopped'), status: null, signal: 'SIGTERM' },
    response('installed'),
    { status: 0, stdout: 'secret-system-output', stderr: 'secret-error' },
  ]) {
    assert.throws(() => windowsService({ ...BASE, action: 'stop', run: () => result }), error => {
      assert.equal(error.code, 'WINDOWS_SERVICE_FAILED');
      assert.doesNotMatch(String(error), /secret/u);
      return true;
    });
  }
});

test('controlled failures preserve operation phase while redacting system output', () => {
  const stages = {
    ownership: 'WINDOWS_SERVICE_OWNERSHIP', query: 'WINDOWS_SERVICE_QUERY_FAILED',
    identity: 'WINDOWS_SERVICE_IDENTITY', configure: 'WINDOWS_SERVICE_CONFIGURE_FAILED',
    register: 'WINDOWS_SERVICE_REGISTER_FAILED', start: 'WINDOWS_SERVICE_START_FAILED',
    stop: 'WINDOWS_SERVICE_STOP_FAILED', unregister: 'WINDOWS_SERVICE_UNREGISTER_FAILED',
    access: 'WINDOWS_SERVICE_ACCESS_FAILED', ready: 'WINDOWS_SERVICE_NOT_READY',
  };
  for (const [stage, code] of Object.entries(stages)) {
    assert.throws(() => windowsService({ ...BASE, run: () => ({
      status: 1, stdout: JSON.stringify({ ok: false, stage }), stderr: 'secret-credential',
    }) }), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(String(error), /secret/u);
      return true;
    });
  }
});

test('startup failures retain a safe scheduler result with a concrete path/permission diagnosis', () => {
  assert.throws(() => windowsService({ ...BASE, run: () => ({
    status: 1, stdout: JSON.stringify({ ok: false, stage: 'ready', taskResult: 0x8007010b }), stderr: 'private error',
  }) }), error => {
    assert.equal(error.code, 'WINDOWS_SERVICE_NOT_READY');
    assert.match(error.message, /0x8007010b/u);
    assert.match(error.message, /运行目录无效或不可访问/u);
    assert.doesNotMatch(error.message, /private/u);
    return true;
  });
  for (const taskResult of ['secret', -1, 0x100000000, 1.5]) {
    assert.throws(() => windowsService({ ...BASE, run: () => ({
      status: 1, stdout: JSON.stringify({ ok: false, stage: 'ready', taskResult }),
    }) }), error => error.code === 'WINDOWS_SERVICE_NOT_READY' && !/任务结果|secret/.test(error.message));
  }
});

function runNativeHarness(body) {
  const script = buildWindowsServiceScript(BASE);
  const functions = script.slice(script.indexOf('function Resolve-BridgeUserSid'), script.indexOf('function Stop-BridgeTask'));
  const harness = `$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$script:bridgeStage = 'test'
$script:bridgeTaskResult = $null
$bridgeIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$bridgeUserSid = $bridgeIdentity.User.Value
$bridgeNode = 'node.exe'
$bridgeArguments = 'owned arguments'
$bridgeRoot = 'owned root'
$bridgeTaskName = 'owned task'
$bridgeTaskPath = '\\'
${functions}
${body}`;
  const result = spawnSync(resolvePowerShellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(harness, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000,
  });
  assert.equal(result.status, 0, 'Native PowerShell harness failed');
  return JSON.parse(result.stdout.replace(/^\uFEFF/u, '').trim());
}

test('native Windows resolves SID, full and short principals without accepting a different SID', { skip: process.platform !== 'win32' }, () => {
  const result = runNativeHarness(`
function Test-Principal($userId) {
  $candidate = [pscustomobject]@{ Actions = @([pscustomobject]@{ Execute = $bridgeNode; Arguments = $bridgeArguments; WorkingDirectory = $bridgeRoot }); Principal = [pscustomobject]@{ UserId = $userId } }
  try { Assert-BridgeTaskOwner $candidate; return $true } catch { return $false }
}
$shortName = $bridgeIdentity.Name.Split('\\')[-1]
$shortIsCurrent = $false
try { $shortIsCurrent = (Resolve-BridgeUserSid $shortName) -ceq $bridgeUserSid } catch {}
@{ sid = (Test-Principal $bridgeUserSid); full = (Test-Principal $bridgeIdentity.Name); short = (Test-Principal $shortName); shortIsCurrent = $shortIsCurrent; different = (Test-Principal 'S-1-5-32-545') } | ConvertTo-Json -Compress
`);
  assert.equal(result.sid, true);
  assert.equal(result.full, true);
  assert.equal(result.short, result.shortIsCurrent);
  assert.equal(result.different, false);
});

test('native Windows readiness rejects stale markers, dead workers and stopped tasks', { skip: process.platform !== 'win32' }, () => {
  const result = runNativeHarness(`
$bridgeStateDir = Join-Path $env:TEMP ('bridge-startup-test-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $bridgeStateDir
function Start-Sleep { param($Milliseconds) }
function Get-BridgeTask { return [pscustomobject]@{ State = $script:testTaskState; Actions = @([pscustomobject]@{ Execute = $bridgeNode; Arguments = $bridgeArguments; WorkingDirectory = $bridgeRoot }); Principal = [pscustomobject]@{ UserId = $bridgeUserSid } } }
function Get-ScheduledTaskInfo { param($TaskName, $TaskPath, $ErrorAction) return [pscustomobject]@{ LastTaskResult = 2147942667 } }
function Check-Ready($runId, $previousId, $taskState, $workerPid) {
  $script:testTaskState = $taskState
  @{ state = 'running'; runId = $runId; pid = $workerPid } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $bridgeStateDir 'runtime.json')
  @{ pid = $workerPid } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $bridgeStateDir 'bridge.lock')
  try { Wait-BridgeTaskReady $previousId; return $true } catch { return $false }
}
try {
  @{ fresh = (Check-Ready 'new' 'old' 'Running' $PID); stale = (Check-Ready 'same' 'same' 'Running' $PID); stopped = (Check-Ready 'new' 'old' 'Ready' $PID); dead = (Check-Ready 'new' 'old' 'Running' 2147483647) } | ConvertTo-Json -Compress
} finally { Remove-Item -LiteralPath $bridgeStateDir -Recurse -Force }
`);
  assert.deepEqual(result, { fresh: true, stale: false, stopped: false, dead: false });
});

test('process start failures and timeouts are controlled and never imply a completed stop', () => {
  for (const run of [
    () => { throw new Error('secret-native-error'); },
    () => ({ status: null, error: Object.assign(new Error('secret'), { code: 'ENOENT' }) }),
  ]) {
    assert.throws(() => windowsService({ ...BASE, action: 'stop', run }), { code: 'WINDOWS_POWERSHELL_UNAVAILABLE' });
  }
  assert.throws(() => windowsService({ ...BASE, run: () => ({
    status: null, error: Object.assign(new Error('secret'), { code: 'ETIMEDOUT' }),
  }) }), { code: 'WINDOWS_SERVICE_TIMEOUT' });
});

test('rejects relative paths, shell-shaped invalid paths and task wildcards before starting PowerShell', () => {
  for (const changed of [
    { root: 'relative\\runtime' }, { root: '\\root-relative' }, { stateDir: 'D:drive-relative' },
    { nodePath: 'node' }, { nodePath: 'C:\\Tools\\node.cmd' }, { root: 'C:\\bad"path' },
    { root: 'C:\\bad\npath' }, { stateDir: 'C:\\state:stream' },
    { label: 'wildcard*' }, { label: 'folder\\name' }, { action: 'delete-everything' },
  ]) {
    let called = false;
    assert.throws(() => windowsService({ ...BASE, ...changed, run: () => { called = true; return response(); } }), {
      code: 'WINDOWS_SERVICE_CONFIG',
    });
    assert.equal(called, false);
  }
  assert.equal(resolvePowerShellPath({ systemroot: 'D:/Windows' }), 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});
