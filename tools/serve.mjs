// 내 PC에서 앱을 켜는 파일입니다.  실행: node tools/serve.mjs
// - 같은 와이파이의 휴대폰에서도 접속할 수 있게 주소를 알려줍니다.
// - 가격 업데이트는 GitHub가 매일 하므로 여기서는 하지 않습니다.
//   (GitHub 없이 PC로만 쓸 때는 .env 에 PENANG_LOCAL_UPDATE=true 를 넣으면 매일 7시 이후 업데이트)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const p of [join(ROOT, '.env'), join(ROOT, '..', '.env')]) {
  try { process.loadEnvFile(p); } catch { /* 없으면 무시 */ }
}
const PORT = Number(process.env.PENANG_PORT || 3100);
const UPDATE_HOUR_KST = 7;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const HIDDEN = new Set(['tools', '.github', 'node_modules']);

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    const top = path.split('/')[1] || '';
    if (!file.startsWith(ROOT + sep) || HIDDEN.has(top) || top.startsWith('.') || path.endsWith('config.json')) {
      res.writeHead(404).end('not found');
      return;
    }
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not file');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n✈️  인천⇄페낭 최저가 앱이 켜졌습니다');
  console.log(`   이 PC:   http://localhost:${PORT}`);
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`   휴대폰:  http://${n.address}:${PORT}   (같은 와이파이일 때)`);
    }
  }
  console.log('   끄려면 이 창을 닫거나 Ctrl + C\n');
});

// ── 매일 자동 업데이트 ─────────────────────────────────────
let running = false;
async function lastUpdateDateKst() {
  try {
    const d = JSON.parse(await readFile(join(ROOT, 'data', 'prices.json'), 'utf8'));
    return d.meta?.updatedAt ? new Date(Date.parse(d.meta.updatedAt) + 9 * 3_600_000).toISOString().slice(0, 10) : '';
  } catch {
    return '';
  }
}
async function maybeUpdate() {
  if (running) return;
  const kst = new Date(Date.now() + 9 * 3_600_000);
  const today = kst.toISOString().slice(0, 10);
  if (kst.getUTCHours() < UPDATE_HOUR_KST || (await lastUpdateDateKst()) === today) return;
  running = true;
  console.log(`[${today}] 오늘 가격 업데이트를 시작합니다…`);
  const child = spawn(process.execPath, [join(ROOT, 'tools', 'update.mjs')], { stdio: 'inherit' });
  child.on('exit', () => { running = false; });
}
if (String(process.env.PENANG_LOCAL_UPDATE || '').toLowerCase() === 'true') {
  maybeUpdate();
  setInterval(maybeUpdate, 30 * 60_000);
}
