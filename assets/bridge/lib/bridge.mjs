import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const HELP = '直接发文字即可提问，后续消息会接着当前对话。\n\n/new 或 /新对话：开始新对话\n/status 或 /状态：查看连接状态\n/help 或 /帮助：显示帮助\n\n当前支持文字及微信已转成文字的语音；请把图片或文件中的问题转为文字发送。';

export function messageText(msg) {
  return (msg.item_list || []).map(item => item.type === 1 ? item.text_item?.text : item.type === 3 ? item.voice_item?.text : '').filter(Boolean).join('\n').trim();
}

export function messageKey(msg) {
  const id = msg.message_id ?? msg.client_id ?? msg.seq;
  return createHash('sha256').update(JSON.stringify([msg.from_user_id, id ?? msg.create_time_ms, id == null ? msg.item_list : null])).digest('hex');
}

export function splitText(text, limit = 3500) {
  const result = [];
  let chunk = '', bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > limit && chunk) { result.push(chunk); chunk = ''; bytes = 0; }
    chunk += char; bytes += size;
  }
  if (chunk) result.push(chunk);
  return result;
}

export class Bridge {
  constructor({ client, store, ownerId, runAgent, engineName = 'Codex', cwd, log = () => {}, signal }) {
    if (!ownerId) throw new Error('缺少扫码者身份，请重新登录。');
    Object.assign(this, { client, store, ownerId, runAgent, engineName, cwd, log, signal });
    this.working = false;
    this.processor = null;
    this.sendFailures = 0;
  }

  ingest(response) {
    const data = this.store.data;
    const known = new Set([...data.seen, ...data.jobs.map(job => job.id)]);
    for (const msg of response.msgs || []) {
      // Only reply to the person who explicitly paired this bridge.
      if (msg.from_user_id !== this.ownerId || msg.group_id || msg.message_type === 2) continue;
      if (!msg.context_token) { this.log('忽略缺少回复上下文的消息。'); continue; }
      const id = messageKey(msg);
      if (known.has(id)) continue;
      data.jobs.push({ id, text: messageText(msg), contextToken: msg.context_token, to: msg.from_user_id, receivedAt: Date.now(), parts: null, sent: 0 });
      known.add(id);
    }
    if (response.get_updates_buf) data.cursor = response.get_updates_buf;
    data.lastPollAt = new Date().toISOString();
    // Inbox and cursor are committed together before generating any reply.
    this.store.save();
  }

  async prepare(job) {
    const text = job.text;
    let answer;
    if (/^\/(new|新对话)$/i.test(text)) {
      this.store.data.threadId = null;
      answer = '已开始新对话，请发送你的问题。';
    } else if (/^\/(help|帮助)$/i.test(text)) {
      answer = HELP;
    } else if (/^\/(status|状态)$/i.test(text)) {
      answer = `微信连接正常，${this.engineName} 问答服务正在运行。\n会话：${this.store.data.threadId ? '已有上下文' : '新对话'}\n运行位置：本机（需保持开机联网）。`;
    } else if (!text) {
      answer = '请发送文字问题，或先在微信中将语音转成文字。当前还未接入图片和文件识别。';
    } else if (text.length > 16000) {
      answer = '这条问题太长，请分成少于 16000 字的消息发送。';
    } else {
      this.log(`已收到问题，${this.engineName} 正在回答。`);
      try {
        const result = await this.runAgent({ prompt: text, threadId: this.store.data.threadId, cwd: this.cwd, signal: this.signal,
          onThread: threadId => { this.store.data.threadId = threadId; this.store.save(); } });
        this.store.data.threadId = result.threadId;
        answer = result.text;
      } catch (error) {
        if (this.signal?.aborted) throw error;
        if (error.code === 'STATE_FAILED') throw error;
        // Never forward arbitrary process output, environment, or API error bodies.
        answer = `这次 ${this.engineName} 暂时没有完成回答，请稍后再试。若反复失败，请在电脑中检查引擎登录及服务状态；也可以发送 /new 开始新对话。`;
        this.log(`引擎调用未完成（${error.code || error.name || 'error'}）。`);
      }
    }
    job.parts = splitText(answer || '本次没有生成回答，请重新提问。').map(text => ({ text, clientId: `wechat-${randomUUID()}` }));
    this.store.save();
  }

  async processQueue() {
    while (this.store.data.jobs.length && !this.signal?.aborted) {
      const job = this.store.data.jobs[0];
      if (!job.parts) await this.prepare(job);
      while (job.sent < job.parts.length && !this.signal?.aborted) {
        const part = job.parts[job.sent];
        await this.client.send({ to: job.to, text: part.text, contextToken: job.contextToken, clientId: part.clientId });
        job.sent++;
        this.sendFailures = 0;
        this.store.save();
      }
      if (this.signal?.aborted) break;
      this.store.data.jobs.shift();
      this.store.data.seen = [...this.store.data.seen, job.id].slice(-2000);
      this.store.data.lastReplyAt = new Date().toISOString();
      this.store.save();
      this.log('回答已发送到微信。');
    }
  }

  kick() {
    if (this.working || !this.store.data.jobs.length || this.signal?.aborted) return;
    this.working = true;
    this.processor = this.processQueue().catch(async error => {
      if (error.code === 'STATE_FAILED' || error.code === -14) { this.fatalError = error; return; }
      if (!this.signal?.aborted) {
        this.sendFailures++;
        this.log(`发送暂未完成，已保留待发回答（${error.code || error.name || 'error'}）。`);
        await delay(Math.min(60000, 1000 * 2 ** Math.min(this.sendFailures, 6)), null, { signal: this.signal }).catch(() => {});
      }
    }).finally(() => { this.working = false; });
  }

  async run() {
    let failures = 0;
    try { await this.client.notifyStart(); } catch { this.log('启动通知未送达，将继续连接。'); }
    this.kick();
    while (!this.signal?.aborted) {
      try {
        if (this.fatalError) throw this.fatalError;
        const response = await this.client.updates(this.store.data.cursor, this.signal);
        if (this.signal?.aborted) break;
        if (this.fatalError) throw this.fatalError;
        this.ingest(response);
        failures = 0;
        this.kick();
        // Guard against an upstream returning immediate empty responses.
        await delay(500, null, { signal: this.signal });
      } catch (error) {
        if (this.signal?.aborted) break;
        if (error.code === 'STATE_FAILED') throw error;
        if (error.code === -14) {
          this.log('微信连接凭证已失效，请重新运行扫码登录。');
          throw error;
        }
        if (error.name !== 'TimeoutError' && error.name !== 'AbortError') {
          failures++;
          this.log(`微信连接暂不可用，正在重连（${error.code || error.name || 'network'}）。`);
          await delay(Math.min(60000, 1000 * 2 ** Math.min(failures, 6)), null, { signal: this.signal }).catch(() => {});
        }
        this.kick();
      }
    }
    await this.processor;
  }
}
