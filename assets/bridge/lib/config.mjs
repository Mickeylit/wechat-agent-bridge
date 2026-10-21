import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readJson } from './store.mjs';

export function loadConfig(root, env = process.env, options = {}) {
  const paths = (options.platform || process.platform) === 'win32' ? path.win32 : path;
  const raw = readJson(path.join(root, 'bridge.config.json'), {});
  const engine = env.WECHAT_BRIDGE_ENGINE || raw.engine || 'codex';
  if (!['codex', 'claude'].includes(engine)) throw new Error('engine 必须为 codex 或 claude。');
  const stateDir = paths.resolve(root, env.WECHAT_BRIDGE_STATE_DIR || raw.stateDir || '.state');
  const configuredBin = env[engine === 'codex' ? 'CODEX_BIN' : 'CLAUDE_BIN'] || raw.binary;
  const binary = configuredBin && /[\\/]/.test(configuredBin) ? paths.resolve(root, configuredBin) : configuredBin || engine;
  const label = `local.wechat-agent-bridge.${createHash('sha256').update(stateDir).digest('hex').slice(0, 10)}`;
  return { engine, binary, stateDir, label, engineName: engine === 'codex' ? 'Codex' : 'Claude Code' };
}

export function environmentValue(env, name, platform = process.platform) {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).sort().find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

export function resolveBinary(binary, env = process.env, options = {}) {
  const platform = options.platform || process.platform;
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path;
  const filesystem = options.fs || fs;
  const cwd = options.cwd || process.cwd();
  if (typeof binary !== 'string' || !binary.trim()) throw new Error('请配置有效的 CLI 可执行文件。');
  const explicit = windows ? /[\\/]/.test(binary) || /^[a-z]:/i.test(binary) : binary.includes('/');
  const directories = String(environmentValue(env, 'PATH', platform) || '').split(windows ? ';' : ':')
    .map(dir => dir.replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const bases = explicit ? [paths.resolve(cwd, binary)] : directories.map(dir => paths.resolve(cwd, dir, binary));
  let candidates = bases;
  if (windows) {
    const allowed = new Set(['.COM', '.EXE', '.BAT', '.CMD']);
    const extensions = [...new Set(String(environmentValue(env, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD')
      .split(';').map(ext => ext.trim().toUpperCase()).filter(ext => allowed.has(ext)))];
    const ext = paths.extname(binary).toUpperCase();
    // Never choose npm's extensionless POSIX shim on native Windows.
    candidates = ext ? (allowed.has(ext) ? bases : []) : bases.flatMap(base => extensions.map(suffix => base + suffix));
  }
  for (const file of candidates) {
    try {
      filesystem.accessSync(file, windows ? fs.constants.F_OK : fs.constants.X_OK);
      if (filesystem.statSync(file).isFile()) return paths.resolve(cwd, file);
    } catch {}
  }
  throw new Error(`找不到 ${paths.basename(binary)}，请安装并登录相应 CLI，或在 bridge.config.json 中设置 binary 的绝对路径。`);
}

export function launchAgentPath(label) { return path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`); }

export function selectEngine(store, engine) {
  const previousEngine = store.data.engine || (store.data.threadId ? 'codex' : null);
  if (previousEngine && previousEngine !== engine) {
    if (store.data.jobs.length) throw new Error('有未完成的消息，请处理或重新扫码归档后再切换引擎。');
    store.data.threadId = null;
  }
  store.data.engine = engine;
  store.save();
}
