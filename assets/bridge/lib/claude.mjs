import { spawn as nodeSpawn } from 'node:child_process';
import { resolveLaunch, killProcessTree } from './process.mjs';

const MAX_LINE_LENGTH = 4 * 1024 * 1024;
const WECHAT_INSTRUCTIONS = '你正在通过微信回答用户问题。默认使用简洁清楚的中文，保留必要上下文。仅回答问题，不执行命令、不读写本地文件、不向第三方发送消息，也不输出内部推理或工具日志。';

// --permission-prompts requires >=2.1.259. Check flags as well: --safe-mode
// availability is documented without an explicit minimum version.
export const MIN_CLAUDE_VERSION = '2.1.259';
export const REQUIRED_CLAUDE_FLAGS = Object.freeze([
  '--print', '--output-format', '--verbose', '--tools', '--disallowedTools',
  '--permission-mode', '--permission-prompts', '--safe-mode',
  '--append-system-prompt', '--resume',
]);

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Injection is for process-isolated tests; production uses runClaude below. */
export function createClaudeRunner({ spawn = nodeSpawn, binary = process.env.CLAUDE_BIN || 'claude', platform = process.platform, ...processOptions } = {}) {
  return function runClaude({ prompt, threadId, cwd, signal, onThread, timeoutMs = 180000 } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return Promise.reject(failure('INVALID_PROMPT', '请输入要问 Claude 的问题。'));
    }
    if (threadId != null && (typeof threadId !== 'string' || !threadId.trim())) {
      return Promise.reject(failure('INVALID_THREAD', 'Claude 会话标识无效，请开始新对话。'));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(failure('INVALID_TIMEOUT', 'Claude 超时配置无效。'));
    }
    if (signal?.aborted) {
      return Promise.reject(Object.assign(failure('ABORTED', '已停止本次回答。'), { name: 'AbortError' }));
    }

    // --tools only controls built-in tools, so deny MCP tools separately.
    // Safe mode retains normal login while avoiding user/project customizations.
    const args = ['-p', '--output-format', 'stream-json', '--verbose',
      '--safe-mode', '--tools', '', '--disallowedTools', 'mcp__*',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      '--append-system-prompt', WECHAT_INSTRUCTIONS];
    if (threadId) args.push('--resume', threadId);

    return new Promise((resolve, reject) => {
      let child;
      try {
        const launch = resolveLaunch(binary, args, { ...processOptions, platform });
        child = spawn(launch.command, launch.args, {
          cwd, shell: false, detached: platform !== 'win32', windowsHide: true,
          env: processOptions.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        if (error.code === 'UNSUPPORTED_LAUNCH') { reject(error); return; }
        reject(failure('START_FAILED', '无法启动本机 Claude Code，请检查安装及登录状态。'));
        return;
      }

      let buffer = '';
      let resultThreadId = threadId;
      let notifiedThreadId;
      let text = '';
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
      const timeout = setTimeout(() => stop(failure('TIMEOUT', 'Claude 回答超时，请稍后重试或缩短问题。')), timeoutMs);

      const recordThread = (id) => {
        if (typeof id !== 'string' || !id.trim()) return;
        resultThreadId = id;
        if (!onThread || notifiedThreadId === id) return;
        notifiedThreadId = id;
        threadCallback = threadCallback.then(() => onThread(id)).catch(() => {
          stop(failure('STATE_FAILED', '无法保存 Claude 会话，请检查本地存储。'));
        });
      };
      const parseLine = (line) => {
        if (!line.trim() || stoppingError || settled) return;
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event?.type === 'system' && event.subtype === 'init') recordThread(event.session_id);
        if (event?.type === 'result') {
          recordThread(event.session_id);
          // Error results may contain raw API responses. Never forward their text.
          if (event.subtype !== 'success' || event.is_error !== false) {
            turnFailed = true;
            return;
          }
          if (typeof event.result === 'string') {
            text = event.result;
            completed = true;
          }
        }
        if (event?.type === 'error') turnFailed = true;
        // Assistant/thinking/tool messages and token deltas are intentionally ignored.
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
            stop(failure('OUTPUT_LIMIT', 'Claude 输出过大，请缩小问题范围。'));
            return;
          }
          parseLine(line);
        }
        if (buffer.length > MAX_LINE_LENGTH) stop(failure('OUTPUT_LIMIT', 'Claude 输出过大，请缩小问题范围。'));
      });
      child.stderr.resume();
      child.stdin.on('error', () => {
        if (!settled && !stoppingError) stop(failure('INPUT_FAILED', '无法把问题交给 Claude，请重试。'));
      });
      child.on('error', () => finish(failure('START_FAILED', '无法启动本机 Claude Code，请检查安装及登录状态。')));
      child.on('close', async (code) => {
        parseLine(buffer);
        await threadCallback;
        if (stoppingError) return finish(stoppingError);
        if (code !== 0 || turnFailed) {
          return finish(failure('CLAUDE_FAILED', 'Claude Code 本次调用失败。请检查登录、网络与额度，并升级到支持 --safe-mode 和 --permission-prompts 的版本后重试。'));
        }
        if (!completed || !text.trim() || !resultThreadId) {
          return finish(failure('NO_ANSWER', 'Claude 没有返回完整回答，请重试。'));
        }
        finish(undefined, { text: text.trim(), threadId: resultThreadId });
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      if (!stoppingError) child.stdin.end(`请回答以下微信消息：\n\n${prompt}\n`);
      else child.stdin.end();
    });
  };
}

export const runClaude = createClaudeRunner();
