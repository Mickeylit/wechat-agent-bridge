import { spawn as nodeSpawn } from 'node:child_process';
import { resolveLaunch, killProcessTree } from './process.mjs';

const MAX_LINE_LENGTH = 4 * 1024 * 1024;
const WECHAT_INSTRUCTIONS = '你正在通过微信回答用户问题。默认使用简洁、清楚的中文，保留必要的上下文；不要输出内部推理或工具日志。当前为只读问答模式，不修改文件，不向第三方发送消息。';

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Factory exported for process-isolated testing; production uses runCodex below. */
export function createCodexRunner({ spawn = nodeSpawn, binary = process.env.CODEX_BIN || 'codex', platform = process.platform, ...processOptions } = {}) {
  return function runCodex({ prompt, threadId, cwd, signal, onThread, timeoutMs = 180000 } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return Promise.reject(failure('INVALID_PROMPT', '请输入要问 Codex 的问题。'));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(failure('INVALID_TIMEOUT', 'Codex 超时配置无效。'));
    }
    if (signal?.aborted) {
      return Promise.reject(Object.assign(failure('ABORTED', '已停止本次回答。'), { name: 'AbortError' }));
    }

    const args = ['-a', 'never', '-s', 'read-only'];
    if (cwd) args.push('-C', cwd);
    args.push('-c', `developer_instructions=${JSON.stringify(WECHAT_INSTRUCTIONS)}`, 'exec');
    if (threadId) args.push('resume');
    args.push('--json', '--skip-git-repo-check');
    if (threadId) args.push(threadId);
    args.push('-');

    return new Promise((resolve, reject) => {
      let child;
      try {
        const launch = resolveLaunch(binary, args, { ...processOptions, platform });
        child = spawn(launch.command, launch.args, {
          cwd,
          shell: false,
          detached: platform !== 'win32',
          windowsHide: true,
          env: processOptions.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        if (error.code === 'UNSUPPORTED_LAUNCH') { reject(error); return; }
        reject(failure('START_FAILED', '无法启动本机 Codex，请检查安装及登录状态。'));
        return;
      }

      let buffer = '';
      let resultThreadId = threadId;
      let text = '';
      let explicitFinal = false;
      let completed = false;
      let turnFailed = false;
      let settled = false;
      let stoppingError;
      let killTimer;
      let settleTimer;
      let threadCallback = Promise.resolve();

      const cleanup = () => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        clearTimeout(settleTimer);
        signal?.removeEventListener('abort', abort);
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(result);
      };
      const kill = (killSignal) => {
        killProcessTree(child, killSignal, { ...processOptions, platform });
      };
      const stop = (error) => {
        if (stoppingError || settled) return;
        stoppingError = error;
        killTimer = setTimeout(() => kill('SIGKILL'), 1000);
        settleTimer = setTimeout(() => finish(error), 2000);
        kill('SIGTERM');
      };
      const abort = () => stop(Object.assign(failure('ABORTED', '已停止本次回答。'), { name: 'AbortError' }));
      const timeout = setTimeout(() => stop(failure('TIMEOUT', 'Codex 回答超时，请稍后重试或缩短问题。')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      // Account for cancellation between the initial check and listener registration.
      if (signal?.aborted) abort();

      const parseLine = (line) => {
        if (!line.trim() || stoppingError || settled) return;
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          resultThreadId = event.thread_id;
          if (onThread) {
            threadCallback = threadCallback.then(() => onThread(resultThreadId)).catch(() => {
              stop(failure('STATE_FAILED', '无法保存 Codex 会话，请检查本地存储。'));
            });
          }
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          const item = event.item;
          if (typeof item.text !== 'string' || item.phase === 'commentary') return;
          if (item.phase === 'final_answer') {
            explicitFinal = true;
            text = item.text;
          } else if (!explicitFinal) {
            // Older CLI versions omit phase. The final completed agent message is the answer.
            text = item.text;
          }
        }
        if (event.type === 'turn.completed') completed = true;
        if (event.type === 'turn.failed' || event.type === 'error') turnFailed = true;
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (settled || stoppingError) return;
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.length > MAX_LINE_LENGTH) {
            stop(failure('OUTPUT_LIMIT', 'Codex 输出过大，请缩小问题范围。'));
            return;
          }
          parseLine(line);
        }
        if (buffer.length > MAX_LINE_LENGTH) stop(failure('OUTPUT_LIMIT', 'Codex 输出过大，请缩小问题范围。'));
      });
      // Drain diagnostics without retaining or forwarding credentials, tool logs, or reasoning.
      child.stderr.resume();
      child.stdin.on('error', () => {
        if (!settled && !stoppingError) stop(failure('INPUT_FAILED', '无法把问题交给 Codex，请重试。'));
      });
      child.on('error', () => finish(failure('START_FAILED', '无法启动本机 Codex，请检查安装及登录状态。')));
      child.on('close', async (code) => {
        parseLine(buffer);
        await threadCallback;
        if (stoppingError) return finish(stoppingError);
        if (code !== 0 || turnFailed) {
          return finish(failure('CODEX_FAILED', 'Codex 本次调用失败，请检查本机登录、网络或额度后重试。'));
        }
        if (!completed || !text.trim() || !resultThreadId) {
          return finish(failure('NO_ANSWER', 'Codex 没有返回完整回答，请重试。'));
        }
        finish(undefined, { text: text.trim(), threadId: resultThreadId });
      });
      child.stdin.end(`请回答以下微信消息：\n\n${prompt}\n`);
    });
  };
}

export const runCodex = createCodexRunner();
