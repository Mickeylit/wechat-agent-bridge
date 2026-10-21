import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveBinary, selectEngine } from '../lib/config.mjs';
import { Store } from '../lib/store.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-config-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('defaults are portable command names and state stays under runtime root', (t) => {
  const root = fixture(t);
  const config = loadConfig(root, {});
  assert.equal(config.engine, 'codex');
  assert.equal(config.binary, 'codex');
  assert.equal(config.stateDir, path.join(root, '.state'));
  assert.equal(config.engineName, 'Codex');
  assert.match(config.label, /^local\.wechat-agent-bridge\.[a-f0-9]{10}$/);
});

test('resolves configured relative paths from runtime root and honors engine-specific env', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ engine: 'codex', binary: './bin/codex', stateDir: './saved' }));
  const fileConfig = loadConfig(root, {});
  assert.equal(fileConfig.binary, path.join(root, 'bin/codex'));
  assert.equal(fileConfig.stateDir, path.join(root, 'saved'));
  const overridden = loadConfig(root, {
    WECHAT_BRIDGE_ENGINE: 'claude', CLAUDE_BIN: './tools/claude', CODEX_BIN: '/not/claude', WECHAT_BRIDGE_STATE_DIR: './other-state',
  });
  assert.equal(overridden.engine, 'claude');
  assert.equal(overridden.binary, path.join(root, 'tools/claude'));
  assert.equal(overridden.stateDir, path.join(root, 'other-state'));
  assert.equal(overridden.engineName, 'Claude Code');
  assert.notEqual(fileConfig.label, overridden.label);
});

test('rejects unsupported engine values', (t) => {
  assert.throws(() => loadConfig(fixture(t), { WECHAT_BRIDGE_ENGINE: 'unknown' }), /codex 或 claude/);
});

test('locates executable through supplied PATH without assuming an installation directory', (t) => {
  const root = fixture(t);
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  const windows = process.platform === 'win32';
  const name = windows ? 'claude.exe' : 'claude';
  if (windows) fs.mkdirSync(path.join(first, name));
  else fs.writeFileSync(path.join(first, name), '#!/bin/sh\n', { mode: 0o600 });
  const executable = path.join(second, name);
  fs.writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 });
  const resolved = resolveBinary('claude', { PATH: [first, second].join(path.delimiter) });
  assert.equal(windows ? resolved.toLowerCase() : resolved, windows ? executable.toLowerCase() : executable);
  assert.equal(resolveBinary(executable, { PATH: '' }), executable);
  assert.throws(() => resolveBinary('codex', { PATH: first }), /找不到 codex/);
  assert.throws(() => resolveBinary(second, { PATH: '' }), /找不到/);
});

test('selecting the same backend preserves its conversation and queued jobs', (t) => {
  const store = new Store(fixture(t));
  store.data.engine = 'codex';
  store.data.threadId = 'codex-thread';
  store.data.jobs = [{ id: 'queued' }];
  store.save();
  selectEngine(store, 'codex');
  const persisted = new Store(store.dir).data;
  assert.equal(persisted.engine, 'codex');
  assert.equal(persisted.threadId, 'codex-thread');
  assert.deepEqual(persisted.jobs, [{ id: 'queued' }]);
});

test('changing backend clears and persists the previous backend conversation', (t) => {
  const store = new Store(fixture(t));
  store.data.engine = 'codex';
  store.data.threadId = 'codex-thread';
  store.save();
  selectEngine(store, 'claude');
  const persisted = new Store(store.dir).data;
  assert.equal(persisted.engine, 'claude');
  assert.equal(persisted.threadId, null);
});

test('changing backend with queued messages rejects without mutating memory or disk', (t) => {
  const store = new Store(fixture(t));
  store.data.engine = 'claude';
  store.data.threadId = 'claude-session';
  store.data.jobs = [{ id: 'queued', parts: [{ text: 'saved answer' }] }];
  store.save();
  const previous = structuredClone(store.data);
  assert.throws(() => selectEngine(store, 'codex'), /有未完成的消息/);
  assert.deepEqual(store.data, previous);
  assert.deepEqual(new Store(store.dir).data, previous);
});

test('legacy unlabelled Codex conversations are cleared when migrating to Claude', (t) => {
  const store = new Store(fixture(t));
  store.data.threadId = 'legacy-codex-thread';
  store.save();
  selectEngine(store, 'claude');
  assert.equal(store.data.engine, 'claude');
  assert.equal(store.data.threadId, null);
  assert.equal(new Store(store.dir).data.threadId, null);
});

test('legacy Codex state with pending replies cannot switch to Claude', (t) => {
  const store = new Store(fixture(t));
  store.data.threadId = 'legacy-codex-thread';
  store.data.jobs = [{ id: 'legacy-pending' }];
  store.save();
  assert.throws(() => selectEngine(store, 'claude'), /有未完成的消息/);
  assert.equal(store.data.threadId, 'legacy-codex-thread');
  assert.equal(store.data.engine, undefined);
  assert.equal(new Store(store.dir).data.jobs.length, 1);
});

function windowsFs(fileNames) {
  const files = new Set(fileNames.map(file => path.win32.normalize(file).toLowerCase()));
  const check = file => {
    if (!files.has(path.win32.normalize(file).toLowerCase())) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
  };
  return { accessSync: check, statSync(file) { check(file); return { isFile: () => true }; } };
}

test('Windows resolves case-insensitive PATH/PATHEXT keys in configured extension priority', () => {
  const directory = String.raw`C:\Users\小明\CLI Tools`;
  const options = { platform: 'win32', fs: windowsFs([
    path.win32.join(directory, 'codex'), path.win32.join(directory, 'codex.EXE'), path.win32.join(directory, 'codex.CMD'),
  ]) };
  const env = { pAtH: `"${directory}"`, pAtHeXt: '.cmd;.exe;.ps1' };
  assert.equal(resolveBinary('codex', env, options), path.win32.join(directory, 'codex.CMD'));
  assert.equal(resolveBinary('codex', { ...env, pAtHeXt: '.exe;.cmd' }, options), path.win32.join(directory, 'codex.EXE'));
});

test('Windows PATH directory order wins and unsupported PATHEXT entries are never executed', () => {
  const first = String.raw`C:\first`;
  const second = String.raw`C:\second`;
  const options = { platform: 'win32', fs: windowsFs([
    `${first}\\claude.CMD`, `${first}\\claude.PS1`, `${second}\\claude.EXE`,
  ]) };
  const env = { Path: `${first};${second}`, PATHEXT: '.PS1;.EXE;.CMD;.JS' };
  assert.equal(resolveBinary('claude', env, options), `${first}\\claude.CMD`);
  assert.throws(() => resolveBinary('claude.ps1', env, options), /找不到/);
  assert.throws(() => resolveBinary('claude', { Path: first, PATHEXT: '.PS1;.JS' }, options), /找不到/);
});

test('Windows explicit and relative paths accept both separators and default executable extensions', () => {
  const binary = String.raw`C:\项目\工具\codex.EXE`;
  const options = { platform: 'win32', cwd: String.raw`C:\项目`, fs: windowsFs([binary]) };
  assert.equal(resolveBinary('C:/项目/工具/codex.exe', {}, options), String.raw`C:\项目\工具\codex.exe`);
  assert.equal(resolveBinary('.\\工具\\codex', {}, options), binary);
  assert.equal(resolveBinary('./工具/codex', {}, options), binary);
});
