// 대한항공(쿠알라룸푸르 도착/출발) ↔ 페낭 집 육상·국내선 이동수단 계산
// 자료: 페낭_여정가이드.md (2026-09-05~06 조사: KTMB 시간표, KLIA Ekspres/Transit, 버스 예매사이트, 전세차 업체 요금)
// 시각은 모두 말레이시아 현지 시각입니다.
(() => {
  'use strict';

  const SURVEYED = '2026-09-06';

  // ETS 고속열차 (KTMB)
  const ETS_TO_BUTTERWORTH = [
    { no: 'EP 9124', dep: '08:05', arr: '12:10', rm: 79 },
    { no: 'EX 9108', dep: '11:40', arr: '15:15', rm: 86 },
    { no: 'EP 9130', dep: '13:40', arr: '17:45', rm: 79 },
    { no: 'EP 9136', dep: '15:55', arr: '20:00', rm: 79 },
    { no: 'EG 9352', dep: '18:22', arr: '22:42', rm: 59 },
    { no: 'EP 9138', dep: '20:15', arr: '00:20', rm: 79 },
  ];
  const ETS_TO_KL = [
    { no: 'EP 9121', dep: '05:15', arr: '09:20', rm: 79 },
    { no: 'EP 9123', dep: '06:30', arr: '10:35', rm: 79 },
    { no: 'EP 9323', dep: '07:00', arr: '11:05', rm: 79 },
    { no: 'EG 9343', dep: '07:50', arr: '12:10', rm: 59 },
    { no: 'EX 9109', dep: '13:05', arr: '16:40', rm: 85 },
    { no: 'EP 9133', dep: '16:05', arr: '20:10', rm: 79 },
    { no: 'EP 9135', dep: '18:45', arr: '22:50', rm: 79 },
  ];

  const LINKS = {
    charter: [
      { name: 'Klook 전세차', url: 'https://www.klook.com/ko/search/result/?query=KLIA%20Penang%20private%20transfer' },
      { name: 'KKday 전세차', url: 'https://www.kkday.com/ko/product/productlist?keyword=KLIA%20Penang%20transfer' },
    ],
    bus: [
      { name: 'Easybook', url: 'https://www.easybook.com/en-my/bus' },
      { name: 'BusOnlineTicket', url: 'https://www.busonlineticket.com/' },
      { name: 'redBus', url: 'https://www.redbus.my/' },
    ],
    rail: [
      { name: 'KTMB (ETS 기차)', url: 'https://online.ktmb.com.my/' },
      { name: 'KLIA Ekspres', url: 'https://www.kliaekspres.com/' },
    ],
    transit: [
      { name: 'KLIA Transit', url: 'https://www.kliaekspres.com/' },
      { name: 'BusOnlineTicket (TBS)', url: 'https://www.busonlineticket.com/' },
    ],
    car: [{ name: '렌터카 비교 (Klook)', url: 'https://www.klook.com/ko/car-rentals/' }],
  };

  // "2026-10-15 22:25" → 분 (날짜 포함 절대값)
  const toMin = (s) => {
    const t = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16));
    return t / 60000;
  };
  const fromMin = (m) => new Date(m * 60000).toISOString().slice(0, 16).replace('T', ' ');
  const dayStart = (m) => Math.floor(m / 1440) * 1440;
  const hhmmToMin = (base, hhmm) => dayStart(base) + +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);

  function nextTrain(list, earliest) {
    for (let d = 0; d < 2; d++) {
      for (const t of list) {
        const dep = hhmmToMin(earliest, t.dep) + d * 1440;
        if (dep >= earliest) {
          let arr = hhmmToMin(dep, t.arr);
          if (arr < dep) arr += 1440;
          return { ...t, depMin: dep, arrMin: arr, nextDay: d > 0 };
        }
      }
    }
    return null;
  }
  function lastTrain(list, latestArrival) {
    for (let d = 0; d < 2; d++) {
      for (const t of [...list].reverse()) {
        const dep = hhmmToMin(latestArrival, t.dep) - d * 1440;
        let arr = hhmmToMin(dep, t.arr);
        if (arr < dep) arr += 1440;
        if (arr <= latestArrival) return { ...t, depMin: dep, arrMin: arr, prevDay: d > 0 };
      }
    }
    return null;
  }
  const clock = (m) => fromMin(m).slice(11, 16);
  const isNight = (m) => { const h = ((m % 1440) + 1440) % 1440 / 60; return h >= 23 || h < 6; };

  /**
   * 가는 길: 대한항공 쿠알라룸푸르(KLIA T1) 도착 → 페낭 집
   * @param {string} arrival "YYYY-MM-DD HH:MM" 현지 도착 시각
   */
  function outbound(arrival) {
    const A = toMin(arrival);
    const ready = A + 60; // 입국심사 + 짐 찾기
    const opts = [];

    // 1) 전세차
    {
      const dep = ready + 10;
      const home = dep + 255;
      opts.push({
        key: 'charter', icon: '🚗', name: '전세차 (기사 대기)', ok: true,
        depart: dep, home, wait: dep - ready, ride: 255,
        rm: [isNight(dep) ? 750 : 650, isNight(dep) ? 900 : 750],
        detail: `KLIA 도착층에서 기사가 이름표 들고 대기 → 페낭 집 앞까지 한 번에. 1~4인 같은 값${isNight(dep) ? ' · 심야 할증 가능' : ''}. 항공편 번호를 알려주면 연착돼도 기다려 줍니다.`,
        links: LINKS.charter,
      });
    }

    // 2) KLIA 직행 고속버스 (대략 1~2시간 간격, 막차 23:59)
    {
      const dayEnd = dayStart(ready) + 23 * 60 + 59;
      const firstBus = dayStart(ready) + 8 * 60;
      let dep = Math.max(ready + 20, firstBus);
      dep = Math.ceil(dep / 60) * 60; // 정시 출발 가정
      let note = '버스 시각은 예매 사이트에서 확인 (대략 1~2시간 간격)';
      if (dep > dayEnd && ready + 15 <= dayEnd) { dep = dayEnd; note = '23:59 막차 · 비행기가 늦으면 놓칠 수 있음'; }
      const ok = dep <= dayEnd;
      if (!ok) dep = dayStart(ready) + 1440 + 8 * 60;
      const home = dep + 330 + 30;
      opts.push({
        key: 'bus', icon: '🚌', name: 'KLIA 직행 고속버스', ok, sameDay: ok,
        depart: dep, home, wait: dep - ready, ride: 360, rm: [55 + 20, 64 + 30],
        detail: `${ok ? note : '그날 버스 없음 → 다음날 아침 첫차 (공항 근처 1박)'} · Sungai Nibong(페낭 섬) 하차 후 Grab 30분`,
        links: LINKS.bus,
      });
    }

    // 3) KLIA Transit → TBS → 고속버스 (TBS 심야버스 ~01:30)
    {
      const transitLast = dayStart(A) + 24 * 60 + 30; // 00:30
      const dep = ready + 15;
      const ok = dep <= transitLast;
      const atTBS = dep + 33 + 20;
      const busDep = atTBS + 40;
      const busOk = ok && busDep <= dayStart(A) + 25 * 60 + 30;
      const home = busDep + 300 + 30;
      opts.push({
        key: 'transit', icon: '🚆', name: 'KLIA Transit → TBS → 고속버스', ok: busOk,
        depart: dep, home, wait: busDep - atTBS + 15, ride: home - dep, rm: [38.4 + 35 + 20, 38.4 + 60 + 30],
        detail: busOk
          ? `KLIA Transit(완행) Bandar Tasik Selatan 하차 → TBS 터미널에서 QR을 실물 승차권으로 교환 → ${clock(busDep)}경 버스`
          : '공항철도 막차(00:30) 또는 TBS 심야버스(~01:30)에 못 맞춤',
        links: LINKS.transit,
      });
    }

    // 4) KLIA Ekspres → KL Sentral → ETS 기차 → 버터워스 → 페리
    {
      const ekspresLast = dayStart(A) + 24 * 60 + 10;
      const ekspresDep = Math.min(ready + 10, ekspresLast);
      const atSentral = ekspresDep + 28 + 20;
      let train = nextTrain(ETS_TO_BUTTERWORTH, atSentral);
      // 00:20 도착 열차는 페리가 끊겨 제외
      if (train && train.no === 'EP 9138') train = nextTrain(ETS_TO_BUTTERWORTH, dayStart(atSentral) + 1440);
      const sameDay = train && !train.nextDay && dayStart(train.depMin) === dayStart(atSentral);
      const home = train ? train.arrMin + 45 : null;
      opts.push({
        key: 'ets', icon: '🚄', name: '공항철도 + ETS 기차 + 페리', ok: Boolean(train), sameDay,
        depart: ekspresDep, home, wait: train ? train.depMin - atSentral : 0, ride: train ? home - ekspresDep : 0,
        rm: [55 + (train?.rm || 79) + 2 + 15, 55 + (train?.rm || 79) + 2 + 25],
        hotel: !sameDay,
        detail: train
          ? `${sameDay ? '' : '그날 기차 없음 → KL 1박 후 '}${train.no} ${train.dep} KL Sentral → ${train.arr} Butterworth → 페리(10~15분) → Grab`
          : '기차 시간표를 찾지 못함',
        links: LINKS.rail,
      });
    }

    // 5) 국내선 KUL → PEN (별도 항공권: 짐 다시 부침)
    {
      const earliestFlight = ready + 90;
      const lastFlight = dayStart(A) + 23 * 60 + 20;
      const sameDay = earliestFlight <= lastFlight;
      const flightDep = sameDay ? earliestFlight + 15 : dayStart(A) + 1440 + 7 * 60;
      const home = flightDep + 60 + 60;
      opts.push({
        key: 'domestic', icon: '🛫', name: '국내선 KUL → 페낭 (따로 예약)', ok: true, sameDay, hotel: !sameDay,
        depart: flightDep, home, wait: flightDep - ready, ride: 60, rm: [150, 350],
        detail: sameDay
          ? '말레이시아항공·에어아시아·바틱에어. 짐을 다시 부쳐야 하고, 앞 비행기 지연 시 보상 없음 (최소 3시간 여유 권장)'
          : '그날 마지막 국내선(약 23:20)에 못 맞춤 → 공항 근처 1박 후 아침 편',
        google: `One-way flights from KUL to PEN on ${fromMin(flightDep).slice(0, 10)}`,
        links: [],
      });
    }

    // 6) 렌터카
    {
      const dep = ready + 40;
      const home = dep + 270;
      opts.push({
        key: 'car', icon: '🚙', name: '렌터카 직접 운전', ok: true,
        depart: dep, home, wait: 40, ride: 270, rm: [107 + 150, 107 + 300],
        detail: '톨 RM 42 + 기름 RM 65 + 렌트비. 좌측통행, 편도 반납료 별도' + (isNight(dep) ? ' · 심야 장거리 운전 주의' : ''),
        links: LINKS.car,
      });
    }

    return { arrival: A, ready, options: opts.map((o) => ({ ...o, departClock: clock(o.depart), homeClock: o.home ? clock(o.home) : '', homeDate: o.home ? fromMin(o.home).slice(0, 10) : '' })) };
  }

  /**
   * 오는 길: 페낭 집 → 대한항공 쿠알라룸푸르(KLIA T1) 출발
   * @param {string} departure "YYYY-MM-DD HH:MM" 현지 출발 시각
   */
  function inbound(departure) {
    const D = toMin(departure);
    const atAirport = D - 180; // 국제선 3시간 전 도착
    const opts = [];

    const add = (o) => opts.push({ ...o, leaveClock: clock(o.leave), leaveDate: fromMin(o.leave).slice(0, 10), arriveClock: clock(o.arrive) });

    add({
      key: 'charter', icon: '🚗', name: '전세차', ok: true, leave: atAirport - 255 - 30, arrive: atAirport - 30, ride: 255,
      rm: [650, 750], detail: '집 앞에서 KLIA T1 출발층까지. 교통체증 대비 30분 여유 포함', links: LINKS.charter,
    });

    add({
      key: 'bus', icon: '🚌', name: '페낭 → KLIA 직행버스', ok: true, leave: atAirport - 60 - 360 - 30, arrive: atAirport - 60, ride: 360,
      rm: [66 + 20, 90 + 30], detail: '편수가 적어 운행 여부·시각을 꼭 확인. 버스 지연 대비 1시간 여유 포함', links: LINKS.bus,
    });

    add({
      key: 'transit', icon: '🚆', name: '고속버스 → TBS → KLIA Transit', ok: true, leave: atAirport - 90 - 33 - 30 - 300 - 30, arrive: atAirport - 90, ride: 300 + 30 + 33,
      rm: [35 + 38.4 + 20, 60 + 38.4 + 30], detail: 'Sungai Nibong 출발 버스. 버스가 1~2시간 늦는 일이 흔해서 1시간 30분 여유 포함', links: LINKS.transit,
    });

    {
      const train = lastTrain(ETS_TO_KL, atAirport - 30 - 28 - 20);
      if (train) {
        add({
          key: 'ets', icon: '🚄', name: '페리 + ETS 기차 + 공항철도', ok: true, leave: train.depMin - 45, arrive: train.arrMin + 20 + 28, ride: train.arrMin + 48 - train.depMin,
          rm: [2 + train.rm + 55 + 15, 2 + train.rm + 55 + 25],
          detail: `${train.no} ${train.dep} Butterworth → ${train.arr} KL Sentral → KLIA Ekspres 28분${train.prevDay ? ' (전날 출발 · KL 1박)' : ''}`,
          hotel: train.prevDay, links: LINKS.rail,
        });
      }
    }

    add({
      key: 'domestic', icon: '🛫', name: '국내선 페낭 → KUL (따로 예약)', ok: true, leave: atAirport - 30 - 60 - 90 - 40, arrive: atAirport - 30, ride: 60,
      rm: [150, 350], detail: '짐을 다시 부쳐야 함. 에어아시아는 klia2(T2) 도착이라 T1까지 이동 10분 추가',
      google: `One-way flights from PEN to KUL on ${fromMin(atAirport).slice(0, 10)}`, links: [],
    });

    return { departure: D, atAirport, atAirportClock: clock(atAirport), options: opts };
  }

  window.Ground = { outbound, inbound, SURVEYED, toMin, fromMin };
})();
