import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveLaunch, killProcessTree } from '../lib/process.mjs';

function fakeWindowsFs(entries) {
  const files = new Map(Object.entries(entries).map(([file, content]) => [path.win32.normalize(file).toLowerCase(), content]));
  const lookup = file => {
    const key = path.win32.normalize(file).toLowerCase();
    if (!files.has(key)) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
    return files.get(key);
  };
  return {
    accessSync(file) { lookup(file); },
    statSync(file) { lookup(file); return { isFile: () => true }; },
    readFileSync(file) { return lookup(file); },
  };
}

function packageFixture(tool, { local = false, bin, metadata = {} } = {}) {
  const prefix = String.raw`C:\Users\小明\AI tools`;
  const packageName = tool === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';
  const modules = path.win32.join(prefix, 'node_modules');
  const root = path.win32.join(modules, ...packageName.split('/'));
  const shim = path.win32.join(local ? path.win32.join(modules, '.bin') : prefix, `${tool}.cmd`);
  const entry = bin || (tool === 'codex' ? 'bin/codex.js' : 'cli.js');
  const entryPath = path.win32.resolve(root, entry);
  return { shim, entryPath, options: {
    platform: 'win32', execPath: String.raw`C:\Program Files\nodejs\node.exe`,
    fs: fakeWindowsFs({
      [shim]: 'a batch file that must not be executed or parsed',
      [path.win32.join(root, 'package.json')]: JSON.stringify({ name: packageName, bin: { [tool]: entry }, ...metadata }),
      [entryPath]: 'entry fixture',
    }),
  } };
}

test('POSIX invocations remain shell-free argv without rewriting native commands', () => {
  const args = ['--version', 'a b', '问题 & $(never execute)'];
  const launch = resolveLaunch('/opt/AI Tools/codex', args, { platform: 'darwin' });
  assert.deepEqual(launch, { command: '/opt/AI Tools/codex', args });
  assert.notEqual(launch.args, args);
});

test('native Windows exe handles Unicode spaces and metacharacters as plain arguments', () => {
  const binary = String.raw`C:\AI 工具\Claude Code\claude.exe`;
  const args = ['--resume', '会话 空格 & value'];
  assert.deepEqual(resolveLaunch(binary, args, { platform: 'win32' }), { command: binary, args });
});

test('npm Codex shim resolves its package.json bin to Node, never cmd.exe', () => {
  const fixture = packageFixture('codex');
  const args = ['exec', '--json', '-'];
  const launch = resolveLaunch(fixture.shim, args, fixture.options);
  assert.equal(launch.command, fixture.options.execPath);
  assert.deepEqual(launch.args, [fixture.entryPath, ...args]);
  assert.ok(!launch.args.includes(fixture.shim));
});

test('local npm .bin and uppercase CMD use the official Claude JavaScript entry', () => {
  const fixture = packageFixture('claude', { local: true });
  const launch = resolveLaunch(fixture.shim.toUpperCase(), ['--version'], fixture.options);
  assert.equal(launch.command, fixture.options.execPath);
  assert.equal(launch.args[0].toLowerCase(), fixture.entryPath.toLowerCase());
  assert.equal(launch.args[1], '--version');
});

test('current Claude npm native executable is launched directly', () => {
  const fixture = packageFixture('claude', { bin: 'bin/claude.exe' });
  assert.deepEqual(resolveLaunch(fixture.shim, ['-p'], fixture.options), { command: fixture.entryPath, args: ['-p'] });
});

test('bare Windows command resolves PATH and PATHEXT before adapting npm shim', () => {
  const fixture = packageFixture('codex');
  const launch = resolveLaunch('codex', ['--version'], {
    ...fixture.options, env: { Path: path.win32.dirname(fixture.shim), Pathext: '.CMD;.EXE' },
  });
  assert.equal(launch.command, fixture.options.execPath);
  assert.equal(launch.args[0], fixture.entryPath);
});

test('custom batch files and unofficial package names are rejected without shell fallback', () => {
  assert.throws(() => resolveLaunch(String.raw`C:\Tools\my-agent.cmd`, [], { platform: 'win32' }), { code: 'UNSUPPORTED_LAUNCH' });
  const fixture = packageFixture('codex', { metadata: { name: '@untrusted/codex' } });
  assert.throws(() => resolveLaunch(fixture.shim, [], fixture.options), { code: 'UNSUPPORTED_LAUNCH' });
});

test('package bin must stay inside the known package and be a JS or native entry', () => {
  for (const bin of ['../../../escape.js', 'C:\\outside.exe', 'bin/launcher.cmd']) {
    const fixture = packageFixture('codex', { bin });
    assert.throws(() => resolveLaunch(fixture.shim, [], fixture.options), { code: 'UNSUPPORTED_LAUNCH' });
  }
});

test('Windows tree termination uses trusted taskkill path, numeric PID, no shell and hidden window', () => {
  const calls = [];
  let fallback = false;
  const result = killProcessTree({ pid: 4321, kill() { fallback = true; } }, 'SIGTERM', {
    platform: 'win32', env: { SystemRoot: String.raw`D:\Windows` },
    spawnSync(...args) { calls.push(args); return { status: 0 }; },
  });
  assert.equal(result, true);
  assert.equal(fallback, false);
  assert.equal(calls[0][0], String.raw`D:\Windows\System32\taskkill.exe`);
  assert.deepEqual(calls[0][1], ['/PID', '4321', '/T', '/F']);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(calls[0][2].stdio, 'ignore');
});

test('invalid PIDs never reach taskkill and failures fall back to child.kill', () => {
  let calls = 0;
  const signals = [];
  for (const pid of ['1 & malicious', 0, -5, NaN]) {
    killProcessTree({ pid, kill(signal) { signals.push(signal); } }, 'SIGTERM', {
      platform: 'win32', spawnSync() { calls++; throw new Error('must not call'); },
    });
  }
  assert.equal(calls, 0);
  assert.equal(signals.length, 4);
  assert.equal(killProcessTree({ pid: 42, kill: () => true }, 'SIGKILL', {
    platform: 'win32', spawnSync() { return { status: 1 }; },
  }), true);
  assert.equal(killProcessTree(undefined, 'SIGTERM', { platform: 'win32' }), false);
});

test('POSIX tree cleanup addresses the negative process-group PID', () => {
  const calls = [];
  assert.equal(killProcessTree({ pid: 1234 }, 'SIGTERM', {
    platform: 'linux', kill(pid, signal) { calls.push([pid, signal]); },
  }), true);
  assert.deepEqual(calls, [[-1234, 'SIGTERM']]);
});
