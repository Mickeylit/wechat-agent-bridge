import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge, messageKey, messageText, splitText } from '../lib/bridge.mjs';
import { Store, lock } from '../lib/store.mjs';

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-codex-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const sends = [];
  const calls = [];
  const client = { send: async (part) => { sends.push(part); }, ...overrides.client };
  const runAgent = overrides.runAgent || (async (request) => {
    calls.push(request);
    const threadId = request.threadId || `thread-${calls.length}`;
    await request.onThread(threadId);
    return { text: `答：${request.prompt}`, threadId };
  });
  const bridge = new Bridge({ client, store, ownerId: 'owner', runAgent, cwd: dir });
  return { dir, store, client, runAgent, bridge, sends, calls };
}

function msg(id, text = '你好', extra = {}) {
  return { from_user_id: 'owner', message_id: id, message_type: 1, message_state: 2,
    context_token: `context-${id}`, item_list: [{ type: 1, text_item: { text } }], ...extra };
}

test('only queues paired owner direct messages with reply context', async (t) => {
  const f = fixture(t);
  f.bridge.ingest({ msgs: [
    msg(1), msg(2, '陌生人', { from_user_id: 'stranger' }), msg(3, '群消息', { group_id: 'group' }),
    msg(4, '机器人', { message_type: 2 }), msg(5, '无上下文', { context_token: '' }),
  ], get_updates_buf: 'cursor-1' });
  assert.equal(f.store.data.jobs.length, 1);
  await f.bridge.processQueue();
  assert.equal(f.calls.length, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].to, 'owner');
});

test('deduplicates within a batch, across pending polls, and after restart', async (t) => {
  const f = fixture(t);
  const inbound = msg(7);
  f.bridge.ingest({ msgs: [inbound, inbound], get_updates_buf: 'cursor-1' });
  f.bridge.ingest({ msgs: [inbound], get_updates_buf: 'cursor-2' });
  assert.equal(f.store.data.jobs.length, 1);
  await f.bridge.processQueue();
  const reloaded = new Store(f.dir);
  const restarted = new Bridge({ client: f.client, store: reloaded, ownerId: 'owner', runAgent: f.runAgent, cwd: f.dir });
  restarted.ingest({ msgs: [inbound], get_updates_buf: 'cursor-3' });
  await restarted.processQueue();
  assert.equal(f.calls.length, 1);
  assert.equal(reloaded.data.cursor, 'cursor-3');
  assert.deepEqual(reloaded.data.seen, [messageKey(inbound)]);
});

test('persists cursor and inbox before calling Codex, and outbox before send', async (t) => {
  const f = fixture(t);
  f.bridge.runAgent = async (request) => {
    const disk = JSON.parse(fs.readFileSync(f.store.file));
    assert.equal(disk.cursor, 'committed-cursor');
    assert.equal(disk.jobs[0].text, '持久化检查');
    assert.equal(disk.jobs[0].parts, null);
    await request.onThread('persisted-thread');
    assert.equal(new Store(f.dir).data.threadId, 'persisted-thread');
    return { text: '已确认', threadId: 'persisted-thread' };
  };
  f.client.send = async (part) => {
    const disk = new Store(f.dir).data;
    assert.equal(disk.jobs[0].parts[0].clientId, part.clientId);
    assert.equal(disk.jobs[0].parts[0].text, part.text);
    assert.equal(disk.jobs[0].sent, 0);
  };
  f.bridge.ingest({ msgs: [msg(1, '持久化检查')], get_updates_buf: 'committed-cursor' });
  await f.bridge.processQueue();
  assert.equal(new Store(f.dir).data.jobs.length, 0);
});

test('failed sends survive restart with same clientId and no repeated model call', async (t) => {
  const attempts = [];
  const f = fixture(t, { client: { send: async (part) => { attempts.push(part); throw new Error('temporary network failure'); } } });
  f.bridge.ingest({ msgs: [msg(1, '缓存回答')], get_updates_buf: 'cursor-1' });
  await assert.rejects(f.bridge.processQueue(), /temporary network failure/);
  assert.equal(f.calls.length, 1);
  const store = new Store(f.dir);
  const restarted = new Bridge({ store, ownerId: 'owner', cwd: f.dir,
    client: { send: async (part) => { attempts.push(part); } },
    runAgent: async () => assert.fail('model must not run when answer already persisted'),
  });
  await restarted.processQueue();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].clientId, attempts[1].clientId);
  assert.equal(attempts[0].text, attempts[1].text);
  assert.equal(store.data.jobs.length, 0);
});

test('multipart retry resumes after acknowledged chunks', async (t) => {
  const f = fixture(t, { runAgent: async () => ({ text: '你'.repeat(2500), threadId: 't' }) });
  const attempts = [];
  f.client.send = async (part) => {
    attempts.push(part);
    if (attempts.length === 2) throw new Error('second chunk failed');
  };
  f.bridge.ingest({ msgs: [msg(1)] });
  await assert.rejects(f.bridge.processQueue(), /second chunk failed/);
  assert.equal(new Store(f.dir).data.jobs[0].sent, 1);
  await f.bridge.processQueue();
  assert.equal(attempts[1].clientId, attempts[2].clientId);
  assert.notEqual(attempts[0].clientId, attempts[2].clientId);
  assert.equal(f.store.data.jobs.length, 0);
});

test('processes consecutive questions serially on the same thread', async (t) => {
  const f = fixture(t);
  f.bridge.ingest({ msgs: [msg(1, '记住苹果'), msg(2, '刚才说的是什么')] });
  await f.bridge.processQueue();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].threadId, null);
  assert.equal(f.calls[1].threadId, 'thread-1');
  assert.equal(f.sends[0].contextToken, 'context-1');
  assert.equal(f.sends[1].contextToken, 'context-2');
});

test('/new resets persisted conversation before the next question', async (t) => {
  const f = fixture(t);
  f.store.data.threadId = 'old-thread';
  f.store.save();
  f.bridge.ingest({ msgs: [msg(1, '/new'), msg(2, '新问题')] });
  await f.bridge.processQueue();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].threadId, null);
  assert.match(f.sends[0].text, /已开始新对话/);
});

test('segments Chinese and emoji by byte length without corrupting Unicode', () => {
  const input = '文字😀👍🏽é'.repeat(2000);
  const chunks = splitText(input);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), input);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk) <= 3500);
    assert.equal(Buffer.from(chunk).toString('utf8'), chunk);
  }
});

test('extracts plain text and transcribed voice, ignoring unsupported media', () => {
  assert.equal(messageText({ item_list: [
    { type: 2, image_item: { text: 'not text' } },
    { type: 1, text_item: { text: '文字' } },
    { type: 3, voice_item: { text: '语音文字' } },
  ] }), '文字\n语音文字');
});

test('stops polling without calling the model when inbox persistence fails', { timeout: 2000 }, async (t) => {
  const f = fixture(t);
  f.store.data.cursor = 'last-good-cursor';
  f.store.save();
  const blocked = path.join(f.dir, 'blocked');
  fs.writeFileSync(blocked, 'This is a file, so it cannot contain state.json.');
  f.store.file = path.join(blocked, 'state.json');
  f.client.notifyStart = async () => {};
  let polls = 0;
  f.client.updates = async () => { polls++; return { msgs: [msg(1)], get_updates_buf: 'unsaved-cursor' }; };
  await assert.rejects(f.bridge.run(), { code: 'STATE_FAILED' });
  assert.equal(polls, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.data.cursor, 'last-good-cursor');
  assert.deepEqual(f.store.data.jobs, []);
  assert.equal(new Store(f.dir).data.cursor, 'last-good-cursor');
});

test('does not send an answer whose outbox could not be saved', async (t) => {
  const f = fixture(t, { runAgent: async () => ({ text: '尚未持久化的回答', threadId: 't' }) });
  f.bridge.ingest({ msgs: [msg(1)] });
  const blocked = path.join(f.dir, 'blocked');
  fs.writeFileSync(blocked, 'not a directory');
  f.store.file = path.join(blocked, 'state.json');
  await assert.rejects(f.bridge.processQueue(), { code: 'STATE_FAILED' });
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.data.jobs[0].parts, null);
  assert.equal(f.store.data.threadId, null);
});

test('protects a newly created incomplete lock, recovers an old one, and blocks duplicate starts', (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, 'bridge.lock');
  fs.writeFileSync(file, '{');
  assert.throws(() => lock(f.dir), /等待 10 秒/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
  const old = new Date(Date.now() - 11_000);
  fs.utimesSync(file, old, old);
  const unlock = lock(f.dir);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  assert.throws(() => lock(f.dir), /服务已经运行/);
  unlock();
  assert.equal(fs.existsSync(file), false);
});

test('lock propagates real filesystem errors instead of removing the path', (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, 'bridge.lock');
  fs.mkdirSync(file);
  assert.throws(() => lock(f.dir), { code: 'EISDIR' });
  assert.equal(fs.statSync(file).isDirectory(), true);
});
