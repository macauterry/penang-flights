// 앱을 설치형(홈 화면)으로 쓰기 위한 서비스 워커.
// 화면 파일은 저장해 두고, 가격 데이터는 항상 인터넷에서 최신 것을 먼저 받아옵니다 (안 되면 마지막 저장본).
const CACHE = 'penang-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // 가격 데이터와 화면 파일 모두 "인터넷 먼저, 안 되면 저장본" — 고친 내용이 바로 반영됩니다.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          const key = url.pathname.endsWith('/data/prices.json') ? new Request(url.origin + url.pathname) : e.request;
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(url.pathname.endsWith('/data/prices.json') ? new Request(url.origin + url.pathname) : e.request, { ignoreSearch: true }))
  );
});
