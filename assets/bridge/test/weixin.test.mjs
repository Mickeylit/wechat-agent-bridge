import test from 'node:test';
import assert from 'node:assert/strict';
import { WeixinClient } from '../lib/weixin.mjs';

function fixture(responses = [{ ret: 0 }], options = {}) {
  const calls = [];
  const client = new WeixinClient({
    token: 'local-test-token',
    ...options,
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init });
      const data = responses.shift() ?? { ret: 0 };
      return new Response(typeof data === 'string' ? data : JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  return { client, calls };
}

test('API origins reject credential and redirect destinations outside Weixin', () => {
  const { client } = fixture();
  const initial = client.baseUrl;
  for (const value of [
    'http://ilinkai.weixin.qq.com',
    'https://weixin.qq.com.attacker.example',
    'https://evilweixin.qq.com',
    'https://user:secret@ilinkai.weixin.qq.com',
    'https://ilinkai.weixin.qq.com:8443',
    'https://ilinkai.weixin.qq.com/api',
    'https://ilinkai.weixin.qq.com/?token=value',
    'https://ilinkai.weixin.qq.com/#fragment',
    'file:///tmp/auth',
    'not-a-url',
  ]) {
    assert.throws(() => client.setBaseUrl(value), TypeError);
    assert.equal(client.baseUrl, initial);
  }
  client.setBaseUrl('https://sh.ilinkai.weixin.qq.com/');
  assert.equal(client.baseUrl, 'https://sh.ilinkai.weixin.qq.com');
});

test('QR endpoints never receive the bot bearer token or base_info', async () => {
  const { client, calls } = fixture([{ qrcode: 'qr', qrcode_img_content: 'display' }, { status: 'wait' }]);
  client.setBaseUrl('https://sh.ilinkai.weixin.qq.com');
  assert.deepEqual(await client.getQr(), { qrcode: 'qr', qrcode_img_content: 'display' });
  await client.getQrStatus('qr&injected=value', '12 34');
  assert.equal(calls[0].url, 'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(calls[0].headers['iLink-App-ClientVersion'], '132106');
  assert.deepEqual(JSON.parse(calls[0].body), { local_token_list: [] });
  assert.match(Buffer.from(calls[0].headers['X-WECHAT-UIN'], 'base64').toString(), /^\d+$/);
  assert.equal(calls[1].url, 'https://sh.ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=qr%26injected%3Dvalue&verify_code=12+34');
  assert.equal(calls[1].method, 'GET');
  assert.deepEqual(calls[1].headers, { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '132106' });
  assert.equal(calls[1].body, undefined);
  assert.ok(calls.every(call => call.redirect === 'error'));
});

test('authenticated reply returns incoming context and preserves exact uint64 IDs', async () => {
  const { client, calls } = fixture([
    '{"ret":0,"msgs":[{"message_id":18446744073709551615,"item_list":[{"msg_id":9007199254740993}]}],"get_updates_buf":"next"}',
    '{"ret":0,"message_id":18446744073709551614}',
  ]);
  const updates = await client.updates('previous');
  assert.equal(updates.msgs[0].message_id, '18446744073709551615');
  assert.equal(updates.msgs[0].item_list[0].msg_id, '9007199254740993');
  const sent = await client.send({ to: 'owner', text: '你好', contextToken: 'reply-context', clientId: 'unique-id' });
  assert.equal(sent.message_id, '18446744073709551614');
  assert.equal(calls[0].headers.Authorization, 'Bearer local-test-token');
  assert.deepEqual(JSON.parse(calls[0].body), {
    get_updates_buf: 'previous',
    base_info: { channel_version: '2.4.10', bot_agent: 'CodexWeChatBridge/1.0.0' },
  });
  const sentBody = JSON.parse(calls[1].body);
  assert.deepEqual(sentBody.msg, {
    from_user_id: '', to_user_id: 'owner', client_id: 'unique-id',
    message_type: 2, message_state: 2, context_token: 'reply-context',
    item_list: [{ type: 1, text_item: { text: '你好' } }],
  });
});

test('authentication and context requirements prevent premature sends', async () => {
  const { client, calls } = fixture([], { token: undefined });
  await assert.rejects(client.updates(), { name: 'WeixinAuthError' });
  assert.equal(calls.length, 0);
  assert.throws(() => client.send({ to: 'owner', text: 'answer' }), /context token/);
});

test('business errors retain the expired-session code without leaking response details', async () => {
  const { client } = fixture([{ ret: -1, errcode: -14, errmsg: 'Bearer private-value', bot_token: 'private-value' }]);
  await assert.rejects(client.updates(), error => {
    assert.equal(error.name, 'WeixinApiError');
    assert.equal(error.code, -14);
    assert.doesNotMatch(String(error), /private-value/);
    return true;
  });
});

test('HTTP, invalid JSON and network errors omit sensitive response and URL content', async () => {
  for (const fetchImpl of [
    async () => new Response('secret-response', { status: 502 }),
    async () => new Response('secret-response', { status: 200 }),
    async () => { throw new Error('secret-url-and-token'); },
  ]) {
    const client = new WeixinClient({ token: 'token', fetchImpl });
    await assert.rejects(client.updates(), error => {
      assert.doesNotMatch(String(error), /secret/);
      return true;
    });
  }
});

test('caller cancellation produces an AbortError without persisting a new cursor', async () => {
  const controller = new AbortController();
  const client = new WeixinClient({
    token: 'token',
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  const result = client.updates('cursor', controller.signal);
  controller.abort(new Error('private-cancel-reason'));
  await assert.rejects(result, error => {
    assert.equal(error.name, 'AbortError');
    assert.doesNotMatch(String(error), /private/);
    return true;
  });
});
