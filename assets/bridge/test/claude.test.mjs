import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createClaudeRunner, REQUIRED_CLAUDE_FLAGS, MIN_CLAUDE_VERSION } from '../lib/claude.mjs';

function fixture(script, extra = {}) {
  let invocation;
  let child;
  const runner = createClaudeRunner({
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
function complete(child, text = '你好', sessionId = 'session-1') {
  event(child, { type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId });
  child.emit('close', 0);
}

test('stdin prompts use no shell, disable built-in and MCP tools, and return only final result', async () => {
  const ids = [];
  const f = fixture((child) => {
    child.stdout.write('{"type":"sys');
    child.stdout.write('tem","subtype":"init","session_id":"session-1"}\n');
    event(child, { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'intermediate message' }] } });
    event(child, { type: 'system', subtype: 'hook_progress', stdout: 'secret command output' });
    event(child, { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'partial' } } });
    child.stderr.write('sk-secret-credential');
    complete(child, ' 最终回答 ');
  });
  const prompt = '你好 $(touch /tmp/never-run) `secret`';
  assert.deepEqual(await f.runner({ prompt, cwd: '/tmp', onThread: async (id) => ids.push(id) }), { text: '最终回答', threadId: 'session-1' });
  const { args, options, input } = f.invocation;
  assert.equal(options.shell, false);
  assert.equal(options.cwd, '/tmp');
  assert.ok(input.includes(prompt));
  assert.ok(!args.includes(prompt));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'mcp__*');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  assert.ok(args.includes('--safe-mode'));
  assert.ok(!args.some((arg) => arg.includes('bypass') || arg.includes('dangerously')));
  assert.deepEqual(ids, ['session-1']);
});

test('resumes exact session and supports final JSON without trailing newline', async () => {
  const f = fixture((child) => {
    child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '继续回答', session_id: 'saved-session' }));
    child.emit('close', 0);
  });
  assert.deepEqual(await f.runner({ prompt: '继续', threadId: 'saved-session' }), { text: '继续回答', threadId: 'saved-session' });
  assert.deepEqual(f.invocation.args.slice(-2), ['--resume', 'saved-session']);
  assert.ok(!f.invocation.args.includes('--continue'));
});

test('persists session from a result even if the init event was absent', async () => {
  const ids = [];
  const f = fixture((child) => complete(child));
  await f.runner({ prompt: 'test', onThread: async (id) => { ids.push(id); } });
  assert.deepEqual(ids, ['session-1']);
});

test('error result never exposes API error or stderr despite a zero exit status', async () => {
  const f = fixture((child) => {
    event(child, { type: 'assistant', message: { content: [{ type: 'text', text: 'unfinished answer' }] } });
    event(child, { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['sk-secret-token'], session_id: 'session-1' });
    child.stderr.write('sk-secret-token');
    child.emit('close', 0);
  });
  await assert.rejects(f.runner({ prompt: 'test' }), (error) => error.code === 'CLAUDE_FAILED' && !error.message.includes('secret'));
});

test('is_error true rejects even a success subtype with a result string', async () => {
  const f = fixture((child) => {
    event(child, { type: 'result', subtype: 'success', is_error: true, result: 'raw auth failure sk-secret', session_id: 'session-1' });
    child.emit('close', 0);
  });
  await assert.rejects(f.runner({ prompt: 'test' }), { code: 'CLAUDE_FAILED' });
});

test('nonzero exit provides upgrade advice without exposing unknown-option stderr', async () => {
  const f = fixture((child) => {
    child.stderr.write('unknown option --safe-mode; secret-user-path');
    child.emit('close', 1);
  });
  await assert.rejects(f.runner({ prompt: 'test' }), (error) => error.code === 'CLAUDE_FAILED' && error.message.includes('升级') && !error.message.includes('secret'));
});

test('ignores malformed and intermediate events without inventing a final answer', async () => {
  const f = fixture((child) => {
    child.stdout.write('diagnostic text\nnull\n');
    event(child, { type: 'system', subtype: 'init', session_id: 'session-1' });
    event(child, { type: 'assistant', message: { content: [{ type: 'text', text: 'partial answer' }] } });
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

test('pre-cancelled and invalid requests do not spawn Claude', async () => {
  const f = fixture();
  await assert.rejects(f.runner({ prompt: 'test', signal: AbortSignal.abort() }), { code: 'ABORTED' });
  await assert.rejects(f.runner({ prompt: ' ' }), { code: 'INVALID_PROMPT' });
  await assert.rejects(f.runner({ prompt: 'test', timeoutMs: NaN }), { code: 'INVALID_TIMEOUT' });
  await assert.rejects(f.runner({ prompt: 'test', threadId: {} }), { code: 'INVALID_THREAD' });
  assert.equal(f.invocation, undefined);
});

test('fails safely when thread persistence fails', async () => {
  const f = fixture((child) => {
    event(child, { type: 'system', subtype: 'init', session_id: 'session-1' });
    complete(child);
  });
  await assert.rejects(f.runner({ prompt: 'test', onThread: async () => { throw new Error('storage secret'); } }), { code: 'STATE_FAILED' });
});

test('bounds unparseable output and kills the process', async () => {
  const f = fixture((child) => child.stdout.write('x'.repeat(4 * 1024 * 1024 + 1)));
  await assert.rejects(f.runner({ prompt: 'test' }), { code: 'OUTPUT_LIMIT' });
  assert.deepEqual(f.child.kills, ['SIGTERM']);
});

test('allows binary override and exposes doctor requirements', async () => {
  const f = fixture((child) => complete(child), { binary: '/custom/path/claude' });
  await f.runner({ prompt: 'test' });
  assert.equal(f.invocation.binary, '/custom/path/claude');
  assert.equal(MIN_CLAUDE_VERSION, '2.1.259');
  assert.ok(REQUIRED_CLAUDE_FLAGS.includes('--safe-mode'));
  assert.ok(REQUIRED_CLAUDE_FLAGS.includes('--permission-prompts'));
});

test('spawn error has a friendly message without forwarding the exception', async () => {
  const runner = createClaudeRunner({ platform: 'linux', spawn() { throw new Error('private path and secret'); } });
  await assert.rejects(runner({ prompt: 'test' }), (error) => error.code === 'START_FAILED' && !error.message.includes('secret'));
});

test('Windows Claude native exe launches directly without console or shell', async () => {
  const binary = String.raw`C:\用户 空格\Claude Code\claude.exe`;
  const f = fixture((child) => complete(child), { binary, platform: 'win32' });
  const prompt = '中文 & "quotes" %PATH%';
  await f.runner({ prompt });
  assert.equal(f.invocation.binary, binary);
  assert.equal(f.invocation.options.shell, false);
  assert.equal(f.invocation.options.windowsHide, true);
  assert.equal(f.invocation.options.detached, false);
  assert.ok(f.invocation.input.includes(prompt));
  assert.ok(!f.invocation.args.includes(prompt));
});

test('Windows Claude timeout terminates all descendants', async () => {
  const calls = [];
  const f = fixture(undefined, {
    binary: String.raw`C:\Claude\claude.exe`, platform: 'win32',
    spawnSync(...args) {
      calls.push(args);
      queueMicrotask(() => f.child.emit('close', null));
      return { status: 0 };
    },
  });
  const pending = f.runner({ prompt: 'test', timeoutMs: 10 });
  f.child.pid = 9876;
  await assert.rejects(pending, { code: 'TIMEOUT' });
  assert.deepEqual(calls[0][1], ['/PID', '9876', '/T', '/F']);
});

test('Windows custom batch rejection remains actionable and never spawns a shell', async () => {
  const f = fixture(undefined, { binary: String.raw`C:\custom-agent.cmd`, platform: 'win32' });
  await assert.rejects(f.runner({ prompt: 'test' }), (error) => error.code === 'UNSUPPORTED_LAUNCH' && error.message.includes('.exe'));
  assert.equal(f.invocation, undefined);
});
