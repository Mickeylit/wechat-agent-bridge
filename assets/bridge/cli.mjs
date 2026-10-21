#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import { WeixinClient } from './lib/weixin.mjs';
import { Store, readJson, writeJson, lock, isAlive } from './lib/store.mjs';
import { Bridge } from './lib/bridge.mjs';
import { createCodexRunner } from './lib/codex.mjs';
import { createClaudeRunner, REQUIRED_CLAUDE_FLAGS, MIN_CLAUDE_VERSION } from './lib/claude.mjs';
import { loadConfig, resolveBinary, launchAgentPath, selectEngine } from './lib/config.mjs';
import { openQrPage } from './lib/qr-page.mjs';
import { resolveLaunch } from './lib/process.mjs';
import { windowsService } from './lib/windows-service.mjs';
import { secureStateDirectory, createStopMonitor, requestGracefulStop, saveServiceConfig, runServiceWorker } from './lib/windows-runtime.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const runtimeVersion = readJson(path.join(root, 'package.json'), {}).version || 'unknown';
const stateFlag = process.argv.indexOf('--state-dir');
if (stateFlag !== -1 && (!process.argv[stateFlag + 1] || !path.isAbsolute(process.argv[stateFlag + 1]))) throw new Error('--state-dir 必须是绝对目录。');
const configEnv = stateFlag === -1 ? process.env : { ...process.env, WECHAT_BRIDGE_STATE_DIR: process.argv[stateFlag + 1] };
const config = loadConfig(root, configEnv);
const { stateDir, label, engine, engineName } = config;
const authFile = path.join(stateDir, 'auth.json');
const log = text => console.log(`[${new Date().toISOString()}] ${text}`);

async function login() {
  secureStateDirectory(stateDir);
  if (isAlive(readJson(path.join(stateDir, 'bridge.lock'), {}).pid)) throw new Error('请先运行 node cli.mjs stop-service，再重新扫码。');
  const unlock = lock(stateDir, 'account');
  const client = new WeixinClient({});
  let readline;
  let lastStatus;
  let verifyCode;
  let qr;
  let refreshes = 0;
  const maxRefreshes = process.argv.includes('--web') ? 15 : 5;
  const deadline = Date.now() + (process.argv.includes('--web') ? 30 : 10) * 60_000;
  const view = { state: 'preparing', message: '正在生成二维码', revision: 0, png: null };
  let page;
  const stop = new AbortController();
  const onStop = () => stop.abort();
  process.once('SIGINT', onStop);
  process.once('SIGTERM', onStop);
  const refresh = async () => {
    if (++refreshes > maxRefreshes) throw new Error('二维码已多次过期，请重新运行 npm run login。');
    client.setBaseUrl('https://ilinkai.weixin.qq.com');
    qr = await client.getQr();
    if (!qr.qrcode || !qr.qrcode_img_content) throw new Error('微信未返回可用二维码。');
    const qrPath = path.join(stateDir, `login-qr-${Date.now()}.png`);
    view.png = await QRCode.toBuffer(qr.qrcode_img_content, { width: 600, margin: 3, errorCorrectionLevel: 'M' });
    fs.writeFileSync(qrPath, view.png, { mode: 0o600 });
    for (const name of fs.readdirSync(stateDir)) if (/^login-qr-\d+\.png$/.test(name) && name !== path.basename(qrPath)) fs.rmSync(path.join(stateDir, name));
    Object.assign(view, { state: 'wait', message: '请用手机微信扫码确认', revision: Date.now() });
    writeJson(path.join(stateDir, 'login-view.json'), { qrPath, generatedAt: new Date().toISOString() });
    log(`QR_READY ${qrPath}`);
    log('请用手机微信扫一扫并确认连接。');
    verifyCode = undefined;
    lastStatus = undefined;
  };
  try {
    if (process.argv.includes('--web')) { page = await openQrPage(() => view); log(`LOGIN_PAGE ${page.url}`); }
    await refresh();
    while (Date.now() < deadline && !stop.signal.aborted) {
      let result;
      try { result = await client.getQrStatus(qr.qrcode, verifyCode); }
      catch { await delay(1500); continue; }
      if (result.status !== lastStatus) {
        log(`LOGIN_STATUS ${result.status}`);
        lastStatus = result.status;
        view.state = result.status;
        view.message = ({ wait: '请用手机微信扫码确认', scaned: '已扫码，请在手机确认', need_verifycode: '请在登录终端输入手机显示的数字', expired: '二维码已过期，正在刷新' })[result.status] || '正在连接';
      }
      if (result.status === 'confirmed') {
        if (!result.bot_token || !result.ilink_bot_id || !result.ilink_user_id) throw new Error('登录响应缺少凭证或扫码者身份，未保存登录。');
        client.setBaseUrl(result.baseurl || 'https://ilinkai.weixin.qq.com');
        const previous = readJson(authFile, null);
        const store = new Store(stateDir);
        // A new login starts a fresh upstream inbox; old context tokens cannot be reused.
        if (store.data.jobs.length) {
          writeJson(path.join(stateDir, `pending-before-login-${Date.now()}.json`), store.data.jobs);
          log('旧登录下未发出的回答已保存在本地归档，请重新发送对应问题。');
          store.data.jobs = [];
        }
        if (previous?.ownerId !== result.ilink_user_id) store.data.threadId = null;
        store.data.cursor = '';
        store.save();
        writeJson(authFile, { token: result.bot_token, botId: result.ilink_bot_id, ownerId: result.ilink_user_id, baseUrl: result.baseurl || 'https://ilinkai.weixin.qq.com', boundAt: new Date().toISOString() });
        for (const name of fs.readdirSync(stateDir)) if (/^login-qr-\d+\.png$/.test(name)) fs.rmSync(path.join(stateDir, name));
        fs.rmSync(path.join(stateDir, 'login-view.json'), { force: true });
        view.png = null;
        log('LOGIN_SUCCESS 微信扫码绑定成功。');
        // Pairing and polling share one account lock; hand it off only after
        // credentials and queue changes have been committed.
        unlock();
        if (process.argv.includes('--auto-start')) await service('install-service');
        Object.assign(view, { state: 'connected', message: process.argv.includes('--auto-start') ? '已连接并启动服务，请在微信发送问题' : '已绑定，请启动服务后在微信发送问题' });
        if (page) await delay(5000);
        return;
      }
      if (result.status === 'need_verifycode') {
        readline ||= createInterface({ input: process.stdin, output: process.stdout, terminal: false });
        verifyCode = (await readline.question('VERIFY_CODE_REQUIRED 请输入手机微信显示的数字：\n', { signal: stop.signal })).trim();
        if (!/^\d{1,12}$/.test(verifyCode)) { log('请输入手机显示的数字验证码。'); verifyCode = undefined; }
        continue;
      }
      if (result.status === 'scaned') verifyCode = undefined;
      if (result.status === 'scaned_but_redirect' && result.redirect_host) client.setBaseUrl(`https://${result.redirect_host}`);
      if (result.status === 'expired' || result.status === 'verify_code_blocked') await refresh();
      if (result.status === 'binded_redirect') throw new Error('微信显示已绑定其他现有实例，请在微信中重新连接后再扫码。');
      await delay(1000);
    }
    throw new Error('等待扫码超时，请重新运行 npm run login。');
  } finally {
    readline?.close();
    if (page) await page.close();
    process.removeListener('SIGINT', onStop);
    process.removeListener('SIGTERM', onStop);
    unlock();
  }
}

async function start() {
  secureStateDirectory(stateDir);
  const unlockAccount = lock(stateDir, 'account');
  try {
  const auth = readJson(authFile, null);
  if (!auth?.token || !auth.ownerId) throw new Error('请先运行 npm run login 完成微信扫码。');
  const client = new WeixinClient({ baseUrl: auth.baseUrl, token: auth.token });
  const binary = resolveBinary(config.binary);
  const runAgent = engine === 'codex' ? createCodexRunner({ binary }) : createClaudeRunner({ binary });
  const unlock = lock(stateDir);
  const controller = new AbortController();
  try {
  const store = new Store(stateDir);
  selectEngine(store, engine);
  const cwd = path.join(stateDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const stop = () => controller.abort();
  const bridge = new Bridge({ client, store, ownerId: auth.ownerId, runAgent, engineName, cwd, log, signal: controller.signal });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const stopMonitor = createStopMonitor(stateDir, controller);
  log(`微信 ${engineName} 服务已启动，正在等待你的消息。`);
  try {
    await bridge.run();
  } catch (error) {
    if (error.code === -14) {
      log('需要重新扫码绑定。服务已停止。');
      writeJson(path.join(stateDir, 'runtime.json'), { state: 'login_required', stoppedAt: new Date().toISOString() });
    } else { throw error; }
  } finally {
    controller.abort();
    await bridge.processor;
    try { await client.notifyStop(); } catch {}
    stopMonitor();
  }
  } finally { unlock(); }
  } finally { unlockAccount(); }
}

function status() {
  const auth = readJson(authFile, null);
  const state = new Store(stateDir).data;
  const runtime = readJson(path.join(stateDir, 'runtime.json'), {});
  const pid = readJson(path.join(stateDir, 'bridge.lock'), {}).pid;
  console.log(JSON.stringify({ runtimeVersion, bound: !!auth?.token, running: isAlive(pid), requiresLogin: runtime.state === 'login_required', pending: state.jobs.length,
    engine, hasConversation: !!state.threadId, lastPollAt: state.lastPollAt || null, lastReplyAt: state.lastReplyAt || null,
    lastReplyKind: state.lastReplyKind || null, lastModelReplyAt: state.lastModelReplyAt || null, stateDirectory: stateDir }, null, 2));
}

async function service(action) {
  if (process.platform === 'win32') {
    if (action === 'stop-service') {
      await requestGracefulStop(stateDir);
      windowsService({ action: 'stop', root, stateDir, label, nodePath: process.execPath, binary: config.binary, engine });
      log('Windows 后台任务已停止并移除。');
      return;
    }
    if (!readJson(authFile, null)?.token) throw new Error('请先扫码登录，再安装后台服务。');
    // Complete all local validation before replacing a scheduled task.
    const binary = resolveBinary(config.binary);
    resolveLaunch(binary);
    secureStateDirectory(stateDir);
    await requestGracefulStop(stateDir);
    saveServiceConfig({ root, stateDir, label, engine, binary });
    windowsService({ action: 'install', root, stateDir, label, nodePath: process.execPath, binary, engine });
    log('Windows 后台任务已安装并启动；当前用户登录后会自动运行。');
    return;
  }
  if (process.platform !== 'darwin') throw new Error('自动后台服务支持 Windows 和 macOS；其他系统请使用 npm start 或自己的进程管理器。');
  const domain = `gui/${process.getuid()}`;
  const plistPath = launchAgentPath(label);
  const run = args => spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  if (fs.existsSync(plistPath) && !fs.readFileSync(plistPath, 'utf8').includes(`<string>${xml(path.join(root, 'cli.mjs'))}</string>`)) {
    throw new Error('发现其他目录安装的同名服务，请先检查现有安装。');
  }
  if (action === 'stop-service') {
    run(['bootout', `${domain}/${label}`]);
    // Prevent the stopped service from restarting at the next login.
    fs.rmSync(plistPath, { force: true });
    log('后台服务已停止，已取消开机登录后自动启动。');
    return;
  }
  if (!readJson(authFile, null)?.token) throw new Error('请先扫码登录，再安装后台服务。');
  const binary = resolveBinary(config.binary);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  const logPath = path.join(stateDir, 'service.log');
  fs.closeSync(fs.openSync(logPath, 'a', 0o600));
  fs.chmodSync(logPath, 0o600);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(root, 'cli.mjs'))}</string><string>start</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml([path.dirname(binary),path.dirname(process.execPath),'/usr/local/bin','/opt/homebrew/bin','/usr/bin','/bin','/usr/sbin','/sbin'].join(':'))}</string><key>WECHAT_BRIDGE_STATE_DIR</key><string>${xml(stateDir)}</string><key>WECHAT_BRIDGE_ENGINE</key><string>${engine}</string><key>${engine === 'codex' ? 'CODEX_BIN' : 'CLAUDE_BIN'}</key><string>${xml(binary)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(path.join(stateDir, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(stateDir, 'service.log'))}</string>
</dict></plist>\n`;
  fs.writeFileSync(plistPath, plist, { mode: 0o600 });
  run(['bootout', `${domain}/${label}`]);
  const result = run(['bootstrap', domain, plistPath]);
  if (result.status !== 0) throw new Error(`启动后台服务失败（launchctl ${result.status}），可先用 npm start 在前台运行。`);
  log('后台服务已安装并启动；Mac 登录后会自动运行。');
}

function doctor() {
  const binary = resolveBinary(config.binary);
  const versionLaunch = resolveLaunch(binary, ['--version']);
  const result = spawnSync(versionLaunch.command, versionLaunch.args, { encoding: 'utf8', timeout: 10000, shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error('CLI 无法启动，请在终端检查安装。');
  const report = { runtimeVersion, engine, binary, launcher: versionLaunch.command, platform: process.platform, backgroundService: ({ win32: 'Windows Task Scheduler', darwin: 'macOS launchd' })[process.platform] || 'foreground only', node: process.version, nodeSupported: Number(process.versions.node.split('.')[0]) >= 24, cliVersion: result.stdout.trim().split('\n')[0].slice(0, 160), stateDir, authentication: '请在本机 CLI 完成登录；doctor 不调用模型。' };
  if (engine === 'claude') {
    const helpLaunch = resolveLaunch(binary, ['--help']);
    const help = spawnSync(helpLaunch.command, helpLaunch.args, { encoding: 'utf8', timeout: 10000, shell: false, windowsHide: true });
    report.missingFlags = REQUIRED_CLAUDE_FLAGS.filter(flag => !help.stdout?.includes(flag));
    if (help.status !== 0 || report.missingFlags.length) { console.log(JSON.stringify(report, null, 2)); throw new Error(`请升级 Claude Code 至支持所列参数的版本（至少 ${MIN_CLAUDE_VERSION}）。`); }
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.nodeSupported) throw new Error('需要 Node.js 24 或更高版本。');
}

try {
  const command = process.argv[2] || 'status';
  if (command === 'login') await login();
  else if (command === 'start') await start();
  else if (command === 'status') status();
  else if (command === 'doctor') doctor();
  else if (command === 'install-service' || command === 'stop-service') await service(command);
  else if (command === 'service-run') process.exitCode = await runServiceWorker({ root, stateDir });
  else throw new Error('可用命令：doctor、login [--web] [--auto-start]、start、status、install-service、stop-service');
} catch (error) {
  // Only controlled error messages are exposed; transport errors are redacted by the client.
  log(`未完成：${error.message}`);
  process.exitCode = 1;
}
