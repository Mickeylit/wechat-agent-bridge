import test from 'node:test';
import assert from 'node:assert/strict';
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
  return { status: 0, stdout: JSON.stringify({ ok: true, status }), stderr: '' };
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
    assert.match(script, /\.Principal\.UserId -ine \$bridgeUserSid/u);
    assert.ok(script.indexOf('Assert-BridgeTaskOwner $candidate') < script.indexOf('Disable-ScheduledTask'));
    assert.match(script, /Get-ScheduledTask -TaskName \$bridgeTaskName -TaskPath \$bridgeTaskPath -ErrorAction Stop/u);
    assert.doesNotMatch(script, /-like|-match/u);
  }
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
