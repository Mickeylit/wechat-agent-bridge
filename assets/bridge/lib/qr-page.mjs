import http from 'node:http';
import { randomBytes } from 'node:crypto';

// Local display only: credentials and pairing-code submission never enter HTTP.
export async function openQrPage(getView) {
  const nonce = randomBytes(18).toString('base64');
  let host;
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>微信连接</title>
<style nonce="${nonce}">body{font-family:system-ui;margin:40px auto;padding:0 24px;max-width:600px;background:#fafaf7;color:#17271e;text-align:center}h1{font-size:30px}img{width:min(90vw,400px);height:auto;background:white;border-radius:16px}p{line-height:1.7}#status{font-weight:600}</style>
<h1>连接微信</h1><p>用手机微信「扫一扫」扫描。二维码过期后会自动更新。</p><img id="qr" alt="正在生成二维码" hidden><p id="status">正在准备连接…</p><p>如果手机显示数字验证码，请在电脑的登录终端输入，或告诉正在帮你配置的助手。</p>
<script nonce="${nonce}">let revision=null;let done=false;async function poll(){try{const r=await fetch('/status',{cache:'no-store'});if(!r.ok)throw Error();const s=await r.json();document.getElementById('status').textContent=s.message;const img=document.getElementById('qr');if(s.revision&&s.revision!==revision){img.src='/qr.png?v='+encodeURIComponent(s.revision);revision=s.revision;}img.hidden=!s.showQr;done=s.state==='connected'||s.state==='failed';}catch{document.getElementById('status').textContent='扫码服务已停止。若尚未连接，请重新运行登录命令。';done=true;}if(!done)setTimeout(poll,1500);}poll();</script></html>`;
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', `default-src 'none'; img-src 'self'; connect-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`);
    if (req.headers.host !== host || req.method !== 'GET') { res.writeHead(403).end(); return; }
    let url;
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new Error('Invalid request target');
      url = new URL(req.url, `http://${host}`);
    } catch { res.writeHead(400).end(); return; }
    const view = getView();
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
    else if (url.pathname === '/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ state: view.state, message: view.message, revision: view.revision, showQr: !!view.png && !['connected', 'failed'].includes(view.state) }));
    } else if (url.pathname === '/qr.png' && view.png && !['connected', 'failed'].includes(view.state)) {
      res.setHeader('Content-Type', 'image/png'); res.end(view.png);
    } else res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  host = `127.0.0.1:${server.address().port}`;
  return { url: `http://${host}/`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
