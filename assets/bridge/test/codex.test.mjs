import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createCodexRunner } from '../lib/codex.mjs';

function fixture(script, extra = {}) {
  let invocation;
  let child;
  const runner = createCodexRunner({
    platform: 'linux',
    ...extra,
    spawn(binary, args, options) {
      child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kills = [];
      child.kill = (signal) => {
        child.kills.push(signal);
        queueMicrotask(() => child.emit('close', null));
      };
      invocation = { binary, args, options, input: '' };
      child.stdin.on('data', (chunk) => { invocation.input += chunk; });
      child.stdin.on('finish', () => queueMicrotask(() => script?.(child)));
      return child;
    },
  });
  return { runner, get invocation() { return invocation; }, get child() { return child; } };
}

function event(child, value) { child.stdout.write(`${JSON.stringify(value)}\n`); }
function complete(child, text = '你好') {
  event(child, { type: 'item.completed', item: { type: 'agent_message', text } });
  event(child, { type: 'turn.completed' });
  child.emit('close', 0);
}

test('passes user text via stdin, enforces read-only, returns final text only', async () => {
  const ids = [];
  const f = fixture((child) => {
    child.stdout.write('{"type":"thread.st');
    child.stdout.write('arted","thread_id":"thread-1"}\n');
    event(child, { type: 'item.completed', item: { type: 'reasoning', text: 'secret thought' } });
    event(child, { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'private data' } });
    event(child, { type: 'item.completed', item: { type: 'agent_message', phase: 'commentary', text: 'progress' } });
    child.stderr.write('sk-secret-credential');
    complete(child, ' 最终回答 ');
  });
  const prompt = '你好 $(touch /tmp/no) `secret`';
  assert.deepEqual(await f.runner({ prompt, cwd: '/tmp', onThread: (id) => ids.push(id) }), { text: '最终回答', threadId: 'thread-1' });
  assert.equal(f.invocation.options.shell, false);
  assert.ok(f.invocation.input.includes(prompt));
  assert.ok(!f.invocation.args.includes(prompt));
  assert.deepEqual(f.invocation.args.slice(0, 4), ['-a', 'never', '-s', 'read-only']);
  assert.ok(f.invocation.args.includes('--skip-git-repo-check'));
  assert.deepEqual(ids, ['thread-1']);
});

test('resumes the given conversation and accepts JSON without trailing newline', async () => {
  const f = fixture((child) => {
    event(child, { type: 'item.completed', item: { type: 'agent_message', text: '继续回答' } });
    child.stdout.write('{"type":"turn.completed"}');
    child.emit('close', 0);
  });
  assert.deepEqual(await f.runner({ prompt: '继续', threadId: 'saved-thread' }), { text: '继续回答', threadId: 'saved-thread' });
  assert.deepEqual(f.invocation.args.slice(-6), ['exec', 'resume', '--json', '--skip-git-repo-check', 'saved-thread', '-']);
  assert.ok(!f.invocation.args.includes('--last'));
});

test('never returns raw errors or partial output when a turn fails', async () => {
  const f = fixture((child) => {
    event(child, { type: 'thread.started', thread_id: 't' });
    event(child, { type: 'item.completed', item: { type: 'agent_message', text: 'unfinished' } });
    event(child, { type: 'turn.failed', error: { message: 'sk-secret-token' } });
    child.stderr.write('sk-secret-token');
    child.emit('close', 1);
  });
  await assert.rejects(f.runner({ prompt: 'test' }), (error) => error.code === 'CODEX_FAILED' && !error.message.includes('secret'));
});

test('rejects a clean process exit without a completed answer', async () => {
  const f = fixture((child) => {
    event(child, { type: 'thread.started', thread_id: 't' });
    child.emit('close', 0);
  });
  await assert.rejects(f.runner({ prompt: 'test' }), { code: 'NO_ANSWER' });
});

test('stops the process on timeout', async () => {
  const f = fixture();
  await assert.rejects(f.runner({ prompt: 'test', timeoutMs: 10 }), { code: 'TIMEOUT' });
  assert.deepEqual(f.child.kills, ['SIGTERM']);
});

test('stops the process on cancellation', async () => {
  const f = fixture();
  const controller = new AbortController();
  const result = f.runner({ prompt: 'test', signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { name: 'AbortError', code: 'ABORTED' });
  assert.deepEqual(f.child.kills, ['SIGTERM']);
});

test('pre-cancelled request never starts Codex', async () => {
  const f = fixture();
  await assert.rejects(f.runner({ prompt: 'test', signal: AbortSignal.abort() }), { code: 'ABORTED' });
  assert.equal(f.invocation, undefined);
});

test('fails safely when thread persistence fails', async () => {
  const f = fixture((child) => {
    event(child, { type: 'thread.started', thread_id: 't' });
    complete(child);
  });
  await assert.rejects(f.runner({ prompt: 'test', onThread: async () => { throw new Error('storage secret'); } }), { code: 'STATE_FAILED' });
});

test('Windows Codex npm shim runs its JavaScript entry with Node and keeps prompt on stdin', async () => {
  const entry = String.raw`C:\用户 工具\node_modules\@openai\codex\bin\codex.js`;
  const f = fixture((child) => {
    event(child, { type: 'thread.started', thread_id: 'windows-thread' });
    complete(child, 'Windows 回答');
  }, {
    binary: String.raw`C:\用户 工具\codex.cmd`, platform: 'win32', execPath: String.raw`C:\Program Files\nodejs\node.exe`,
    fs: {
      readFileSync: () => JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }),
      statSync: () => ({ isFile: () => true }),
    },
  });
  const prompt = '中文 & "quoted" %PATH% $(never)';
  await f.runner({ prompt });
  assert.equal(f.invocation.binary, String.raw`C:\Program Files\nodejs\node.exe`);
  assert.equal(f.invocation.args[0], entry);
  assert.equal(f.invocation.options.detached, false);
  assert.equal(f.invocation.options.shell, false);
  assert.equal(f.invocation.options.windowsHide, true);
  assert.ok(f.invocation.input.includes(prompt));
  assert.ok(!f.invocation.args.includes(prompt));
});

test('Windows Codex cancellation terminates the process tree with taskkill', async () => {
  const calls = [];
  const f = fixture(undefined, {
    binary: String.raw`C:\Codex\codex.exe`, platform: 'win32',
    spawnSync(...args) {
      calls.push(args);
      queueMicrotask(() => f.child.emit('close', null));
      return { status: 0 };
    },
  });
  const controller = new AbortController();
  const pending = f.runner({ prompt: 'test', signal: controller.signal });
  f.child.pid = 7654;
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
  assert.deepEqual(calls[0][1], ['/PID', '7654', '/T', '/F']);
  assert.equal(calls[0][2].shell, false);
});
