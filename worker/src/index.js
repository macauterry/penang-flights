// 인천⇄페낭 앱의 작은 서버 (Cloudflare Worker)
//
// 하는 일
//  1) 앱의 항공권 조회를 SerpApi로 전달합니다. 비밀 키는 여기에만 있고 앱(휴대폰)에는 없습니다.
//     - PIN이 맞아야만 전달, 구글 플라이트 조회만 허용, 하루 조회 한도로 무료 횟수 보호
//  2) 앱이 저장한 "내 일정"과 최신 결과를 보관합니다 (KV 저장소)
//  3) 매일 아침 저장한 일정의 가격을 다시 확인하고, 바뀌면 휴대폰(ntfy)으로 알립니다
//  4) 링깃(RM) → 원 환율을 알려줍니다
//
// 필요한 설정: KV 바인딩 STORE / 비밀값 SERPAPI_KEY, APP_PIN, NTFY_TOPIC / 변수 APP_URL, ALLOWED_ORIGINS

const SERP = 'https://serpapi.com/search.json';
const ALLOWED_PARAMS = new Set([
  'departure_id', 'arrival_id', 'outbound_date', 'return_date', 'type', 'currency', 'hl', 'gl', 'adults',
  'travel_class', 'stops', 'include_airlines', 'layover_duration', 'deep_search', 'departure_token',
  'booking_token', 'json_restrictor', 'max_duration',
]);
const DAILY_CAP = 80; // 하루에 서버가 대신 조회해 줄 최대 횟수
const RESERVE = 15; // 이만큼은 남겨 두고 더 이상 조회하지 않음

const kstDate = (ms = Date.now()) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);

function cors(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-App-Pin',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

async function quota(env) {
  const r = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(env.SERPAPI_KEY)}`);
  const j = await r.json();
  return { left: j.total_searches_left ?? j.plan_searches_left ?? 0, perMonth: j.searches_per_month ?? null, renewal: j.plan_renewal_date || null };
}

async function bumpCounter(env, n = 1) {
  const k = `count:${kstDate()}`;
  const used = Number((await env.STORE.get(k)) || 0);
  if (used + n > DAILY_CAP) return false;
  await env.STORE.put(k, String(used + n), { expirationTtl: 3 * 86400 });
  return true;
}

async function serp(env, params) {
  const p = new URLSearchParams({ engine: 'google_flights', ...params, api_key: env.SERPAPI_KEY });
  return fetch(`${SERP}?${p}`);
}

async function fxRate(env) {
  const cached = await env.STORE.get('fx', 'json');
  if (cached && Date.now() - cached.at < 12 * 3_600_000) return cached;
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/MYR');
    const j = await r.json();
    const krw = Number(j?.rates?.KRW);
    if (krw > 0) {
      const v = { krw, at: Date.now(), source: 'open.er-api.com' };
      await env.STORE.put('fx', JSON.stringify(v));
      return v;
    }
  } catch { /* 아래 기본값 */ }
  return cached || { krw: 320, at: 0, source: '기본값' };
}

async function ntfy(env, title, message, tags = ['airplane']) {
  if (!env.NTFY_TOPIC) return;
  await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message, tags, priority: 4, ...(env.APP_URL ? { click: env.APP_URL } : {}) }),
  }).catch(() => {});
}

// ── 매일 가격 재확인 ─────────────────────────────────────────
// 저장된 결과의 항공사별 "최저가 날짜"를 한 번씩만 다시 조회합니다 (보통 조회 2~3회).
const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

function cheapestFor(jsonData, airline, layMin, layMax) {
  const all = [...(jsonData.best_flights || []), ...(jsonData.other_flights || [])];
  let best = null;
  for (const o of all) {
    const price = Number(o.price);
    if (!(price > 0)) continue;
    if (!(o.flights || []).every((f) => String(f.flight_number || '').toUpperCase().startsWith(airline))) continue;
    if (layMin != null && !(o.layovers || []).every((l) => l.duration >= layMin && l.duration <= layMax)) continue;
    if (!best || price < best.price) best = { price, flights: o.flights.map((f) => f.flight_number).join('+') };
  }
  return best;
}

async function recheck(env, { manual = false } = {}) {
  const state = await env.STORE.get('state', 'json');
  if (!state?.result?.airlines) return { skipped: '저장된 일정이 없습니다' };

  const q = await quota(env);
  const plans = [];
  const groups = new Map();
  for (const a of state.result.airlines) {
    if (!a.best || !a.sel || a.sel.noReturn) continue;
    const dest = a.code === 'KE' ? 'KUL' : 'PEN';
    const key = `${dest}|${a.best.out}|${a.best.back}`;
    if (!groups.has(key)) groups.set(key, { dest, out: a.best.out, back: a.best.back, codes: [] });
    groups.get(key).codes.push(a.code);
  }
  plans.push(...groups.values());
  if (!plans.length) return { skipped: '다시 확인할 항공권이 없습니다' };

  // 자동 재확인은 무료 횟수를 아끼며 합니다 (남은 횟수가 적으면 쉬기)
  const daysLeft = q.renewal ? Math.max(1, Math.round((Date.parse(q.renewal) - Date.parse(kstDate())) / 86400000)) : 30;
  if (!manual && (q.left - 40) / daysLeft < plans.length * 0.5) return { skipped: `남은 조회 ${q.left}회라 오늘은 쉽니다` };
  if (q.left - plans.length < RESERVE) return { skipped: '남은 조회 횟수가 부족합니다' };

  const c = state.result.conditions || { layoverMin: 100, layoverMax: 180 };
  const changes = [];
  const now = new Date().toISOString();
  for (const plan of plans) {
    if (!(await bumpCounter(env))) break;
    const isKE = plan.dest === 'KUL';
    const res = await serp(env, {
      departure_id: 'ICN', arrival_id: plan.dest, outbound_date: plan.out, return_date: plan.back, type: '1',
      currency: 'KRW', hl: 'ko', gl: 'kr', adults: '1', deep_search: 'false',
      include_airlines: plan.codes.join(','), stops: isKE ? '1' : '2',
      ...(isKE ? {} : { layover_duration: `${c.layoverMin},${c.layoverMax}` }),
      json_restrictor: 'best_flights,other_flights',
    });
    const data = await res.json().catch(() => ({}));
    for (const code of plan.codes) {
      const a = state.result.airlines.find((x) => x.code === code);
      const found = cheapestFor(data, code, isKE ? null : c.layoverMin, c.layoverMax);
      // 같은 방식으로 잰 직전 값과만 비교합니다 (첫 확인은 기준만 저장)
      const prev = a.watch?.price ?? null;
      a.watch = { price: found?.price ?? null, at: now, flights: found?.flights || '' };
      a.watchHistory = [...(a.watchHistory || []), { t: now, p: found?.price ?? null }].slice(-30);
      if (found?.price && prev && Math.abs(found.price - prev) >= Math.max(10000, prev * 0.03)) {
        changes.push(`${found.price < prev ? '▼' : '▲'} ${a.name} ${md(plan.out)}~${md(plan.back)} ${won(prev)} → ${won(found.price)}`);
      }
    }
  }
  state.lastRecheck = { at: now, changes };
  await env.STORE.put('state', JSON.stringify(state));

  const fx = await fxRate(env);
  if (changes.length) {
    await ntfy(env, '페낭 왕복 항공권 가격 변동', `${changes.join('\n')}\n(1링깃 ≈ ${Math.round(fx.krw)}원)`);
  } else if (manual) {
    await ntfy(env, '페낭 왕복 항공권 가격 확인', '저장한 일정의 가격 변동이 없습니다.', ['white_check_mark']);
  }
  return { checked: plans.length, changes };
}

export default {
  async fetch(req, env, ctx) {
    const h = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const url = new URL(req.url);

    if (url.pathname === '/api/health') return json({ ok: true }, 200, h);

    if (!env.APP_PIN || req.headers.get('X-App-Pin') !== env.APP_PIN) {
      return json({ error: 'PIN이 맞지 않습니다' }, 401, h);
    }

    try {
      // 구글 플라이트 조회 전달 (응답은 손대지 않고 그대로 흘려보냄)
      if (url.pathname === '/api/serp' && req.method === 'POST') {
        const body = await req.json();
        const params = {};
        for (const [k, v] of Object.entries(body || {})) if (ALLOWED_PARAMS.has(k) && v != null && v !== '') params[k] = String(v);
        if (!params.departure_id && !params.booking_token) return json({ error: '잘못된 요청' }, 400, h);
        if (!(await bumpCounter(env))) return json({ error: `오늘 조회 한도(${DAILY_CAP}회)를 넘었습니다. 내일 다시 해 주세요.` }, 429, h);
        const upstream = await serp(env, params);
        return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...h } });
      }

      if (url.pathname === '/api/quota') {
        const [q, fx, used] = await Promise.all([quota(env), fxRate(env), env.STORE.get(`count:${kstDate()}`)]);
        return json({ ...q, fx, usedToday: Number(used || 0), dailyCap: DAILY_CAP, reserve: RESERVE }, 200, h);
      }

      if (url.pathname === '/api/state' && req.method === 'GET') {
        return json((await env.STORE.get('state', 'json')) || {}, 200, h);
      }

      if (url.pathname === '/api/state' && req.method === 'POST') {
        const body = await req.text();
        if (body.length > 400_000) return json({ error: '너무 큽니다' }, 413, h);
        const state = JSON.parse(body);
        state.savedAt = new Date().toISOString();
        await env.STORE.put('state', JSON.stringify(state));
        return json({ ok: true, savedAt: state.savedAt }, 200, h);
      }

      if (url.pathname === '/api/recheck' && req.method === 'POST') {
        return json(await recheck(env, { manual: true }), 200, h);
      }

      return json({ error: 'not found' }, 404, h);
    } catch (err) {
      return json({ error: err.message || String(err) }, 500, h);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(recheck(env));
  },
};
