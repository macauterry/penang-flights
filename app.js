// 인천⇄페낭 왕복 항공권 앱
// 여행 기간(가는 날 ±며칠, 오는 날 ±며칠)을 넣으면 말레이시아항공·싱가포르항공·대한항공 왕복을 각각 조회하고,
// 대한항공은 쿠알라룸푸르↔페낭 이동수단까지 계산하고, 고른 항공권의 실제 예약처로 바로 연결합니다.
(() => {
  'use strict';

  const DEFAULT_API = 'https://penang-flights.debonair-eustoma.workers.dev';
  const LAYOVER = { min: 100, max: 180 };
  const AIRLINES = {
    MH: { ko: '말레이시아항공', en: 'Malaysia Airlines', dest: 'PEN', site: 'https://www.malaysiaairlines.com/kr/ko.html', hub: '쿠알라룸푸르' },
    SQ: { ko: '싱가포르항공', en: 'Singapore Airlines', dest: 'PEN', site: 'https://www.singaporeair.com/ko_KR/kr/home', hub: '싱가포르' },
    KE: { ko: '대한항공', en: 'Korean Air', dest: 'KUL', site: 'https://www.koreanair.com/', hub: '' },
  };
  const AIRPORTS = { ICN: '인천', PEN: '페낭', KUL: '쿠알라룸푸르', SIN: '싱가포르' };

  // 사용자가 자주 쓰는 구매처.
  //  match = 구글이 알려준 판매처 이름을 이 규칙과 맞춰 봅니다 (이름이 영어로 와도 한글로 바꿔 보여주려고)
  //  link  = 그 사이트에서 "이 일정"을 직접 확인할 때 열 주소
  //  exact = 날짜·구간까지 주소에 담을 수 있으면 true (항공사 공식 홈페이지는 봇 차단 때문에 불가능)
  const MY_SITES = [
    {
      key: 'trip', name: '트립닷컴', exact: true, match: /trip\.?com|ctrip|씨트립|트립닷컴/i,
      link: (t) => (t
        ? `https://kr.trip.com/flights/showfarefirst?dcity=${t.from.toLowerCase()}&acity=${t.to.toLowerCase()}&ddate=${t.out}&rdate=${t.back}&triptype=rt&class=y&quantity=1&locale=ko-KR&curr=KRW`
        : 'https://kr.trip.com/flights/'),
    },
    {
      key: 'agoda', name: '아고다', exact: true, match: /agoda|아고다/i,
      link: (t) => (t
        ? `https://www.agoda.com/ko-kr/flights/results?departureFrom=${t.from}&arrivalTo=${t.to}&departDate=${t.out}&returnDate=${t.back}&searchType=2&cabinType=Economy&adults=1`
        : 'https://www.agoda.com/ko-kr/flights'),
    },
    { key: 'KE', name: '대한항공 공식', airline: 'KE', match: /korean ?air|대한항공/i, link: () => 'https://www.koreanair.com/booking/search?tripType=RT' },
    { key: 'SQ', name: '싱가포르항공 공식', airline: 'SQ', match: /singapore ?air|싱가포르항공/i, link: () => 'https://www.singaporeair.com/ko_KR/kr/book-a-trip/' },
    { key: 'MH', name: '말레이시아항공 공식', airline: 'MH', match: /malaysia ?air|말레이시아항공/i, link: () => 'https://www.malaysiaairlines.com/kr/ko/home.html' },
  ];
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  const PRE_TRIP = 150; // 집 → 인천공항 30분 + 출발 2시간 전 도착
  const POST_PEN = 60; // 페낭공항 도착 → 집 (짐 찾기 + 택시)

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const store = {
    get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가 */ } },
  };

  // PIN 은 주소 뒤 #pin=... 으로 한 번 넘겨받아 저장합니다.
  (() => {
    const m = /(?:^|[#&])pin=([^&]+)/.exec(location.hash);
    if (m) {
      store.set('pin', decodeURIComponent(m[1]));
      history.replaceState(null, '', location.pathname + location.search);
    }
    const api = /(?:^|[?&])api=([^&]+)/.exec(location.search);
    if (api) store.set('api', decodeURIComponent(api[1]));
  })();
  const API = () => store.get('api') || DEFAULT_API;

  let state = { trip: null, result: null, lastRecheck: null, log: [] };
  const logFilter = { code: 'ALL', dir: 'out' };
  let quota = null;
  let busy = false;
  let groundTab = 'out';
  const vendorCache = new Map(); // 항공사코드 → 판매처 원본 (예약 화면으로 넘기는 값, 새로고침하면 사라짐)

  // ── 표시 도우미 ───────────────────────────────────────
  const parseD = (iso) => new Date(`${iso}T00:00:00Z`);
  const addDays = (iso, n) => new Date(parseD(iso).getTime() + n * 86400000).toISOString().slice(0, 10);
  const mdw = (iso) => { const d = parseD(iso); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${DOW[d.getUTCDay()]})`; };
  const md = (iso) => { const d = parseD(iso); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
  const won = (n) => (n == null ? '가격 미공개' : `${Math.round(n).toLocaleString('ko-KR')}원`);
  const man = (n) => (n / 10000).toFixed(1);
  const hm = (min) => `${Math.floor(min / 60)}시간${min % 60 ? ` ${min % 60}분` : ''}`;
  const hhmm = (t) => String(t).slice(11, 16);
  const todayKst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const stamp = (iso) => {
    const k = new Date(Date.parse(iso) + 9 * 3600000);
    return `${k.getUTCMonth() + 1}/${k.getUTCDate()} ${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
  };
  const googleQ = (q) => `https://www.google.com/travel/flights?hl=ko&curr=KRW&q=${encodeURIComponent(q)}`;

  // ── 서버 호출 ─────────────────────────────────────────
  async function api(path, body) {
    const pin = store.get('pin');
    if (!pin) throw Object.assign(new Error('PIN이 필요합니다'), { needPin: true });
    const res = await fetch(`${API()}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-App-Pin': pin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw Object.assign(new Error('PIN이 맞지 않습니다'), { needPin: true });
    if (!res.ok || data.error) throw new Error(data.error || `서버 오류 (${res.status})`);
    return data;
  }

  const serp = (params) => api('/api/serp', { currency: 'KRW', hl: 'ko', gl: 'kr', adults: '1', deep_search: 'false', ...params });

  function baseParams(code, out, back) {
    const a = AIRLINES[code];
    const p = { departure_id: 'ICN', arrival_id: a.dest, outbound_date: out, return_date: back, type: '1' };
    if (code === 'KE') return { ...p, include_airlines: 'KE', stops: '1' };
    return { ...p, include_airlines: 'MH,SQ', stops: '2', layover_duration: `${LAYOVER.min},${LAYOVER.max}` };
  }

  // 구글 결과 한 건 → 작은 형태
  function toOpt(raw) {
    const segs = (raw.flights || []).map((f) => {
      const m = /^\s*([0-9A-Z]{2})\s*(\d{1,4})/i.exec(String(f.flight_number || ''));
      return {
        no: m ? `${m[1].toUpperCase()}${m[2]}` : String(f.flight_number || ''),
        al: m ? m[1].toUpperCase() : '',
        from: f.departure_airport?.id || '', to: f.arrival_airport?.id || '',
        dep: String(f.departure_airport?.time || ''), arr: String(f.arrival_airport?.time || ''),
        min: Number(f.duration) || 0, plane: f.airplane || '',
      };
    });
    const lays = (raw.layovers || []).map((l) => ({ at: l.id || '', min: Number(l.duration) || 0, overnight: Boolean(l.overnight) }));
    const price = Number(raw.price) > 0 ? Number(raw.price) : null;
    const total = Number(raw.total_duration) || segs.reduce((s, x) => s + x.min, 0) + lays.reduce((s, x) => s + x.min, 0);
    const codes = [...new Set(segs.map((s) => s.al))];
    return { price, total, code: codes.length === 1 ? codes[0] : null, segs, lays, token: raw.departure_token || '', btoken: raw.booking_token || '' };
  }
  function fits(o, code) {
    if (o.code !== code) return false;
    if (code === 'KE') return o.segs.length === 1;
    return o.segs.length <= 2 && o.lays.every((l) => l.min >= LAYOVER.min && l.min <= LAYOVER.max);
  }
  const flightsKey = (o) => o.segs.map((s) => s.no).join('+');
  const listOf = (data) => [...(data.best_flights || []), ...(data.other_flights || [])].map(toOpt);

  async function pool(tasks, n, onDone) {
    let i = 0;
    const workers = Array.from({ length: n }, async () => {
      while (i < tasks.length) {
        const t = tasks[i++];
        await t();
        onDone();
      }
    });
    await Promise.all(workers);
  }

  // ── 검색 ─────────────────────────────────────────────
  function readTrip() {
    return {
      out: $('outDate').value,
      outFlex: Number($('outFlex').value),
      back: $('backDate').value,
      backFlex: Number($('backFlex').value),
      includeKE: $('incKE').checked,
    };
  }
  function combosOf(trip) {
    const outs = [];
    const backs = [];
    for (let d = -trip.outFlex; d <= trip.outFlex; d++) outs.push(addDays(trip.out, d));
    for (let d = -trip.backFlex; d <= trip.backFlex; d++) backs.push(addDays(trip.back, d));
    const min = addDays(todayKst(), 1);
    const combos = [];
    for (const o of outs) for (const b of backs) if (o >= min && b > o) combos.push({ out: o, back: b });
    return { outs: outs.filter((o) => o >= min), backs, combos };
  }
  function estimate(trip) {
    const { combos } = combosOf(trip);
    const codes = trip.includeKE ? 3 : 2;
    return { combos: combos.length, calls: combos.length * (trip.includeKE ? 2 : 1) + codes };
  }

  function updateEstimate() {
    const trip = readTrip();
    const el = $('estimate');
    if (!trip.out || !trip.back) { el.textContent = '가는 날과 오는 날을 골라 주세요.'; return; }
    if (trip.back <= trip.out) { el.textContent = '오는 날이 가는 날보다 뒤여야 합니다.'; return; }
    const e = estimate(trip);
    const left = quota?.left;
    const warn = left != null && left - e.calls < (quota.reserve || 15);
    el.innerHTML = `날짜 조합 <b>${e.combos}개</b> · 조회 <b>${e.calls}회</b> 사용${left != null ? ` (남은 ${left}회 → 약 ${left - e.calls}회)` : ''}${warn ? ' · <span class="bad">남은 횟수가 부족합니다. ±일수를 줄여 주세요</span>' : ''}`;
    $('searchBtn').disabled = busy || warn || e.combos === 0;
  }

  function progress(done, total, label) {
    $('progress').hidden = false;
    $('progressBar').style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
    $('progressText').textContent = `${label} ${done}/${total}`;
  }

  async function runSearch() {
    const trip = readTrip();
    const { outs, backs, combos } = combosOf(trip);
    if (!combos.length || busy) return;
    const e = estimate(trip);
    if (!confirm(`조회 ${e.calls}회를 사용해 ${combos.length}개 날짜 조합을 알아봅니다. 진행할까요?`)) return;

    busy = true;
    updateEstimate();
    const codes = ['MH', 'SQ', ...(trip.includeKE ? ['KE'] : [])];
    const result = {
      createdAt: new Date().toISOString(), trip, outs, backs,
      conditions: { layoverMin: LAYOVER.min, layoverMax: LAYOVER.max },
      airlines: codes.map((code) => ({ code, name: AIRLINES[code].ko, matrix: {}, best: null, sel: null })),
      errors: [],
    };
    const byCode = Object.fromEntries(result.airlines.map((a) => [a.code, a]));

    const tasks = [];
    for (const c of combos) {
      const key = `${c.out}|${c.back}`;
      tasks.push(async () => {
        try {
          const data = await serp(baseParams('MH', c.out, c.back));
          const opts = listOf(data);
          for (const code of ['MH', 'SQ']) {
            const mine = opts.filter((o) => fits(o, code)).sort((a, b) => (a.price ?? 1e12) - (b.price ?? 1e12));
            byCode[code].matrix[key] = { price: mine.find((o) => o.price)?.price ?? null, opts: mine };
          }
        } catch (err) { result.errors.push(`${md(c.out)}~${md(c.back)} MH/SQ: ${err.message}`); if (err.needPin) throw err; }
      });
      if (trip.includeKE) {
        tasks.push(async () => {
          try {
            const data = await serp(baseParams('KE', c.out, c.back));
            const mine = listOf(data).filter((o) => fits(o, 'KE')).sort((a, b) => (a.price ?? 1e12) - (b.price ?? 1e12));
            byCode.KE.matrix[key] = { price: mine.find((o) => o.price)?.price ?? null, opts: mine };
          } catch (err) { result.errors.push(`${md(c.out)}~${md(c.back)} KE: ${err.message}`); if (err.needPin) throw err; }
        });
      }
    }

    try {
      let done = 0;
      progress(0, tasks.length, '날짜 조합 조회 중');
      await pool(tasks, 4, () => progress(++done, tasks.length, '날짜 조합 조회 중'));

      // 항공사별 최저가 날짜 → 오는 편까지 확정
      const centerKey = `${trip.out}|${trip.back}`;
      let d2 = 0;
      progress(0, result.airlines.length, '오는 편 확정 중');
      await Promise.all(result.airlines.map(async (a) => {
        const cells = Object.entries(a.matrix).filter(([, v]) => v.opts.length);
        if (cells.length) {
          const priced = cells.filter(([, v]) => v.price).sort((x, y) => x[1].price - y[1].price);
          const [key, cell] = priced[0] || cells.find(([k]) => k === centerKey) || cells[0];
          const [out, back] = key.split('|');
          const opt = cell.opts.find((o) => o.price === cell.price) || cell.opts[0];
          a.best = { out, back, price: cell.price, flights: flightsKey(opt) };
          try { a.sel = await detail(a.code, out, back, opt); } catch (err) { result.errors.push(`${a.name} 오는 편: ${err.message}`); }
          if (a.sel?.price) { a.best.price = a.sel.price; cell.price = a.sel.price; cell.confirmed = true; }
        }
        progress(++d2, result.airlines.length, '오는 편 확정 중');
      }));

      state.result = result;
      state.trip = trip;
      store.set('trip', JSON.stringify(trip));
      render();
      await saveState();
      $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      if (err.needPin) askPin(err.message);
      else alert(`조회 중 문제가 생겼습니다: ${err.message}`);
    } finally {
      busy = false;
      $('progress').hidden = true;
      refreshQuota();
    }
  }

  // 가는 편 하나를 골라 오는 편을 확정합니다 (조회 1회, 실패 시 다시 조회 +1회)
  async function detail(code, out, back, opt) {
    const base = baseParams(code, out, back);
    let data;
    try {
      data = await serp({ ...base, departure_token: opt.token });
      if (data.error) throw new Error(data.error);
    } catch {
      const fresh = listOf(await serp(base)).find((o) => flightsKey(o) === flightsKey(opt));
      if (!fresh) throw new Error('이 항공편이 더 이상 조회되지 않습니다');
      data = await serp({ ...base, departure_token: fresh.token });
    }
    const rets = listOf(data).filter((o) => fits(o, code)).sort((a, b) => (a.price ?? 1e12) - (b.price ?? 1e12));
    const ret = rets[0];
    if (!ret) {
      const other = listOf(data).filter((o) => o.code === code).sort((a, b) => (a.price ?? 1e12) - (b.price ?? 1e12))[0];
      return {
        out, back, price: null, outOpt: { ...opt, token: '' }, retOpt: null, returns: [], noReturn: true,
        noReturnNote: other ? `조건 밖 오는 편: ${other.segs.map((x) => x.no).join('+')} (${other.lays.map((l) => `대기 ${hm(l.min)}`).join(', ') || '직항'})` : '',
        bookingToken: '', googleUrl: data.search_metadata?.google_flights_url || '', at: new Date().toISOString(),
      };
    }
    return {
      out, back, price: ret.price, outOpt: { ...opt, token: '' }, retOpt: { ...ret, token: '' },
      returns: rets.slice(1).map((r) => ({ ...r, token: '' })),
      bookingToken: ret.btoken, googleUrl: data.search_metadata?.google_flights_url || '', at: new Date().toISOString(),
    };
  }

  async function saveState() {
    try { mergeLog(); await api('/api/state', { trip: state.trip, result: state.result, log: state.log }); } catch { /* 저장 실패해도 화면은 유지 */ }
  }

  // ── 전체 항공편 기록 ─────────────────────────────────
  // 검색·확정할 때 본 모든 항공편(편명·출발시각·경유·가격)을 모아 두고, 다음 검색 결과와 합칩니다.
  function logEntries(r) {
    const out = [];
    const now = r.createdAt || new Date().toISOString();
    for (const a of r.airlines || []) {
      for (const [key, cell] of Object.entries(a.matrix || {})) {
        const [o, b] = key.split('|');
        for (const opt of cell.opts || []) out.push({ dir: 'out', date: o, pairDate: b, code: a.code, opt, price: opt.price, at: now });
      }
      const sel = a.sel;
      if (sel && !sel.noReturn && sel.retOpt) {
        for (const opt of [sel.retOpt, ...(sel.returns || [])]) {
          out.push({ dir: 'in', date: sel.back, pairDate: sel.out, code: a.code, opt, price: opt.price, at: sel.at || now });
        }
      }
    }
    return out;
  }

  function mergeLog() {
    const map = new Map();
    const put = (e) => {
      const f = e.opt || e;
      if (!f.segs?.length) return;
      const item = {
        dir: e.dir, date: e.date, code: e.code,
        segs: f.segs.map((x) => ({ no: x.no, from: x.from, to: x.to, dep: x.dep, arr: x.arr, min: x.min })),
        lays: (f.lays || []).map((l) => ({ at: l.at, min: l.min })),
        total: f.total,
        prices: { ...(e.prices || {}) },
        at: e.at,
      };
      if (e.price && e.pairDate) item.prices[e.pairDate] = e.price;
      const k = `${item.dir}|${item.date}|${item.segs.map((x) => x.no).join('+')}`;
      const prev = map.get(k);
      if (prev) {
        item.prices = { ...prev.prices, ...item.prices };
        if (prev.at > item.at) item.at = prev.at;
      }
      map.set(k, item);
    };
    (state.log || []).forEach(put);
    if (state.result) logEntries(state.result).forEach(put);
    const today = todayKst();
    state.log = [...map.values()].filter((e) => e.date >= today).slice(-600);
  }

  function renderLog() {
    mergeLog();
    const f = logFilter;
    const rows = state.log
      .filter((e) => e.dir === f.dir && (f.code === 'ALL' || e.code === f.code))
      .sort((x, y) => (x.date === y.date ? (x.segs[0].dep < y.segs[0].dep ? -1 : 1) : x.date < y.date ? -1 : 1));
    const tabs = (items, key) => items.map(([v, label]) => `<button data-logf="${key}|${v}" aria-selected="${f[key] === v}">${label}</button>`).join('');
    let html = `<div class="seg small">${tabs([['out', '가는 편 (인천 출발)'], ['in', '오는 편 (말레이시아 출발)']], 'dir')}</div>
      <div class="seg small">${tabs([['ALL', '전체'], ['MH', '말레이시아'], ['SQ', '싱가포르'], ['KE', '대한항공']], 'code')}</div>`;
    if (!rows.length) {
      html += `<p class="empty">${f.dir === 'in' ? '오는 편은 날짜를 확정한 것(검색 후 자동 확정, 또는 날짜표 칸 누르기)만 기록됩니다.' : '아직 기록이 없습니다.'}</p>`;
    } else {
      let lastDate = '';
      html += '<div class="log">';
      for (const e of rows) {
        if (e.date !== lastDate) {
          html += `<div class="log-date">${mdw(e.date)}</div>`;
          lastDate = e.date;
        }
        const first = e.segs[0];
        const last = e.segs[e.segs.length - 1];
        const plus = last.arr.slice(0, 10) > first.dep.slice(0, 10) ? '<small>+1</small>' : '';
        const prices = Object.values(e.prices || {}).sort((x, y) => x - y);
        const priceTxt = prices.length
          ? `${won(prices[0])}${prices.length > 1 && prices[prices.length - 1] !== prices[0] ? ` <span class="muted small">~${won(prices[prices.length - 1])}</span>` : ''}`
          : '<span class="muted small">가격 미공개</span>';
        const legs = e.segs.map((x, i) => {
          const lay = e.lays[i] ? ` · <b>${esc(AIRPORTS[e.lays[i].at] || e.lays[i].at)} 대기 ${hm(e.lays[i].min)}</b>` : '';
          return `${esc(x.no)} ${hhmm(x.dep)} ${esc(AIRPORTS[x.from] || x.from)} → ${hhmm(x.arr)} ${esc(AIRPORTS[x.to] || x.to)}${lay}`;
        }).join('<br>');
        html += `<div class="log-row">
          <div class="log-main">
            <span class="log-dep">${hhmm(first.dep)}</span>
            <span class="log-fn">${e.segs.map((x) => esc(x.no)).join(' → ')}</span>
            <span class="tag">${esc(AIRLINES[e.code]?.ko || e.code)}</span>
          </div>
          <div class="log-sub">${legs}</div>
          <div class="log-foot"><span>총 ${hm(e.total)} · 도착 ${hhmm(last.arr)}${plus}</span><span>왕복 ${priceTxt}</span></div>
        </div>`;
      }
      const latest = rows.reduce((m, e) => (e.at > m ? e.at : m), rows[0].at);
      html += `</div><p class="note">${rows.length}개 · 왕복 1인 가격 (같은 편이라도 짝이 되는 날짜에 따라 달라서 최저~최고로 표시) · 마지막 확인 ${stamp(latest)}</p>`;
    }
    $('flightLog').innerHTML = html;
  }

  // ── 그리기 ───────────────────────────────────────────
  function segHtml(o) {
    let h = '';
    const d0 = o.segs[0]?.dep.slice(0, 10);
    o.segs.forEach((s, j) => {
      const plus = s.arr.slice(0, 10) > d0 ? '<small>+1</small>' : '';
      h += `<div class="leg"><span class="no">${esc(s.no)}</span><span class="t">${hhmm(s.dep)} ${esc(AIRPORTS[s.from] || s.from)} → ${hhmm(s.arr)}${plus} ${esc(AIRPORTS[s.to] || s.to)} <span class="muted">· 비행 ${hm(s.min)}</span></span></div>`;
      if (o.lays[j]) h += `<div class="lay">⏱ ${esc(AIRPORTS[o.lays[j].at] || o.lays[j].at)}에서 ${hm(o.lays[j].min)} 대기${o.lays[j].overnight ? ' (밤샘)' : ''}</div>`;
    });
    return h;
  }
  function flySummary(o) {
    const f = o.segs[0];
    const l = o.segs[o.segs.length - 1];
    const plus = l.arr.slice(0, 10) > f.dep.slice(0, 10) ? '+1' : '';
    const lay = o.lays.length ? `${AIRPORTS[o.lays[0].at] || o.lays[0].at} ${hm(o.lays[0].min)} 대기` : '직항';
    return { time: `${hhmm(f.dep)} → ${hhmm(l.arr)}${plus}`, lay, total: hm(o.total), nos: o.segs.map((x) => x.no).join('·') };
  }

  // 대한항공: 가장 빠른 "집 도착" 육상 수단
  function keGround(sel) {
    if (!sel?.outOpt?.segs?.length || !window.Ground) return null;
    const arr = sel.outOpt.segs[sel.outOpt.segs.length - 1].arr;
    const dep = sel.retOpt?.segs?.[0]?.dep;
    const g = window.Ground.outbound(arr);
    const gi = dep ? window.Ground.inbound(dep) : null;
    const fastest = g.options.filter((o) => o.ok && o.home).sort((a, b) => a.home - b.home)[0];
    const cheapest = g.options.filter((o) => o.ok).sort((a, b) => a.rm[0] - b.rm[0])[0];
    return { g, gi, fastest, cheapest };
  }

  function renderCompare() {
    const r = state.result;
    const fx = quota?.fx?.krw || 320;
    const prices = r.airlines.map((a) => a.sel?.price).filter(Boolean);
    const low = prices.length ? Math.min(...prices) : null;
    const cards = r.airlines.map((a) => {
      const s = a.sel;
      if (!s) return `<button class="cmp-card off" data-jump="${a.code}"><div class="cmp-top"><b>${esc(a.name)}</b><span class="muted">조건에 맞는 항공편 없음</span></div></button>`;
      if (s.noReturn) {
        const f = flySummary(s.outOpt);
        return `<button class="cmp-card off" data-jump="${a.code}"><div class="cmp-top"><b>${esc(a.name)}</b><span class="bad small">오는 편 조건 불충족</span></div>
          <div class="cmp-row">가는 편 ${mdw(s.out)} <b>${esc(f.nos)}</b> ${f.time} · ${esc(f.lay)}</div><div class="cmp-row muted">${mdw(s.back)} 오는 편 중 대기 ${hm(LAYOVER.min)}~${hm(LAYOVER.max)}인 편이 없음</div></button>`;
      }
      const fo = flySummary(s.outOpt);
      const fr = flySummary(s.retOpt);
      let door = s.outOpt.total + PRE_TRIP + POST_PEN;
      let extra = '';
      if (a.code === 'KE') {
        const k = keGround(s);
        if (k?.fastest) {
          door = s.outOpt.total + PRE_TRIP + (k.fastest.home - k.g.arrival);
          extra = `<div class="cmp-row muted">+ 쿠알라룸푸르→페낭 ${esc(k.fastest.name)} 약 ${won(k.fastest.rm[0] * fx)}부터</div>`;
        }
      }
      return `<button class="cmp-card${s.price === low ? ' best' : ''}" data-jump="${a.code}">
        <div class="cmp-top"><b>${esc(a.name)}${s.price === low ? ' <span class="tag">최저</span>' : ''}</b><span class="price">${won(s.price)}</span></div>
        <div class="cmp-row"><span class="lbl">가는 편</span>${mdw(s.out)} <b>${esc(fo.nos)}</b> ${fo.time} · ${esc(fo.lay)} · 총 ${fo.total}</div>
        <div class="cmp-row"><span class="lbl">오는 편</span>${mdw(s.back)} <b>${esc(fr.nos)}</b> ${fr.time} · ${esc(fr.lay)} · 총 ${fr.total}</div>
        ${extra}
        <div class="cmp-row muted">집 → 페낭 집 약 ${hm(door)}</div>
      </button>`;
    }).join('');
    $('compare').innerHTML = `${cards}
      <p class="note">조회 ${stamp(r.createdAt)} · 왕복 1인 · 경유 대기 ${hm(LAYOVER.min)}~${hm(LAYOVER.max)} · 대한항공은 인천⇄쿠알라룸푸르 직항 가격${r.errors?.length ? ` · <span class="bad">일부 조회 실패 ${r.errors.length}건</span>` : ''}</p>`;
  }

  function matrixHtml(a) {
    const r = state.result;
    const cells = Object.values(a.matrix).map((c) => c.price).filter(Boolean);
    const lo = cells.length ? Math.min(...cells) : 0;
    const hi = cells.length ? Math.max(...cells) : 0;
    let h = `<div class="table-wrap"><table class="mx"><thead><tr><th class="corner">가는 ↓ / 오는 →</th>${r.backs.map((b) => `<th>${mdw(b)}</th>`).join('')}</tr></thead><tbody>`;
    for (const o of r.outs) {
      h += `<tr><th>${mdw(o)}</th>`;
      for (const b of r.backs) {
        const c = a.matrix[`${o}|${b}`];
        if (!c) { h += '<td class="na">—</td>'; continue; }
        if (!c.opts.length) { h += '<td class="na">없음</td>'; continue; }
        const lvl = c.price == null ? '' : hi === lo ? 'l1' : `l${1 + Math.min(3, Math.floor(((c.price - lo) / (hi - lo)) * 4))}`;
        const sel = a.sel && a.sel.out === o && a.sel.back === b ? ' sel' : '';
        h += `<td><button class="mxc ${lvl}${sel}${c.price === lo ? ' low' : ''}" data-pick="${a.code}|${o}|${b}">${c.price ? man(c.price) : '?'}</button></td>`;
      }
      h += '</tr>';
    }
    return `${h}</tbody></table></div><p class="note">단위 만원 · 칸을 누르면 그 날짜로 오는 편까지 확정 (조회 1회)</p>`;
  }

  function groundHtml(sel) {
    const k = keGround(sel);
    if (!k) return '';
    const fx = quota?.fx?.krw || 320;
    const krw = (rm) => `${won(rm[0] * fx)}${rm[1] !== rm[0] ? `~${Math.round((rm[1] * fx) / 1000).toLocaleString('ko-KR')}천원` : ''}`;
    const arrivalStr = sel.outOpt.segs[sel.outOpt.segs.length - 1].arr;
    const depStr = sel.retOpt?.segs?.[0]?.dep || '';

    const outRows = k.g.options
      .slice()
      .sort((a, b) => (b.ok - a.ok) || ((a.home || 9e12) - (b.home || 9e12)))
      .map((o) => `<div class="gopt${o.ok ? '' : ' off'}${k.fastest === o ? ' best' : ''}">
        <div class="gh"><span>${o.icon} <b>${esc(o.name)}</b>${k.fastest === o ? ' <span class="tag">가장 빠름</span>' : ''}${o.hotel ? ' <span class="tag warn">1박 필요</span>' : ''}</span><span class="price">${o.ok ? krw(o.rm) : '불가'}</span></div>
        ${o.ok ? `<div class="gm">${o.departClock} 출발 → <b>집 ${o.homeDate !== arrivalStr.slice(0, 10) ? `${md(o.homeDate)} ` : ''}${o.homeClock}</b> 도착 · 공항 도착부터 ${hm(o.home - k.g.arrival)} · RM ${o.rm[0]}~${o.rm[1]}</div>` : ''}
        <div class="gd">${esc(o.detail)}</div>
        <div class="gl">${o.links.map((l) => `<a href="${l.url}" target="_blank" rel="noopener">${esc(l.name)}</a>`).join(' · ')}${o.google ? `<a href="${googleQ(o.google)}" target="_blank" rel="noopener">구글 플라이트에서 국내선 보기</a>` : ''}</div>
      </div>`).join('');

    const inRows = k.gi ? k.gi.options
      .slice()
      .sort((a, b) => b.leave - a.leave)
      .map((o) => `<div class="gopt${o.hotel ? ' warnbox' : ''}">
        <div class="gh"><span>${o.icon} <b>${esc(o.name)}</b>${o.hotel ? ' <span class="tag warn">전날 이동</span>' : ''}</span><span class="price">${krw(o.rm)}</span></div>
        <div class="gm">집에서 <b>${o.leaveDate !== depStr.slice(0, 10) ? `${md(o.leaveDate)} ` : ''}${o.leaveClock}</b>까지 출발 → 공항 ${o.arriveClock} · 이동 ${hm(o.ride)} · RM ${o.rm[0]}~${o.rm[1]}</div>
        <div class="gd">${esc(o.detail)}</div>
        <div class="gl">${o.links.map((l) => `<a href="${l.url}" target="_blank" rel="noopener">${esc(l.name)}</a>`).join(' · ')}${o.google ? `<a href="${googleQ(o.google)}" target="_blank" rel="noopener">구글 플라이트에서 국내선 보기</a>` : ''}</div>
      </div>`).join('') : '';

    return `<div class="ground">
      <h4>🧭 쿠알라룸푸르 ↔ 페낭 이동수단 전체 비교</h4>
      <div class="seg small">
        <button data-gtab="out" aria-selected="${groundTab === 'out'}">가는 길 (${hhmm(arrivalStr)} 도착 후)</button>
        <button data-gtab="in" aria-selected="${groundTab === 'in'}">오는 길 (${depStr ? hhmm(depStr) : '-'} 출발 전)</button>
      </div>
      ${groundTab === 'out' ? outRows : `<p class="note">국제선 3시간 전(${k.gi?.atAirportClock}) KLIA T1 도착 기준으로 거꾸로 계산했습니다.</p>${inRows}`}
      <p class="note">1링깃 ≈ ${Math.round(fx)}원 (${quota?.fx?.at ? '오늘 환율' : '대략값'}) · 1인 기준, 전세차는 차 1대(1~4인) 값 · 시간표·요금은 ${window.Ground.SURVEYED} 조사, 예약 전 사이트에서 확인</p>
    </div>`;
  }

  function airlineCard(a) {
    const s = a.sel;
    const info = AIRLINES[a.code];
    if (!s) {
      return `<section class="card air" id="air-${a.code}"><div class="card-head"><h2>${esc(a.name)}</h2></div>
        <p class="empty">이 기간에 조건(${a.code === 'KE' ? '쿠알라룸푸르 직항' : `1회 경유 · 대기 ${hm(LAYOVER.min)}~${hm(LAYOVER.max)}`})에 맞는 항공편이 없습니다.</p>
        ${Object.keys(a.matrix).length ? matrixHtml(a) : ''}</section>`;
    }
    if (s.noReturn) {
      return `<section class="card air" id="air-${a.code}"><div class="air-head"><div><h2>${esc(a.name)}</h2><div class="muted">${mdw(s.out)} ~ ${mdw(s.back)}</div></div><div class="big muted">—</div></div>
        ${matrixHtml(a)}
        <div class="way"><div class="way-h">✈️ 가는 편 ${mdw(s.out)} <span class="muted">총 ${hm(s.outOpt.total)}</span></div>${segHtml(s.outOpt)}</div>
        <p class="bad small">${mdw(s.back)}에는 경유 대기 ${hm(LAYOVER.min)}~${hm(LAYOVER.max)}에 맞는 오는 편이 없습니다. 오는 날을 ±일로 넓혀 보세요.${s.noReturnNote ? `<br>${esc(s.noReturnNote)}` : ''}</p>
        <div class="actions"><a class="btn" href="${s.googleUrl || googleQ(`Flights from ICN to PEN on ${s.out} through ${s.back} on ${info.en}`)}" target="_blank" rel="noopener">구글 플라이트</a><a class="btn" href="${info.site}" target="_blank" rel="noopener">${esc(a.name)} 홈페이지</a></div>
      </section>`;
    }
    const cell = a.matrix[`${s.out}|${s.back}`];
    const alts = (cell?.opts || []).filter((o) => flightsKey(o) !== flightsKey(s.outOpt));
    const gq = googleQ(`Flights from ICN to ${info.dest} on ${s.out} through ${s.back} on ${info.en}`);
    return `<section class="card air" id="air-${a.code}">
      <div class="air-head">
        <div><h2>${esc(a.name)}</h2><div class="muted">${mdw(s.out)} ~ ${mdw(s.back)} · 왕복 1인${a.code === 'KE' ? ' · 인천⇄쿠알라룸푸르' : ''}</div></div>
        <div class="big">${won(s.price)}</div>
      </div>
      ${matrixHtml(a)}
      <div class="way"><div class="way-h">✈️ 가는 편 ${mdw(s.out)} <span class="muted">총 ${hm(s.outOpt.total)}</span></div>${segHtml(s.outOpt)}</div>
      ${alts.length ? `<details class="alts"><summary>같은 날 다른 시간 ${alts.length}개</summary>${alts.map((o, i) => {
        const f = flySummary(o);
        return `<button class="alt" data-alt="${a.code}|${i}"><span><b>${esc(f.nos)}</b> ${f.time} · ${esc(f.lay)} · ${f.total}</span><span>${o.price ? won(o.price) : '가격 확인'}</span></button>`;
      }).join('')}</details>` : ''}
      <div class="way"><div class="way-h">✈️ 오는 편 ${mdw(s.back)} <span class="muted">총 ${hm(s.retOpt.total)}</span></div>${segHtml(s.retOpt)}</div>
      ${s.returns?.length ? `<p class="note">오는 편 다른 시간: ${s.returns.map((o) => { const f = flySummary(o); return `${f.nos} ${f.time}(${f.lay}) ${o.price ? won(o.price) : ''}`; }).map(esc).join(' / ')} — 예약 사이트에서 바꿔 고를 수 있습니다</p>` : ''}
      <div class="actions">
        <button class="btn primary" data-book="${a.code}">🎫 예약하기 · 예약처 가격 비교</button>
        <a class="btn" href="${s.googleUrl || gq}" target="_blank" rel="noopener">구글 플라이트</a>
        <a class="btn" href="${info.site}" target="_blank" rel="noopener">${esc(a.name)} 홈페이지</a>
      </div>
      <div class="vendors" id="vendors-${a.code}"></div>
      <p class="note">확정 ${stamp(s.at)} 기준</p>
      ${a.code === 'KE' ? groundHtml(s) : ''}
    </section>`;
  }

  function renderWatch() {
    const r = state.result;
    const lr = state.lastRecheck;
    const rows = r.airlines.filter((a) => a.best && a.sel && !a.sel.noReturn).map((a) => {
      const w = a.watch;
      const base = a.sel?.price ?? a.best.price;
      const hist = (a.watchHistory || []).filter((x) => x.p);
      const diff = hist.length >= 2 ? hist[hist.length - 1].p - hist[hist.length - 2].p : 0;
      return `<li><span><b>${esc(a.name)}</b> ${md(a.best.out)}~${md(a.best.back)}</span><span>${w ? `${won(w.price)} ${diff ? `<span class="${diff < 0 ? 'good' : 'bad'}">${diff < 0 ? '▼' : '▲'}${Math.abs(Math.round(diff / 1000)).toLocaleString('ko-KR')}천</span>` : ''}` : won(base)}</span></li>`;
    }).join('');
    $('watch').innerHTML = `<ul class="watch">${rows}</ul>
      <p class="note">오른쪽 금액은 매일 아침 7시에 다시 확인한 시세(항공사 최저 표시가)이고, 직전 확인보다 3% 또는 1만원 이상 바뀌면 휴대폰 알림을 보냅니다. 예약 전 최종가는 항공사 카드의 예약하기에서 확인하세요.${lr ? ` 마지막 확인 ${stamp(lr.at)}${lr.changes?.length ? ` · 변동 ${lr.changes.length}건` : ' · 변동 없음'}` : ''}</p>`;
  }

  function render() {
    const has = Boolean(state.result?.airlines);
    $('results').hidden = !has;
    if (!has) return;
    renderCompare();
    renderSites();
    $('airCards').innerHTML = state.result.airlines.map(airlineCard).join('');
    renderWatch();
    renderLog();
  }

  // ── 예약 ─────────────────────────────────────────────
  // 이 항공편을 "실제로 파는 곳"과 그곳의 최종 결제 금액을 가져옵니다 (조회 1회).
  // 트립닷컴·하나투어 같은 판매 사이트와 항공사 공식 홈페이지가 같이 나옵니다.
  async function fetchVendors(code) {
    const a = state.result.airlines.find((x) => x.code === code);
    if (!a?.sel || a.sel.noReturn) return [];
    let data = null;
    if (a.sel.bookingToken) {
      data = await serp({ ...baseParams(code, a.sel.out, a.sel.back), booking_token: a.sel.bookingToken }).catch(() => null);
    }
    if (!data?.booking_options?.length) {
      // 오래돼서 만료됐으면 오는 편부터 다시 확정
      const cell = a.matrix[`${a.sel.out}|${a.sel.back}`];
      const fresh = listOf(await serp(baseParams(code, a.sel.out, a.sel.back))).find((o) => flightsKey(o) === flightsKey(a.sel.outOpt)) || cell?.opts?.[0];
      a.sel = await detail(code, a.sel.out, a.sel.back, fresh);
      data = await serp({ ...baseParams(code, a.sel.out, a.sel.back), booking_token: a.sel.bookingToken });
    }
    return (data.booking_options || [])
      .map((o) => o.together || o.departing)
      .filter((v) => v?.booking_request?.url)
      .sort((x, y) => (x.price || 1e12) - (y.price || 1e12));
  }

  // 가져온 판매처를 ③ 표에서도 쓰도록 보관합니다.
  // 예약 화면으로 넘기는 값은 덩치가 커서 화면(메모리)에만 두고, 서버에는 보여줄 내용만 저장합니다.
  function keepVendors(code, vendors) {
    vendorCache.set(code, vendors);
    const a = state.result.airlines.find((x) => x.code === code);
    if (!a?.sel || a.sel.noReturn) return;
    a.sites = {
      at: new Date().toISOString(),
      out: a.sel.out,
      back: a.sel.back,
      flights: `${flySummary(a.sel.outOpt).nos} / ${flySummary(a.sel.retOpt).nos}`,
      rows: vendors.map((v, i) => ({
        i,
        name: String(v.book_with || '이름 없음'),
        price: Number(v.price) > 0 ? Number(v.price) : null,
        bag: (v.baggage_prices || []).join(' · '),
      })),
    };
  }

  async function loadVendors(code) {
    const box = $(`vendors-${code}`);
    if (!state.result.airlines.find((x) => x.code === code)?.sel) return;
    box.innerHTML = '<p class="loading">예약처와 최종 가격을 불러오는 중… (15초쯤 걸립니다 · 조회 1회)</p>';
    try {
      const vendors = await fetchVendors(code);
      if (!vendors.length) throw new Error('예약처 정보가 없습니다');
      keepVendors(code, vendors);
      renderSites();
      const airlineVendor = (v) => /항공|airlines|air$|korean air|대한/i.test(v.book_with || '');
      box.innerHTML = `<p class="note">누르면 해당 사이트의 <b>이 일정 예약 화면</b>으로 바로 이동합니다. 가격 낮은 순.</p>
        ${vendors.map((v, i) => `<button class="vendor${airlineVendor(v) ? ' direct' : ''}" data-vendor="${code}|${i}">
          <span><b>${esc(v.book_with)}</b>${airlineVendor(v) ? ' <span class="tag">항공사 직접</span>' : ''}${i === 0 ? ' <span class="tag">최저</span>' : ''}
          <span class="muted small">${esc((v.baggage_prices || []).join(' · '))}</span></span>
          <span class="price">${v.price ? won(v.price) : '-'}</span></button>`).join('')}`;
      box._vendors = vendors;
      saveState();
    } catch (err) {
      if (err.needPin) return askPin(err.message);
      box.innerHTML = `<p class="bad">예약처를 불러오지 못했습니다: ${esc(err.message)}. 위의 구글 플라이트 버튼으로 이동해 주세요.</p>`;
    }
  }

  // ── ③ 사이트별 구매 가능 가격 ─────────────────────────
  const siteMeta = (name) => MY_SITES.find((x) => x.match.test(String(name || ''))) || null;
  const tripOf = (a) => (a && a.sel && !a.sel.noReturn ? { from: 'ICN', to: AIRLINES[a.code].dest, out: a.sel.out, back: a.sel.back } : null);

  // 항공사마다 한 번씩(조회 N회) 파는 곳을 모읍니다.
  async function scanSites() {
    if (busy) return;
    const ready = state.result.airlines.filter((a) => a.sel && !a.sel.noReturn);
    if (!ready.length) return;
    busy = true;
    $('sites').innerHTML = `<p class="loading">${ready.length}개 항공사의 판매 사이트와 최종 가격을 모으는 중… (한 곳당 15초쯤 · 조회 ${ready.length}회)</p>`;
    const errs = [];
    try {
      for (const a of ready) {
        try {
          const vendors = await fetchVendors(a.code);
          if (!vendors.length) throw new Error('파는 곳 정보가 없습니다');
          keepVendors(a.code, vendors);
        } catch (err) {
          if (err.needPin) throw err;
          errs.push(`${a.name}: ${err.message}`);
        }
      }
      state.result.siteErrors = errs;
      renderSites();
      saveState();
    } catch (err) {
      if (err.needPin) askPin(err.message);
      else $('sites').innerHTML = `<p class="bad">값을 모으지 못했습니다: ${esc(err.message)}</p>`;
    } finally {
      busy = false;
      refreshQuota();
    }
  }

  // 자주 쓰는 사이트 5곳을 "이 일정"으로 바로 열 수 있는 줄
  function directLinks() {
    const r = state.result;
    const pick = (code) => r.airlines.find((a) => a.code === code && a.sel && !a.sel.noReturn);
    const anyPen = pick('MH') || pick('SQ');
    const items = MY_SITES.map((site) => {
      const t = tripOf(site.airline ? pick(site.airline) : anyPen);
      const hits = [];
      for (const a of r.airlines) for (const row of a.sites?.rows || []) if (row.price && site.match.test(row.name)) hits.push(row.price);
      const best = hits.length ? Math.min(...hits) : null;
      const note = best
        ? `<span class="good small">아래 표에 있음 · 최저 ${won(best)}</span>`
        : '<span class="muted small">구글에 값이 안 올라옴 → 직접 확인</span>';
      const how = site.exact && t ? `${md(t.out)}~${md(t.back)} 자동 입력` : '날짜 직접 입력';
      return `<li><a href="${site.link(t)}" target="_blank" rel="noopener"><b>${esc(site.name)}</b></a> ${note} <span class="muted small">${how}</span></li>`;
    }).join('');
    return `<div class="direct"><h4>🔗 자주 쓰는 사이트에서 직접 확인</h4><ul>${items}</ul>
      <p class="note">트립닷컴·아고다는 <b>이 일정이 미리 입력된 검색 화면</b>으로 열립니다.
      항공사 공식 홈페이지 3곳은 프로그램 접속을 막아 둬서(대한항공은 접속 자체를 차단) 예약 화면만 열리고 날짜는 직접 넣어야 합니다.</p></div>`;
  }

  function renderSites() {
    const r = state.result;
    const box = $('sites');
    if (!box) return;
    const ready = r.airlines.filter((a) => a.sel && !a.sel.noReturn);
    if (!ready.length) {
      box.innerHTML = '<p class="empty">먼저 위 ② 에서 가는 날·오는 날을 확정해 주세요. 확정한 항공편을 파는 사이트와 값을 모아 옵니다.</p>';
      return;
    }
    const scanned = ready.filter((a) => a.sites?.rows?.length);
    if (!scanned.length) {
      box.innerHTML = `<p class="note">확정한 항공편을 <b>실제로 파는 사이트</b>와 그곳의 최종 금액을 모읍니다.
        트립닷컴·하나투어 같은 판매처와 항공사 공식 홈페이지가 같이 나오고, 줄을 누르면 그 사이트의 <b>이 일정 예약 화면</b>으로 바로 넘어갑니다.</p>
        <button class="btn primary wide" id="scanBtn">💳 사이트별 실제 판매가 모으기 (조회 ${ready.length}회)</button>${directLinks()}`;
      return;
    }
    const rows = [];
    for (const a of scanned) for (const row of a.sites.rows) rows.push({ ...row, code: a.code, air: a.name, box: a.sites });
    rows.sort((x, y) => (x.price ?? 1e12) - (y.price ?? 1e12));
    const low = rows.find((x) => x.price)?.price ?? null;
    const list = rows.map((x) => {
      const m = siteMeta(x.name);
      const live = Boolean(vendorCache.get(x.code)?.[x.i]?.booking_request);
      const alias = m && m.name !== x.name ? ` <span class="muted small">${esc(x.name)}</span>` : '';
      return `<button class="site${m ? ' mine' : ''}${x.price && x.price === low ? ' low' : ''}" data-sitebuy="${x.code}|${x.i}">
        <span class="s1"><b>${esc(m ? m.name : x.name)}</b>${alias}${m ? ' <span class="tag mine">자주 쓰는 곳</span>' : ''}${x.price && x.price === low ? ' <span class="tag">최저</span>' : ''}</span>
        <span class="s2 muted">${esc(x.air)} · ${md(x.box.out)}~${md(x.box.back)} · ${esc(x.box.flights)}${x.bag ? ` · ${esc(x.bag)}` : ''}${live ? '' : ' · 예약 연결 만료(사이트만 열림)'}</span>
        <span class="price">${won(x.price)}</span>
      </button>`;
    }).join('');
    const at = scanned.map((a) => Date.parse(a.sites.at)).sort((q, w) => w - q)[0];
    const rest = ready.filter((a) => !a.sites?.rows?.length);
    const again = rest.length
      ? `<button class="btn wide" id="scanBtn">💳 나머지(${rest.map((a) => a.name).join('·')})도 모으기 (조회 ${rest.length}회)</button>`
      : `<button class="btn wide" id="scanBtn">🔄 값 다시 확인 (조회 ${ready.length}회)</button>`;
    box.innerHTML = `<div class="sitelist">${list}</div>
      <p class="note">모두 <b>왕복 1인 · 그 사이트에서 실제로 살 수 있는 금액</b>이고 싼 순서입니다. 확인 ${stamp(new Date(at).toISOString())} 기준 —
      항공권 값은 수시로 바뀌니 누른 뒤 예약 화면의 금액을 한 번 더 확인하세요.
      ${r.siteErrors?.length ? `<br><span class="bad">못 가져온 곳: ${esc(r.siteErrors.join(' / '))}</span>` : ''}</p>
      ${again}${directLinks()}`;
  }

  function openVendor(v) {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = v.booking_request.url;
    form.target = '_blank';
    form.rel = 'noopener';
    for (const part of String(v.booking_request.post_data || '').split('&')) {
      if (!part) continue;
      const i = part.indexOf('=');
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = decodeURIComponent(i < 0 ? part : part.slice(0, i));
      input.value = i < 0 ? '' : decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    form.remove();
  }

  async function pick(code, out, back, opt) {
    const a = state.result.airlines.find((x) => x.code === code);
    const card = $(`air-${code}`);
    card.classList.add('loading-card');
    try {
      a.sel = await detail(code, out, back, opt);
      const cell = a.matrix[`${out}|${back}`];
      if (a.sel.price && cell) { cell.price = a.sel.price; cell.confirmed = true; }
      if (a.sel.price && (!a.best?.price || a.sel.price < a.best.price)) a.best = { out, back, price: a.sel.price, flights: flightsKey(a.sel.outOpt) };
      render();
      $(`air-${code}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
      saveState();
    } catch (err) {
      if (err.needPin) askPin(err.message);
      else alert(err.message);
    } finally {
      card.classList.remove('loading-card');
      refreshQuota();
    }
  }

  // ── 기타 ─────────────────────────────────────────────
  function askPin(msg) {
    const v = prompt(`${msg ? `${msg}\n` : ''}앱 PIN을 입력해 주세요 (처음 한 번만)`, '');
    if (v) { store.set('pin', v.trim()); boot(); }
  }

  async function refreshQuota() {
    try {
      quota = await api('/api/quota');
      $('status').textContent = `무료 조회 ${quota.left}회 남음${quota.renewal ? ` · ${md(quota.renewal)} 초기화` : ''}`;
    } catch (err) {
      $('status').textContent = err.needPin ? 'PIN 입력이 필요합니다 (오른쪽 위 ⚙️)' : `서버 연결 실패: ${err.message}`;
    }
    updateEstimate();
  }

  async function boot() {
    const saved = JSON.parse(store.get('trip') || 'null');
    const t = saved || { out: addDays(todayKst(), 21), outFlex: 1, back: addDays(todayKst(), 28), backFlex: 1, includeKE: true };
    $('outDate').value = t.out; $('outFlex').value = t.outFlex; $('backDate').value = t.back; $('backFlex').value = t.backFlex; $('incKE').checked = t.includeKE;
    $('outDate').min = $('backDate').min = addDays(todayKst(), 1);
    updateEstimate();
    await refreshQuota();
    try {
      const s = await api('/api/state');
      if (s?.result) {
        state = { trip: s.trip, result: s.result, lastRecheck: s.lastRecheck || null, log: s.log || [] };
        render();
      }
    } catch { /* 처음이면 없음 */ }
  }

  async function recheckNow() {
    const n = new Set((state.result?.airlines || []).filter((a) => a.best).map((a) => `${a.code === 'KE'}|${a.best.out}|${a.best.back}`)).size;
    if (!n || !confirm(`저장된 일정 가격을 지금 다시 확인합니다 (조회 약 ${n}회). 결과는 휴대폰 알림으로도 옵니다.`)) return;
    try {
      const r = await api('/api/recheck', {});
      const s = await api('/api/state');
      state = { trip: s.trip, result: s.result, lastRecheck: s.lastRecheck || null, log: s.log || [] };
      render();
      alert(r.skipped || (r.changes?.length ? r.changes.join('\n') : '가격 변동 없음'));
    } catch (err) { alert(err.message); }
    refreshQuota();
  }

  // ── 이벤트 ───────────────────────────────────────────
  ['outDate', 'outFlex', 'backDate', 'backFlex', 'incKE'].forEach((id) => $(id).addEventListener('change', updateEstimate));
  $('searchBtn').addEventListener('click', runSearch);
  $('settings').addEventListener('click', () => askPin());
  $('recheck').addEventListener('click', recheckNow);

  document.addEventListener('click', (ev) => {
    const lf = ev.target.closest('[data-logf]');
    if (lf) {
      const [k, v] = lf.dataset.logf.split('|');
      logFilter[k] = v;
      renderLog();
      return;
    }
    if (ev.target.closest('#scanBtn')) { scanSites(); return; }
    const t = ev.target.closest('[data-pick],[data-alt],[data-book],[data-vendor],[data-sitebuy],[data-jump],[data-gtab]');
    if (!t || busy) return;
    if (t.dataset.pick) {
      const [code, out, back] = t.dataset.pick.split('|');
      const a = state.result.airlines.find((x) => x.code === code);
      const cell = a.matrix[`${out}|${back}`];
      const opt = cell.opts.find((o) => o.price === cell.price) || cell.opts[0];
      if (confirm(`${a.name} ${mdw(out)}~${mdw(back)} 일정으로 오는 편까지 확인할까요? (조회 1회)`)) pick(code, out, back, opt);
    } else if (t.dataset.alt) {
      const [code, i] = t.dataset.alt.split('|');
      const a = state.result.airlines.find((x) => x.code === code);
      const cell = a.matrix[`${a.sel.out}|${a.sel.back}`];
      const alts = cell.opts.filter((o) => flightsKey(o) !== flightsKey(a.sel.outOpt));
      if (confirm('이 가는 편으로 오는 편까지 확인할까요? (조회 1회)')) pick(code, a.sel.out, a.sel.back, alts[Number(i)]);
    } else if (t.dataset.book) {
      loadVendors(t.dataset.book);
    } else if (t.dataset.vendor) {
      const [code, i] = t.dataset.vendor.split('|');
      const v = $(`vendors-${code}`)._vendors?.[Number(i)];
      if (v) openVendor(v);
    } else if (t.dataset.sitebuy) {
      // 줄을 누르면 그 사이트의 이 일정 예약 화면으로. 연결이 만료됐으면 그 사이트 검색 화면으로.
      const [code, i] = t.dataset.sitebuy.split('|');
      const v = vendorCache.get(code)?.[Number(i)];
      if (v?.booking_request) { openVendor(v); return; }
      const a = state.result.airlines.find((x) => x.code === code);
      const name = a?.sites?.rows?.[Number(i)]?.name || '';
      const site = siteMeta(name);
      const info = AIRLINES[code];
      window.open(
        site ? site.link(tripOf(a)) : googleQ(`Flights from ICN to ${info.dest} on ${a.sel.out} through ${a.sel.back} on ${info.en}`),
        '_blank', 'noopener'
      );
    } else if (t.dataset.jump) {
      $(`air-${t.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (t.dataset.gtab) {
      groundTab = t.dataset.gtab;
      $('airCards').innerHTML = state.result.airlines.map(airlineCard).join('');
    }
  });

  // ── 홈 화면 설치 도우미 ───────────────────────────────
  const ua = navigator.userAgent;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const inApp = /KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|Line\/|DaumApps|everytimeApp/i.test(ua);
  const samsung = /SamsungBrowser/i.test(ua);
  const android = /Android/i.test(ua);
  const ios = /iPhone|iPad/i.test(ua);
  let installEvent = null;

  function renderInstall(extra = '') {
    const box = $('install');
    if (standalone) { box.hidden = true; return; }
    let html = '';
    if (inApp && android) {
      const url = location.href.replace(/^https?:\/\//, '');
      html = `<b>카카오톡·네이버 같은 앱 안에서는 홈 화면에 추가할 수 없습니다.</b><br>
        <a class="btn primary" href="intent://${url}#Intent;scheme=https;package=com.android.chrome;end">크롬으로 열기</a>`;
    } else if (inApp && ios) {
      html = '<b>앱 안의 브라우저에서는 추가할 수 없습니다.</b> 오른쪽 아래 <b>…</b> → <b>Safari로 열기</b> 후 공유 버튼 → 홈 화면에 추가';
    } else if (installEvent) {
      html = '<button class="btn primary" id="installBtn">📲 홈 화면에 앱 설치</button>';
    } else if (samsung) {
      html = '삼성 인터넷: 아래쪽 <b>≡ 메뉴</b> → <b>현재 페이지 추가</b> → <b>홈 화면</b>';
    } else if (android) {
      html = '크롬 오른쪽 위 <b>⋮</b> → <b>홈 화면에 추가</b> → <b>설치</b>(또는 <b>바로가기 만들기</b>)';
    } else if (ios) {
      html = '사파리 아래쪽 <b>공유(□↑)</b> → <b>홈 화면에 추가</b>';
    } else {
      box.hidden = true;
      return;
    }
    if (android && !inApp) {
      html += `<details class="small"><summary>아이콘이 안 보이면</summary>
        ① 홈 화면에서 위로 쓸어올려 <b>앱스 화면</b>에 "페낭 항공권"이 있는지 확인 → 길게 눌러 <b>홈에 추가</b><br>
        ② 삼성: 홈 화면 빈 곳 길게 누르기 → 설정 → <b>"새 앱을 홈 화면에 추가"</b> 켜기<br>
        ③ 설정 → 애플리케이션 → Chrome → <b>"홈 화면에 바로가기 추가" 권한</b> 허용 후 다시 시도</details>`;
    }
    box.innerHTML = html + extra;
    box.hidden = false;
    $('installBtn')?.addEventListener('click', async () => {
      installEvent.prompt();
      const r = await installEvent.userChoice.catch(() => null);
      installEvent = null;
      renderInstall(r?.outcome === 'accepted' ? '<p class="good">설치를 시작했습니다. 잠시 뒤 홈 화면(또는 앱스 화면)을 확인하세요.</p>' : '');
    });
  }
  window.addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); installEvent = ev; renderInstall(); });
  window.addEventListener('appinstalled', () => renderInstall('<p class="good">설치됐습니다! 홈 화면에 없으면 앱스 화면에서 "페낭 항공권"을 길게 눌러 홈에 추가하세요.</p>'));
  renderInstall();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  boot();
})();
