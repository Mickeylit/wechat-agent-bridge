import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson, writeJson, isAlive } from './store.mjs';

function psString(value) { return `'${String(value).replaceAll("'", "''")}'`; }
export function powershellPath(env = process.env) {
  const systemRoot = Object.entries(env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
  if (!systemRoot) throw new Error('Windows SystemRoot 未设置，无法定位系统 PowerShell。');
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function privateStateScript(stateDir) {
  // A Windows mode of 0600 is not an ACL. Set a protected DACL before credentials
  // are written; descendants inherit only the current user and SYSTEM grants.
  return `$ErrorActionPreference = 'Stop'
$target = ${psString(stateDir)}
$item = Get-Item -LiteralPath $target -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'State directory is a reparse point.' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagate = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, $propagate, $allow))
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, 'FullControl', $inherit, $propagate, $allow))
Set-Acl -LiteralPath $target -AclObject $acl
`;
}

export function secureStateDirectory(stateDir, { platform = process.platform, env = process.env, run = spawnSync } = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(stateDir).isSymbolicLink()) throw new Error('状态目录不能是符号链接。');
  if (platform !== 'win32') { fs.chmodSync(stateDir, 0o700); return; }
  const encoded = Buffer.from(privateStateScript(stateDir), 'utf16le').toString('base64');
  const result = run(powershellPath(env), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', timeout: 20000, windowsHide: true, shell: false,
  });
  if (result.error || result.status !== 0) throw new Error('无法设置 Windows 状态目录的私有权限。请使用当前用户可写的本地 NTFS 目录，然后重试。');
}

export function createStopMonitor(stateDir, controller, { intervalMs = 500 } = {}) {
  const runId = randomUUID();
  const file = path.join(stateDir, 'stop-request.json');
  const startedAt = new Date().toISOString();
  writeJson(path.join(stateDir, 'runtime.json'), { pid: process.pid, runId, startedAt, state: 'running' });
  const timer = setInterval(() => {
    try {
      if (readJson(file, null)?.runId === runId) {
        fs.rmSync(file, { force: true });
        controller.abort();
      }
    } catch { /* Incomplete requests must not stop a different process. */ }
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    const runtime = readJson(path.join(stateDir, 'runtime.json'), {});
    if (runtime.runId === runId) writeJson(path.join(stateDir, 'runtime.json'), { ...runtime, state: 'stopped', stoppedAt: new Date().toISOString() });
  };
}

export async function requestGracefulStop(stateDir, { timeoutMs = 20000, alive = isAlive } = {}) {
  const runtime = readJson(path.join(stateDir, 'runtime.json'), {});
  const activePid = readJson(path.join(stateDir, 'bridge.lock'), {}).pid;
  if (!activePid || !alive(activePid)) return;
  if (runtime.pid !== activePid || !runtime.runId) throw new Error('当前运行实例不支持安全停止，请先在它的原终端停止服务。');
  writeJson(path.join(stateDir, 'stop-request.json'), { runId: runtime.runId });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(activePid) || readJson(path.join(stateDir, 'bridge.lock'), {}).pid !== activePid) return;
    await delay(200);
  }
  throw new Error('等待服务正常停止超时；为避免遗留模型进程，尚未卸载任务。请检查 service.log 后重试。');
}

export function saveServiceConfig({ root, stateDir, label, engine, binary, nodePath = process.execPath }, env = process.env) {
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  const extraEnv = {};
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH']) if (env[key]) extraEnv[key] = env[key];
  const config = { root, stateDir, label, engine, binary, nodePath, pathValue, extraEnv };
  writeJson(path.join(stateDir, 'service-config.json'), config);
  return config;
}

export function serviceEnvironment(config, env = process.env) {
  // Windows environment names are case-insensitive; keep only one PATH key.
  const clean = { ...env };
  for (const key of Object.keys(clean)) if (key.toLowerCase() === 'path') delete clean[key];
  return { ...clean, ...config.extraEnv, PATH: config.pathValue, WECHAT_BRIDGE_STATE_DIR: config.stateDir,
    WECHAT_BRIDGE_ENGINE: config.engine, [config.engine === 'codex' ? 'CODEX_BIN' : 'CLAUDE_BIN']: config.binary };
}

export async function runServiceWorker({ root, stateDir, spawnImpl = spawn, env = process.env }) {
  const config = readJson(path.join(stateDir, 'service-config.json'), null);
  if (!config || path.resolve(config.root) !== path.resolve(root) || path.resolve(config.stateDir) !== path.resolve(stateDir) ||
      !['codex', 'claude'].includes(config.engine) || !path.isAbsolute(config.nodePath) || !path.isAbsolute(config.binary)) {
    throw new Error('后台运行配置缺失或不匹配，请重新执行 install-service。');
  }
  const startupFile = path.join(stateDir, 'service-startup.json');
  const startup = { attemptId: randomUUID(), supervisorPid: process.pid, startedAt: new Date().toISOString(), state: 'starting' };
  const record = update => writeJson(startupFile, { ...startup, ...update });
  record({});
  let fd;
  try {
    fd = fs.openSync(path.join(stateDir, 'service.log'), 'a', 0o600);
  } catch {
    record({ state: 'failed', stage: 'log' });
    throw new Error('无法写入后台服务日志，请检查状态目录的可用空间和当前用户写权限。');
  }
  const fail = (stage, error) => {
    // Only retain a finite diagnostic code, never arbitrary native error text.
    const errorCode = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENOSPC'].includes(error?.code) ? error.code : 'UNKNOWN';
    record({ state: 'failed', stage, errorCode });
    fs.writeSync(fd, `[${new Date().toISOString()}] WINDOWS_WORKER_START_FAILED stage=${stage} code=${errorCode}\n`);
  };
  try {
    if (!fs.statSync(root).isDirectory()) throw Object.assign(new Error(), { code: 'ENOTDIR' });
    fs.accessSync(path.join(root, 'cli.mjs'), fs.constants.R_OK);
    fs.accessSync(config.nodePath, fs.constants.R_OK);
    fs.accessSync(config.binary, fs.constants.R_OK);
  } catch (error) {
    try { fail('runtime-access', error); } finally { fs.closeSync(fd); }
    throw new Error('后台账号无法读取运行目录、CLI 或引擎程序，请检查 service-startup.json 和 service.log 后重新安装服务。');
  }
  return await new Promise((resolve, reject) => {
    let child;
    let failed = false;
    try {
      child = spawnImpl(config.nodePath, [path.join(root, 'cli.mjs'), 'start'], {
        cwd: root, env: serviceEnvironment(config, env), stdio: ['ignore', fd, fd], shell: false, windowsHide: true,
      });
    } catch (error) {
      try { fail('spawn', error); } finally { fs.closeSync(fd); }
      reject(new Error('无法启动后台桥接进程，请检查 service-startup.json 和 service.log。')); return;
    }
    // The scheduled task owns this supervisor; it stays alive until its worker exits.
    // Retain this descriptor through the error event so launch errors are logged too.
    child.once('error', error => {
      failed = true;
      try { fail('spawn', error); }
      catch { /* Preserve the controlled launch failure if diagnostics cannot be saved. */ }
      reject(new Error('无法启动后台桥接进程，请检查 service-startup.json 和 service.log。'));
    });
    child.once('close', code => {
      fs.closeSync(fd);
      if (failed) return;
      const exitCode = Number.isInteger(code) ? code : 1;
      try { record({ state: exitCode === 0 ? 'stopped' : 'failed', stage: 'worker', exitCode, stoppedAt: new Date().toISOString() }); }
      catch { reject(new Error('无法保存后台运行结果，请检查状态目录的可用空间和写权限。')); return; }
      resolve(exitCode);
    });
  });
}
