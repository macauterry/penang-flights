// 인천⇄페낭 최저가 앱 화면. data/prices.json 을 읽어서 보여주기만 합니다 (조회 횟수를 쓰지 않음).
(() => {
  'use strict';

  const AIRLINES = {
    SQ: { ko: '싱가포르항공', en: 'Singapore Airlines', site: 'https://www.singaporeair.com/ko_KR/kr/home' },
    MH: { ko: '말레이시아항공', en: 'Malaysia Airlines', site: 'https://www.malaysiaairlines.com/kr/ko.html' },
    KE: { ko: '대한항공', en: 'Korean Air', site: 'https://www.koreanair.com/' },
  };
  const AIRPORTS = { ICN: '인천', PEN: '페낭', KUL: '쿠알라룸푸르', SIN: '싱가포르' };
  const STAYS = [
    { id: 's1', label: '3~7박', min: 3, max: 7 },
    { id: 's2', label: '8~14박', min: 8, max: 14 },
    { id: 's3', label: '15~30박', min: 15, max: 30 },
    { id: 's4', label: '전체', min: 1, max: 60 },
  ];
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  const DAY = 86_400_000;
  const STALE_DAYS = 7;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } },
  };

  let data = null;
  let routeId = store.get('route', 'ICN-PEN');
  let stayId = store.get('stay', 's1');

  // ── 날짜·숫자 표시 ──────────────────────────────────────
  const parse = (iso) => new Date(`${iso}T00:00:00Z`);
  const addDays = (iso, n) => new Date(parse(iso).getTime() + n * DAY).toISOString().slice(0, 10);
  const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / DAY);
  const md = (iso) => { const d = parse(iso); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
  const dow = (iso) => DOW[parse(iso).getUTCDay()];
  const mdw = (iso) => `${md(iso)}(${dow(iso)})`;
  const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
  const man = (n) => (n / 10000).toFixed(n >= 1_000_000 ? 0 : 1);
  const hm = (min) => `${Math.floor(min / 60)}시간${min % 60 ? ` ${min % 60}분` : ''}`;
  const hhmm = (t) => String(t).slice(11, 16);
  const ageDays = (iso) => (Date.now() - Date.parse(iso)) / DAY;
  function ageText(iso) {
    const d = ageDays(iso);
    if (d < 1) return '오늘 확인';
    return `${Math.floor(d)}일 전 확인`;
  }
  function stamp(iso) {
    const d = new Date(iso);
    const k = new Date(d.getTime() + 9 * 3_600_000);
    return `${k.getUTCMonth() + 1}/${k.getUTCDate()}(${DOW[k.getUTCDay()]}) ${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
  }
  const airlineName = (code) => AIRLINES[code]?.ko || code;
  const route = (id) => data.meta.routes.find((r) => r.id === id);
  const todayKst = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

  // ── 예약 링크 ──────────────────────────────────────────
  function links({ from, to, date, back, airline }) {
    const yymmdd = (iso) => iso.slice(2).replace(/-/g, '');
    const air = airline && AIRLINES[airline] ? ` on ${AIRLINES[airline].en}` : '';
    const q = back
      ? `Flights from ${from} to ${to} on ${date} through ${back}${air}`
      : `One-way flights from ${from} to ${to} on ${date}${air}`;
    return {
      google: `https://www.google.com/travel/flights?hl=ko&curr=KRW&q=${encodeURIComponent(q)}`,
      skyscanner: `https://www.skyscanner.co.kr/transport/flights/${from}/${to}/${yymmdd(date)}/${back ? `${yymmdd(back)}/` : ''}?adults=1&currency=KRW&locale=ko-KR&market=KR`,
      naver: `https://flight.naver.com/flights/international/${from}-${to}-${date.replace(/-/g, '')}${back ? `/${to}-${from}-${back.replace(/-/g, '')}` : ''}?adult=1&fareType=Y`,
    };
  }

  // ── 데이터 도우미 ──────────────────────────────────────
  function entries(id) {
    const today = todayKst();
    return Object.entries(data.routes[id] || {})
      .filter(([date]) => date >= today)
      .map(([date, e]) => ({ date, ...e }));
  }

  function heatLevels(list) {
    const prices = list.filter((e) => e.price).map((e) => e.price).sort((a, b) => a - b);
    return (p) => {
      if (!prices.length) return 0;
      if (prices.length < 5) {
        const lo = prices[0];
        const hi = prices[prices.length - 1];
        return hi === lo ? 1 : 1 + Math.min(4, Math.floor(((p - lo) / (hi - lo)) * 5));
      }
      const rank = prices.filter((x) => x < p).length / prices.length;
      return 1 + Math.min(4, Math.floor(rank * 5));
    };
  }

  function prevPrice(e) {
    const h = (e.history || []).filter((x) => x.p);
    return h.length >= 2 ? h[h.length - 2].p : null;
  }

  function deltaHtml(e) {
    const prev = prevPrice(e);
    if (!prev || !e.price || prev === e.price) return '';
    const diff = e.price - prev;
    const cls = diff < 0 ? 'down' : 'up';
    return `<div class="delta ${cls}">${diff < 0 ? '▼' : '▲'}${Math.abs(Math.round(diff / 1000)).toLocaleString('ko-KR')}천원</div>`;
  }

  function summary(opt) {
    const first = opt.segs[0];
    const last = opt.segs[opt.segs.length - 1];
    const via = opt.lays.map((l) => `${AIRPORTS[l.at] || l.at} ${hm(l.min)} 대기`).join(', ') || '직항';
    const plus = last.arr.slice(0, 10) > first.dep.slice(0, 10) ? '+1' : '';
    return `${opt.airlines.map(airlineName).join('·')} · ${hhmm(first.dep)}→${hhmm(last.arr)}${plus} · ${via}`;
  }

  // ── 그리기 ────────────────────────────────────────────
  function renderHeader() {
    const m = data.meta;
    const c = m.conditions;
    const q = m.quota || {};
    const hours = (Date.now() - Date.parse(m.updatedAt)) / 3_600_000;
    $('status').textContent = `업데이트 ${stamp(m.updatedAt)}${hours > 36 ? ' ⚠️ 오래됨' : ''}`;
    $('chips').innerHTML = [
      c.airlines.map(airlineName).join('·'),
      `경유 ${c.maxStops}회 이하`,
      `대기 ${hm(c.layoverMinMinutes)}~${hm(c.layoverMaxMinutes)}`,
      `${c.daysAheadMin}~${c.daysAheadMax}일 뒤 출발`,
    ].map((t) => `<span class="chip">${esc(t)}</span>`).join('');
    $('foot').innerHTML = `구글 플라이트 실시간 시세 · 1인 편도 · 남은 무료 조회 ${q.left ?? '?'}회${q.renewal ? ` (${md(q.renewal)} 초기화)` : ''}<br>가격은 확인한 시점 기준입니다. 예약 전 링크에서 최종가를 확인하세요.`;
  }

  function renderTabs() {
    $('routeTabs').innerHTML = data.meta.routes
      .map((r) => `<button role="tab" data-route="${r.id}" aria-selected="${r.id === routeId}">${esc(r.label)}</button>`)
      .join('');
    $('stayTabs').innerHTML = STAYS
      .map((s) => `<button data-stay="${s.id}" aria-selected="${s.id === stayId}">${s.label}</button>`)
      .join('');
  }

  function renderTop() {
    const list = entries(routeId).filter((e) => e.price).sort((a, b) => a.price - b.price).slice(0, 5);
    const all = entries(routeId);
    $('topHint').textContent = `${all.length}일 확인됨`;
    if (!list.length) {
      $('topList').innerHTML = `<li class="empty">아직 확인한 날짜가 없습니다. 매일 조금씩 채워집니다.</li>`;
      return;
    }
    $('topList').innerHTML = list.map((e, i) => `
      <li><button class="row" data-date="${e.date}" data-route="${routeId}">
        <span class="rank">${i + 1}</span>
        <span class="row-main">
          <div class="row-date">${mdw(e.date)} <span class="age${ageDays(e.checkedAt) > STALE_DAYS ? ' stale' : ''}">· ${ageText(e.checkedAt)}</span></div>
          <div class="row-sub">${esc(summary(e.options[0]))}</div>
        </span>
        <span class="row-price"><div class="price">${won(e.price)}</div>${deltaHtml(e)}</span>
      </button></li>`).join('');
  }

  function renderCalendar() {
    const today = todayKst();
    const c = data.meta.conditions;
    const start = addDays(today, c.daysAheadMin);
    const end = addDays(today, c.daysAheadMax);
    const list = entries(routeId);
    const byDate = Object.fromEntries(list.map((e) => [e.date, e]));
    const level = heatLevels(list);
    const best = list.filter((e) => e.price).sort((a, b) => a.price - b.price)[0];

    $('legend').innerHTML = `싸다 <i style="background:var(--heat-1)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-4)"></i><i style="background:var(--heat-5)"></i> 비싸다 · 흐린 칸 = ${STALE_DAYS}일 넘게 안 봄 · 점선 = 아직 안 봄`;

    let html = '';
    let cursor = `${start.slice(0, 7)}-01`;
    while (cursor <= end) {
      const d0 = parse(cursor);
      const y = d0.getUTCFullYear();
      const m = d0.getUTCMonth();
      const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      html += `<div class="month"><h4>${y}년 ${m + 1}월</h4><div class="grid">`;
      html += DOW.map((w, i) => `<div class="dow${i === 0 ? ' sun' : ''}">${w}</div>`).join('');
      for (let i = 0; i < d0.getUTCDay(); i++) html += '<div class="cell blank"></div>';
      for (let day = 1; day <= days; day++) {
        const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const e = byDate[iso];
        if (iso < start || iso > end) {
          html += `<div class="cell out"><span class="d">${day}</span><span class="p"></span></div>`;
        } else if (!e) {
          html += `<div class="cell none"><span class="d">${day}</span><span class="p">·</span></div>`;
        } else if (!e.price) {
          html += `<button class="cell none noflight${ageDays(e.checkedAt) > STALE_DAYS ? ' old' : ''}" data-date="${iso}" data-route="${routeId}"><span class="d">${day}</span><span class="p">없음</span></button>`;
        } else {
          const cls = ['cell', 'has', `h${level(e.price)}`];
          if (ageDays(e.checkedAt) > STALE_DAYS) cls.push('old');
          if (best && best.date === iso) cls.push('best');
          html += `<button class="${cls.join(' ')}" data-date="${iso}" data-route="${routeId}" aria-label="${mdw(iso)} ${won(e.price)}"><span class="d">${day}</span><span class="p">${man(e.price)}</span></button>`;
        }
      }
      html += '</div></div>';
      cursor = new Date(Date.UTC(y, m + 1, 1)).toISOString().slice(0, 10);
    }
    $('calendar').innerHTML = html;
  }

  function renderCombos() {
    const stay = STAYS.find((s) => s.id === stayId) || STAYS[0];
    const [outId, backId] = [data.meta.routes[0].id, data.meta.routes[1].id];
    const outs = entries(outId).filter((e) => e.price);
    const backs = entries(backId).filter((e) => e.price);
    const combos = [];
    for (const o of outs) {
      for (const b of backs) {
        const n = diffDays(o.date, b.date);
        if (n >= stay.min && n <= stay.max) combos.push({ o, b, n, total: o.price + b.price });
      }
    }
    combos.sort((a, b) => a.total - b.total);
    if (!combos.length) {
      $('comboList').innerHTML = `<li class="empty">이 기간에 맞는 조합이 아직 없습니다. 날짜가 더 채워지면 나타납니다.</li>`;
      return;
    }
    const r0 = route(outId);
    $('comboList').innerHTML = combos.slice(0, 5).map((c, i) => {
      const l = links({ from: r0.from, to: r0.to, date: c.o.date, back: c.b.date });
      return `<li><div class="row combo">
        <span class="rank">${i + 1}</span>
        <span class="row-main">
          <div class="combo-dates"><span>${mdw(c.o.date)} → ${mdw(c.b.date)} <span class="age">· ${c.n}박</span></span><span class="price">${won(c.total)}</span></div>
          <div class="combo-legs">가는 편 ${won(c.o.price)} (${esc(c.o.options[0].airlines.map(airlineName).join('·'))}) + 오는 편 ${won(c.b.price)} (${esc(c.b.options[0].airlines.map(airlineName).join('·'))})</div>
          <div class="combo-legs"><a href="${l.google}" target="_blank" rel="noopener">구글 왕복 비교</a> · <a href="${l.skyscanner}" target="_blank" rel="noopener">스카이스캐너</a> · <a href="${l.naver}" target="_blank" rel="noopener">네이버</a></div>
        </span>
      </div></li>`;
    }).join('');
  }

  function renderEvents() {
    const ev = (data.events || []).slice(0, 8);
    if (!ev.length) {
      $('events').innerHTML = `<li class="empty">아직 변동 소식이 없습니다.</li>`;
      return;
    }
    $('events').innerHTML = ev.map((e) => {
      const r = route(e.route);
      const tag = e.type === 'newLow' ? '최저가' : '가격 내림';
      const body = e.type === 'newLow'
        ? `${esc(r?.label)} ${mdw(e.date)} ${won(e.price)}`
        : `${esc(r?.label)} ${mdw(e.date)} ${won(e.prev)} → <b>${won(e.price)}</b>`;
      return `<li><span class="tag">${tag}</span><span>${body}</span><span class="when">${stamp(e.at).split(' ')[0]}</span></li>`;
    }).join('');
  }

  function sparkline(history) {
    const pts = (history || []).filter((h) => h.p);
    if (pts.length < 2) return '';
    const ps = pts.map((h) => h.p);
    const lo = Math.min(...ps);
    const hi = Math.max(...ps);
    const W = 300;
    const H = 50;
    const xy = pts.map((h, i) => [
      (i / (pts.length - 1)) * (W - 8) + 4,
      hi === lo ? H / 2 : H - 6 - ((h.p - lo) / (hi - lo)) * (H - 12),
    ]);
    const path = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const [lx, ly] = xy[xy.length - 1];
    return `<div class="spark"><div class="cap"><span>이 날짜 가격 흐름 (${pts.length}번 확인)</span><span>${won(lo)} ~ ${won(hi)}</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="가격 흐름"><path d="${path}" fill="none" stroke="var(--brand)" stroke-width="2" vector-effect="non-scaling-stroke"/><circle cx="${lx}" cy="${ly}" r="3.5" fill="var(--brand)"/></svg></div>`;
  }

  function openSheet(id, date) {
    const r = route(id);
    const e = data.routes[id]?.[date];
    if (!r || !e) return;
    $('sheetSub').textContent = `${r.label} · 편도 1인 · ${ageText(e.checkedAt)}`;
    $('sheetTitle').textContent = `${date.slice(0, 4)}년 ${mdw(date)}`;

    let body = '';
    if (!e.options?.length) {
      body += `<p class="empty">이날은 조건(항공사·경유 대기시간)에 맞는 항공편이 없었습니다.</p>`;
    }
    e.options.forEach((o, i) => {
      body += `<div class="opt${i === 0 ? ' first' : ''}">
        <div class="opt-head"><span class="opt-air">${esc(o.airlines.map(airlineName).join(' · '))}</span><span class="price">${won(o.price)}</span></div>
        <div class="opt-meta">총 ${hm(o.total)} · 경유 ${o.lays.length}회</div>`;
      o.segs.forEach((s, j) => {
        const nextDay = s.arr.slice(0, 10) > o.segs[0].dep.slice(0, 10) ? ' <small>+1</small>' : '';
        body += `<div class="leg"><span class="no">${esc(s.no)}</span><span class="t">${hhmm(s.dep)} ${esc(AIRPORTS[s.from] || s.from)} → ${hhmm(s.arr)}${nextDay} ${esc(AIRPORTS[s.to] || s.to)}</span></div>`;
        if (o.lays[j]) body += `<div class="lay">⏱ ${esc(AIRPORTS[o.lays[j].at] || o.lays[j].at)}에서 ${hm(o.lays[j].min)} 대기${o.lays[j].overnight ? ' (밤샘)' : ''}</div>`;
      });
      body += '</div>';
    });

    body += sparkline(e.history);

    const topAir = e.options?.[0]?.airlines?.length === 1 ? e.options[0].airlines[0] : null;
    const l = links({ from: r.from, to: r.to, date, airline: topAir });
    const lAll = links({ from: r.from, to: r.to, date });
    body += `<div class="links">
      <a class="btn primary" href="${l.google}" target="_blank" rel="noopener">구글 플라이트에서 지금 가격 보기${topAir ? ` (${airlineName(topAir)})` : ''}</a>
      <a class="btn" href="${lAll.skyscanner}" target="_blank" rel="noopener">스카이스캐너</a>
      <a class="btn" href="${lAll.naver}" target="_blank" rel="noopener">네이버항공권</a>
      ${topAir ? `<a class="btn" href="${AIRLINES[topAir].site}" target="_blank" rel="noopener">${airlineName(topAir)} 홈페이지</a>` : ''}
      <a class="btn" href="${lAll.google}" target="_blank" rel="noopener">구글 (전체 항공사)</a>
    </div>`;

    $('sheetBody').innerHTML = body;
    const sheet = $('sheet');
    if (typeof sheet.showModal === 'function') sheet.showModal();
    else sheet.setAttribute('open', '');
  }

  function renderAll() {
    if (!data.meta.routes.some((r) => r.id === routeId)) routeId = data.meta.routes[0].id;
    renderHeader();
    renderTabs();
    renderTop();
    renderCalendar();
    renderCombos();
    renderEvents();
  }

  async function load() {
    const btn = $('reload');
    btn.classList.add('spin');
    try {
      const res = await fetch(`data/prices.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      if (!data.meta?.routes) throw new Error('아직 데이터가 없습니다');
      renderAll();
    } catch (err) {
      if (!data) $('status').textContent = `불러오지 못했습니다 (${err.message})`;
    } finally {
      btn.classList.remove('spin');
    }
  }

  // ── 이벤트 ────────────────────────────────────────────
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-route][data-date]');
    if (t) return openSheet(t.dataset.route, t.dataset.date);
    const rt = ev.target.closest('[data-route]');
    if (rt) { routeId = rt.dataset.route; store.set('route', routeId); return renderAll(); }
    const st = ev.target.closest('[data-stay]');
    if (st) { stayId = st.dataset.stay; store.set('stay', stayId); renderTabs(); return renderCombos(); }
  });
  $('reload').addEventListener('click', load);
  $('sheetClose').addEventListener('click', () => $('sheet').close());
  $('sheet').addEventListener('click', (ev) => { if (ev.target === $('sheet')) $('sheet').close(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && data) load(); });

  let installEvent = null;
  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    installEvent = ev;
    $('installBtn').hidden = false;
  });
  $('installBtn').addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice.catch(() => null);
    installEvent = null;
    $('installBtn').hidden = true;
  });
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) $('installBox').hidden = true;

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  load();
})();
