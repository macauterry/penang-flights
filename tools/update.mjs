// 인천 ⇄ 페낭 최저가를 날짜별로 조금씩 새로 알아보고 data/prices.json 에 저장하는 파일입니다.
//
// - 조건: 싱가포르항공·말레이시아항공·대한항공만 / 경유 1회 이하 / 경유 대기 1시간 40분~3시간
// - 무료 조회 횟수(월 250회)를 다 쓰지 않도록, 남은 횟수와 초기화 날짜를 보고 "오늘 쓸 만큼"만 씁니다.
// - 가장 오래 확인 안 한 날짜(특히 가까운 날짜)부터 순서대로 새로 고칩니다.
//
// 실행:  node tools/update.mjs            (자동으로 정한 횟수만큼)
//        node tools/update.mjs --max 3    (최대 3회만)
//        node tools/update.mjs --dry-run  (조회는 안 하고 무엇을 알아볼지만 보여줌)
//        node tools/update.mjs --notify-test  (휴대폰 테스트 알림만 보냄)

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = join(ROOT, 'data', 'prices.json');
const DAY = 86_400_000;

// 로컬 PC에서 돌릴 때는 상위 폴더(비행기표)의 .env 에서 키를 읽습니다.
for (const p of [join(ROOT, '.env'), join(ROOT, '..', '.env')]) {
  if (!process.env.SERPAPI_KEY && existsSync(p)) {
    try { process.loadEnvFile(p); } catch { /* 형식 오류는 무시 */ }
  }
}

const args = process.argv.slice(2);
const argMax = args.includes('--max') ? Number(args[args.indexOf('--max') + 1]) : null;
const dryRun = args.includes('--dry-run');
const notifyTest = args.includes('--notify-test');

const key = String(process.env.SERPAPI_KEY || '').trim();

// ── 날짜 도우미 (한국 시각 기준) ─────────────────────────────
function todayKst() {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
}
function addDays(iso, n) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
}

// ── SerpApi ─────────────────────────────────────────────────
async function quota() {
  const res = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(key)}`);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`SerpApi 계정 확인 실패: ${j.error || res.status}`);
  return {
    left: j.total_searches_left ?? j.plan_searches_left ?? 0,
    perMonth: j.searches_per_month ?? null,
    renewal: j.plan_renewal_date || null,
    plan: j.plan_name || '',
  };
}

async function searchOneWay(cfg, route, date) {
  const params = new URLSearchParams({
    engine: 'google_flights',
    departure_id: route.from,
    arrival_id: route.to,
    outbound_date: date,
    type: '2',
    currency: cfg.currency,
    hl: 'ko',
    gl: 'kr',
    adults: String(cfg.adults),
    travel_class: '1',
    stops: String(Math.min(3, cfg.maxStops + 1)), // 2 = 경유 1회 이하
    include_airlines: cfg.airlines.join(','),
    layover_duration: `${cfg.layoverMinMinutes},${cfg.layoverMaxMinutes}`,
    deep_search: 'true',
    api_key: key,
  });
  const res = await fetch(`https://serpapi.com/search.json?${params}`);
  const json = await res.json().catch(() => ({}));
  if (json.error) {
    // "결과 없음"은 오류가 아니라 그날 조건에 맞는 표가 없다는 뜻입니다.
    if (/hasn't returned any results|no results/i.test(json.error)) return [];
    const e = new Error(json.error);
    e.fatal = /api_key|run out|exceeded|limit/i.test(json.error);
    throw e;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return [...(json.best_flights || []), ...(json.other_flights || [])];
}

// 구글 결과 한 건 → 앱에서 쓰는 작은 형태. 조건에 안 맞으면 null.
function toOption(cfg, raw) {
  const price = Number(raw.price);
  const flights = raw.flights || [];
  if (!(price > 0) || !flights.length) return null;

  const segs = flights.map((f) => {
    const m = /^\s*([0-9A-Z]{2})\s*(\d{1,4})/i.exec(String(f.flight_number || ''));
    return {
      no: m ? `${m[1].toUpperCase()}${m[2]}` : String(f.flight_number || ''),
      al: m ? m[1].toUpperCase() : '',
      from: f.departure_airport?.id || '',
      to: f.arrival_airport?.id || '',
      dep: String(f.departure_airport?.time || ''),
      arr: String(f.arrival_airport?.time || ''),
      min: Number(f.duration) || 0,
      plane: f.airplane || '',
    };
  });
  const lays = (raw.layovers || []).map((l) => ({ at: l.id || '', min: Number(l.duration) || 0, overnight: Boolean(l.overnight) }));

  // 구글에 조건을 넘겼지만 한 번 더 확인합니다.
  if (segs.length - 1 > cfg.maxStops) return null;
  if (!segs.every((s) => cfg.airlines.includes(s.al))) return null;
  if (!lays.every((l) => l.min >= cfg.layoverMinMinutes && l.min <= cfg.layoverMaxMinutes)) return null;

  const total = Number(raw.total_duration) || segs.reduce((s, x) => s + x.min, 0) + lays.reduce((s, x) => s + x.min, 0);
  return { price, total, airlines: [...new Set(segs.map((s) => s.al))], segs, lays };
}

// ── 어떤 날짜를 먼저 알아볼지 ──────────────────────────────────
// 가까운 날짜일수록 값이 자주 바뀌므로 더 자주 새로 고칩니다.
function refreshIntervalDays(daysAhead) {
  if (daysAhead <= 14) return 3;
  if (daysAhead <= 30) return 6;
  return 10;
}

function pickTargets(cfg, data, today, count) {
  const items = [];
  for (const route of cfg.routes) {
    for (let d = cfg.daysAheadMin; d <= cfg.daysAheadMax; d++) {
      const date = addDays(today, d);
      const entry = data.routes[route.id]?.[date];
      let score;
      if (!entry) {
        // 처음 보는 날짜: 달력이 고르게 채워지도록 흩어서 고릅니다 (황금비 간격).
        score = 1000 + ((d * 0.6180339887) % 1);
      } else {
        const ageDays = (Date.now() - Date.parse(entry.checkedAt)) / DAY;
        score = ageDays / refreshIntervalDays(d);
      }
      items.push({ route, date, daysAhead: d, score });
    }
  }
  items.sort((a, b) => b.score - a.score);
  // 두 방향이 번갈아 나오도록 섞습니다.
  const byRoute = cfg.routes.map((r) => items.filter((i) => i.route.id === r.id));
  const out = [];
  while (out.length < count && byRoute.some((l) => l.length)) {
    for (const list of byRoute) if (list.length && out.length < count) out.push(list.shift());
  }
  return out;
}

// ── 메인 ───────────────────────────────────────────────────
async function loadData() {
  try {
    return JSON.parse(await readFile(DATA_FILE, 'utf8'));
  } catch {
    return { version: 1, meta: {}, routes: {}, events: [] };
  }
}

async function saveData(data) {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, DATA_FILE);
}

function lowestOf(routeData) {
  let low = null;
  for (const [date, e] of Object.entries(routeData || {})) {
    if (e.price && (!low || e.price < low.price)) low = { date, price: e.price };
  }
  return low;
}

async function sendNtfy({ title, message, tags = [], priority = 3 }) {
  const topic = String(process.env.NTFY_TOPIC || '').trim();
  if (!topic) return false;
  try {
    const res = await fetch('https://ntfy.sh/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic, title, message, tags, priority,
        ...(process.env.APP_URL ? { click: process.env.APP_URL } : {}),
      }),
    });
    return res.ok;
  } catch (err) {
    console.warn('알림 전송 실패:', err.message);
    return false;
  }
}

async function notify(events, cfg) {
  if (!events.length) return;
  const label = (id) => cfg.routes.find((r) => r.id === id)?.label || id;
  const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
  const lines = events.slice(0, 6).map((e) =>
    e.type === 'newLow'
      ? `🏆 ${label(e.route)} ${e.date} 최저가 ${won(e.price)}`
      : `▼ ${label(e.route)} ${e.date} ${won(e.prev)} → ${won(e.price)}`
  );
  const ok = await sendNtfy({ title: '인천⇄페낭 항공권 가격 소식', message: lines.join('\n'), tags: ['airplane'], priority: 4 });
  if (ok) console.log(`휴대폰 알림 보냄 (${lines.length}줄)`);
}

async function main() {
  if (notifyTest) {
    const ok = await sendNtfy({ title: '페낭 항공권 알림 연결 완료', message: '이제 인천⇄페낭 새 최저가나 5% 이상 가격이 내리면 이 알림으로 알려드립니다.', tags: ['white_check_mark', 'airplane'] });
    console.log(ok ? '테스트 알림을 보냈습니다.' : 'NTFY_TOPIC이 없거나 전송에 실패했습니다.');
    return;
  }
  const cfg = JSON.parse(await readFile(join(ROOT, 'config.json'), 'utf8'));
  const data = await loadData();
  const today = todayKst();
  const now = new Date().toISOString();

  // 지난 날짜 정리
  for (const route of cfg.routes) {
    const rd = (data.routes[route.id] ||= {});
    for (const date of Object.keys(rd)) if (date < today) delete rd[date];
  }

  if (!key) {
    console.error('SERPAPI_KEY가 없습니다. 비행기표/.env 파일(또는 GitHub Secrets)에 넣어 주세요.');
    process.exitCode = 1;
    return;
  }

  const q = await quota();
  const daysLeft = q.renewal ? Math.max(1, daysBetween(today, q.renewal)) : 30;
  const spendable = Math.max(0, q.left - cfg.reserveSearches);
  let count = Math.floor(spendable / (daysLeft * cfg.runsPerDay));
  count = Math.min(cfg.maxPerRun, Math.max(0, count));
  if (argMax != null && Number.isFinite(argMax)) count = Math.min(argMax, Math.max(0, q.left - 5));

  const targets = pickTargets(cfg, data, today, count);
  console.log(`남은 조회 ${q.left}회 · 초기화 ${q.renewal} (${daysLeft}일 남음) · 예비 ${cfg.reserveSearches}회 → 이번에 ${targets.length}회 조회`);
  for (const t of targets) console.log(`  - ${t.route.label} ${t.date} (${t.daysAhead}일 뒤)`);

  if (dryRun) return;

  const lowBefore = Object.fromEntries(cfg.routes.map((r) => [r.id, lowestOf(data.routes[r.id])]));
  const events = [];
  let calls = 0;
  const errors = [];

  for (const t of targets) {
    const rd = data.routes[t.route.id];
    const prev = rd[t.date];
    let raw;
    try {
      raw = await searchOneWay(cfg, t.route, t.date);
      calls += 1;
    } catch (err) {
      calls += 1;
      errors.push(`${t.route.id} ${t.date}: ${err.message}`);
      console.warn(`  ✖ ${t.route.label} ${t.date}: ${err.message}`);
      if (err.fatal) break;
      continue;
    }

    const options = raw
      .map((r) => toOption(cfg, r))
      .filter(Boolean)
      .sort((a, b) => a.price - b.price || a.total - b.total);
    // 같은 편명 조합이 겹치면 하나만 남깁니다.
    const seen = new Set();
    const unique = options.filter((o) => {
      const k = o.segs.map((s) => s.no).join('+');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 4);

    const price = unique[0]?.price ?? null;
    const history = [...(prev?.history || []), { t: now, p: price }].slice(-12);
    rd[t.date] = { checkedAt: now, price, options: unique, history };

    if (price && prev?.price && price <= prev.price * (1 - cfg.dropAlertPercent / 100)) {
      events.push({ type: 'drop', route: t.route.id, date: t.date, price, prev: prev.price, at: now });
    }
    console.log(`  ✔ ${t.route.label} ${t.date}: ${price ? `${price.toLocaleString('ko-KR')}원 (${unique.length}건)` : '조건에 맞는 항공편 없음'}`);
  }

  for (const route of cfg.routes) {
    const after = lowestOf(data.routes[route.id]);
    const before = lowBefore[route.id];
    if (after && (!before || after.price < before.price)) {
      events.push({ type: 'newLow', route: route.id, date: after.date, price: after.price, prev: before?.price ?? null, at: now });
    }
  }

  let left = q.left - calls;
  try { left = (await quota()).left; } catch { /* 추정값 사용 */ }

  data.meta = {
    updatedAt: now,
    today,
    quota: { left, perMonth: q.perMonth, renewal: q.renewal, plan: q.plan },
    lastRun: { calls, errors },
    conditions: {
      airlines: cfg.airlines,
      maxStops: cfg.maxStops,
      layoverMinMinutes: cfg.layoverMinMinutes,
      layoverMaxMinutes: cfg.layoverMaxMinutes,
      daysAheadMin: cfg.daysAheadMin,
      daysAheadMax: cfg.daysAheadMax,
    },
    routes: cfg.routes,
  };
  data.events = [...events, ...(data.events || [])].slice(0, 30);

  await saveData(data);
  await notify(events, cfg);
  console.log(`저장 완료 · 조회 ${calls}회 사용 · 남은 ${left}회 · 새 소식 ${events.length}건`);
}

main().catch((err) => {
  console.error('업데이트 실패:', err.message);
  process.exitCode = 1;
});
