import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson, writeJson } from '../lib/store.mjs';
import { secureStateDirectory, createStopMonitor, requestGracefulStop, saveServiceConfig, serviceEnvironment, runServiceWorker } from '../lib/windows-runtime.mjs';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '微信 bridge '));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}

test('Windows private state uses protected ACL before writing credentials', t => {
  const dir = path.join(temp(t), "owner's & state");
  let invocation;
  secureStateDirectory(dir, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run: (command, args, options) => {
    invocation = { command, args, options }; return { status: 0 };
  } });
  assert.equal(invocation.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);
  const script = Buffer.from(invocation.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.ok(script.includes("owner''s & state"));
  assert.match(script, /WindowsIdentity.*GetCurrent/);
  assert.match(script, /S-1-5-18/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('ACL failure stops setup and suppresses raw PowerShell diagnostics', t => {
  const dir = temp(t);
  assert.throws(() => secureStateDirectory(dir, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
    run: () => ({ status: 1, stderr: 'secret data', stdout: 'private' }) }), error => /NTFS/.test(error.message) && !/secret|private/.test(error.message));
});

test('stop monitor ignores stale requests and only cancels its own generation', async t => {
  const dir = temp(t);
  const controller = new AbortController();
  const close = createStopMonitor(dir, controller, { intervalMs: 5 });
  t.after(close);
  const runtime = readJson(path.join(dir, 'runtime.json'));
  writeJson(path.join(dir, 'stop-request.json'), { runId: 'other-process' });
  await delay(20);
  assert.equal(controller.signal.aborted, false);
  writeJson(path.join(dir, 'stop-request.json'), { runId: runtime.runId });
  await delay(20);
  assert.equal(controller.signal.aborted, true);
  assert.equal(fs.existsSync(path.join(dir, 'stop-request.json')), false);
  close();
  assert.equal(readJson(path.join(dir, 'runtime.json')).state, 'stopped');
});

test('graceful stop waits for the owned bridge lock to be released', async t => {
  const dir = temp(t);
  const controller = new AbortController();
  const close = createStopMonitor(dir, controller, { intervalMs: 5 });
  t.after(close);
  writeJson(path.join(dir, 'bridge.lock'), { pid: process.pid });
  controller.signal.addEventListener('abort', () => fs.rmSync(path.join(dir, 'bridge.lock')));
  await requestGracefulStop(dir, { timeoutMs: 1000 });
  assert.equal(controller.signal.aborted, true);
});

test('unresponsive or unmatched process cannot be falsely reported stopped', async t => {
  const dir = temp(t);
  writeJson(path.join(dir, 'bridge.lock'), { pid: process.pid });
  await assert.rejects(requestGracefulStop(dir), /不支持安全停止/);
  writeJson(path.join(dir, 'runtime.json'), { pid: process.pid, runId: 'current' });
  await assert.rejects(requestGracefulStop(dir, { timeoutMs: 1 }), /停止超时/);
  assert.equal(fs.existsSync(path.join(dir, 'bridge.lock')), true);
});

test('scheduled worker persists paths but excludes authentication environment', async t => {
  const dir = temp(t);
  const config = saveServiceConfig({ root: dir, stateDir: dir, label: 'owned', engine: 'claude', binary: path.join(dir, 'claude.exe') }, {
    Path: 'saved-path', ANTHROPIC_API_KEY: 'secret', CODEX_HOME: '/custom/codex', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bash.exe',
  });
  assert.equal(JSON.stringify(readJson(path.join(dir, 'service-config.json'))).includes('secret'), false);
  const env = serviceEnvironment(config, { Path: 'old', PATH: 'duplicate', TEMP: 'tmp' });
  assert.equal(env.PATH, 'saved-path');
  assert.equal(Object.hasOwn(env, 'Path'), false);
  assert.equal(env.CLAUDE_BIN, path.join(dir, 'claude.exe'));
  let invocation;
  const code = await runServiceWorker({ root: dir, stateDir: dir, env: {}, spawnImpl: (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 0)); return child;
  } });
  assert.equal(code, 0);
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [path.join(dir, 'cli.mjs'), 'start']);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.stdio[1], invocation.options.stdio[2]);
});
