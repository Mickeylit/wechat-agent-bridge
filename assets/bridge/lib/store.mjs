import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.data = readJson(this.file, { cursor: '', threadId: null, jobs: [], seen: [] });
    this.lastSaved = JSON.stringify(this.data);
  }
  save() {
    try {
      writeJson(this.file, this.data);
      this.lastSaved = JSON.stringify(this.data);
    } catch {
      this.data = JSON.parse(this.lastSaved);
      throw Object.assign(new Error('无法保存消息状态，服务已停止以避免漏发或重复处理。'), { code: 'STATE_FAILED' });
    }
  }
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export function lock(dir, name = 'bridge') {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${name}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const before = fs.statSync(file);
        let owner;
        try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (readError) { if (!(readError instanceof SyntaxError)) throw readError; }
        const validPid = Number.isInteger(owner?.pid) && owner.pid > 0;
        if (validPid && isAlive(owner.pid)) throw new Error('服务已经运行。');
        // A concurrent starter may have created the file but not written its PID yet.
        if (!validPid && Date.now() - before.mtimeMs < 10_000) {
          throw new Error('服务正在启动或锁文件尚未写完，请等待 10 秒后重试。');
        }
        const current = fs.statSync(file);
        if (before.ino === current.ino && before.mtimeMs === current.mtimeMs) fs.unlinkSync(file);
      } catch (inspectError) {
        if (inspectError.code !== 'ENOENT') throw inspectError;
      }
      continue;
    }
    const token = randomUUID();
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
    } catch (error) {
      try { fs.unlinkSync(file); } catch {}
      throw error;
    } finally { fs.closeSync(fd); }
    return () => {
      try { if (readJson(file, {}).token === token) fs.unlinkSync(file); } catch {}
    };
  }
  throw new Error('无法取得服务锁。');
}
