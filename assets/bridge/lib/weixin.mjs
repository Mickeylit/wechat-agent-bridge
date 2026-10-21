import { randomBytes, randomUUID } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '2.4.10';
const CLIENT_VERSION = '132106';
const BOT_AGENT = 'CodexWeChatBridge/1.0.0';
const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id']);

function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Weixin API base URL is invalid.');
  }
  if (
    url.protocol !== 'https:' ||
    !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com')) ||
    url.username || url.password || url.port ||
    url.pathname !== '/' || url.search || url.hash
  ) {
    throw new TypeError('Weixin API base URL must be an HTTPS weixin.qq.com origin without credentials, paths or a custom port.');
  }
  return url.origin;
}

function makeError(name, message, fields = {}) {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, fields);
  return error;
}

function parseResponse(text) {
  let data;
  try {
    data = JSON.parse(text, (key, value, context) => {
      // Node 24 exposes the original token before IEEE-754 rounding. Preserve
      // uint64 message identifiers so deduplication cannot merge different IDs.
      if (LOSSLESS_ID_FIELDS.has(key) && typeof value === 'number') {
        const source = context?.source;
        if (source && /^-?\d+$/.test(source)) return source;
        if (!Number.isSafeInteger(value)) {
          throw new Error('Lossless message identifier parsing requires Node 24.');
        }
        return String(value);
      }
      return value;
    });
  } catch {
    throw makeError('WeixinProtocolError', 'Weixin returned an invalid JSON response.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw makeError('WeixinProtocolError', 'Weixin returned an unexpected response format.');
  }
  const codes = [data.ret, data.errcode]
    .filter(value => typeof value === 'number' && Number.isFinite(value) && value !== 0);
  if (codes.length) {
    const code = codes.includes(-14) ? -14 : codes[0];
    // Do not interpolate server errmsg or response bodies: either can contain
    // tokens, user identifiers, pairing codes, or message contents.
    throw makeError('WeixinApiError', `Weixin API returned error ${code}.`, { code });
  }
  return data;
}

/** Minimal client for Tencent's published Weixin iLink bot protocol. */
export class WeixinClient {
  #baseUrl;
  #token;
  #fetch;

  constructor({ baseUrl = DEFAULT_BASE_URL, token, fetchImpl = globalThis.fetch } = {}) {
    this.setBaseUrl(baseUrl);
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');
    if (token !== undefined && typeof token !== 'string') throw new TypeError('token must be a string.');
    this.#token = token?.trim();
    this.#fetch = fetchImpl;
  }

  get baseUrl() { return this.#baseUrl; }

  setBaseUrl(baseUrl) {
    this.#baseUrl = validateBaseUrl(baseUrl);
    return this;
  }

  async #request(endpoint, {
    body,
    authenticated = false,
    baseUrl = this.#baseUrl,
    timeoutMs = 15_000,
    signal,
  } = {}) {
    if (authenticated && !this.#token) {
      throw makeError('WeixinAuthError', 'Weixin login is required.');
    }
    const headers = {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': CLIENT_VERSION,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64');
    }
    if (authenticated) headers.Authorization = `Bearer ${this.#token}`;

    const deadline = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const response = await this.#fetch(`${baseUrl}/${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combinedSignal,
        redirect: 'error',
      });
      if (!response.ok) {
        throw makeError('WeixinHttpError', `Weixin HTTP request failed (${response.status}).`, { status: response.status });
      }
      return parseResponse(await response.text());
    } catch (error) {
      if (signal?.aborted) {
        throw makeError('AbortError', 'Weixin request was cancelled.');
      }
      if (deadline.aborted || error?.name === 'TimeoutError') {
        throw makeError('TimeoutError', 'Weixin request timed out.');
      }
      if (['WeixinHttpError', 'WeixinProtocolError', 'WeixinApiError'].includes(error?.name)) {
        throw error;
      }
      throw makeError('WeixinNetworkError', 'Weixin network request failed.');
    }
  }

  #post(endpoint, body = {}, { signal, timeoutMs } = {}) {
    return this.#request(endpoint, {
      authenticated: true,
      body: {
        ...body,
        base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT },
      },
      signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  getQr() {
    return this.#request('ilink/bot/get_bot_qrcode?bot_type=3', {
      baseUrl: DEFAULT_BASE_URL,
      body: { local_token_list: [] },
    });
  }

  getQrStatus(qrcode, verifyCode) {
    if (typeof qrcode !== 'string' || !qrcode) throw new TypeError('A QR code is required.');
    const query = new URLSearchParams({ qrcode });
    if (verifyCode !== undefined && verifyCode !== '') query.set('verify_code', String(verifyCode));
    return this.#request(`ilink/bot/get_qrcode_status?${query}`, { timeoutMs: 40_000 });
  }

  updates(cursor = '', signal) {
    if (typeof cursor !== 'string') throw new TypeError('The updates cursor must be a string.');
    return this.#post('ilink/bot/getupdates', { get_updates_buf: cursor }, { signal, timeoutMs: 40_000 });
  }

  send({ to, text, contextToken, clientId = randomUUID() }) {
    if (typeof to !== 'string' || !to) throw new TypeError('A reply recipient is required.');
    if (typeof text !== 'string' || !text) throw new TypeError('Reply text is required.');
    if (typeof contextToken !== 'string' || !contextToken) {
      throw new TypeError('The incoming message context token is required for a reply.');
    }
    if (typeof clientId !== 'string' || !clientId) throw new TypeError('A client message ID is required.');
    return this.#post('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
    });
  }

  notifyStart() { return this.#post('ilink/bot/msg/notifystart'); }
  notifyStop() { return this.#post('ilink/bot/msg/notifystop'); }
}
