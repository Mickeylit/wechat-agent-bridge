import fs from 'node:fs';
import path from 'node:path';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { environmentValue, resolveBinary } from './config.mjs';

const PACKAGES = Object.freeze({ codex: '@openai/codex', claude: '@anthropic-ai/claude-code' });

function unsupported() {
  return Object.assign(new Error('不能直接执行自定义 .cmd/.bat 启动脚本。请配置原生 .exe，或使用正常安装的 @openai/codex / @anthropic-ai/claude-code。'), { code: 'UNSUPPORTED_LAUNCH' });
}

/** Return an argv-safe invocation. Batch files are never passed to a shell. */
export function resolveLaunch(binary, args = [], options = {}) {
  const { platform = process.platform, env = process.env, fs: filesystem = fs,
    cwd = process.cwd(), execPath = process.execPath } = options;
  if (typeof binary !== 'string' || !binary.trim() || !Array.isArray(args)) throw unsupported();
  if (platform !== 'win32') return { command: binary, args: [...args] };

  const paths = path.win32;
  const command = paths.isAbsolute(binary) && /\.(exe|com|cmd|bat)$/i.test(binary)
    ? paths.normalize(binary) : resolveBinary(binary, env, { platform, fs: filesystem, cwd });
  const extension = paths.extname(command).toLowerCase();
  if (extension === '.exe' || extension === '.com') return { command, args: [...args] };
  if (extension !== '.cmd' && extension !== '.bat') throw unsupported();

  const tool = paths.basename(command).slice(0, -extension.length).toLowerCase();
  const packageName = PACKAGES[tool];
  if (!packageName) throw unsupported();
  const binDirectory = paths.dirname(command);
  // npm global: <prefix>/codex.cmd and <prefix>/node_modules/@openai/codex.
  // npm local: <project>/node_modules/.bin/codex.cmd and sibling package folder.
  const modules = paths.basename(binDirectory).toLowerCase() === '.bin'
    ? paths.dirname(binDirectory) : paths.join(binDirectory, 'node_modules');
  const packageRoot = paths.join(modules, ...packageName.split('/'));
  try {
    const metadata = JSON.parse(filesystem.readFileSync(paths.join(packageRoot, 'package.json'), 'utf8'));
    if (metadata.name !== packageName) throw unsupported();
    const entry = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.[tool];
    if (typeof entry !== 'string' || !entry || paths.isAbsolute(entry) || /^[a-z]:/i.test(entry)) throw unsupported();
    const entryPath = paths.resolve(packageRoot, entry);
    const relative = paths.relative(packageRoot, entryPath);
    if (relative === '..' || relative.startsWith('..\\') || paths.isAbsolute(relative)) throw unsupported();
    if (!filesystem.statSync(entryPath).isFile()) throw unsupported();
    const entryExtension = paths.extname(entryPath).toLowerCase();
    if (['.js', '.cjs', '.mjs'].includes(entryExtension)) {
      return { command: execPath, args: [entryPath, ...args] };
    }
    // Current Claude npm packages can install a native executable as their bin.
    if (entryExtension === '.exe' || entryExtension === '.com') return { command: entryPath, args: [...args] };
  } catch { throw unsupported(); }
  throw unsupported();
}

/** Stop descendants too; injectable operations make tests safe on any host OS. */
export function killProcessTree(child, signal = 'SIGTERM', options = {}) {
  const { platform = process.platform, env = process.env, spawnSync = nodeSpawnSync,
    kill = process.kill.bind(process) } = options;
  const pid = child?.pid;
  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      if (platform === 'win32') {
        const root = environmentValue(env, 'SystemRoot', platform) || 'C:\\Windows';
        const taskkill = path.win32.join(root, 'System32', 'taskkill.exe');
        const result = spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], {
          shell: false, windowsHide: true, stdio: 'ignore', timeout: 3000,
        });
        if (!result.error && result.status === 0) return true;
      } else {
        kill(-pid, signal);
        return true;
      }
    } catch { /* fall back if the process exited or the tree helper is unavailable */ }
  }
  try { return typeof child?.kill === 'function' && child.kill(signal) !== false; } catch { return false; }
}
