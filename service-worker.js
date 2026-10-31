// 앱 파일을 수정해서 배포할 때마다 CACHE 버전을 올려야 폰에 새 버전이 반영된다.
const CACHE = 'flashcard-v35';
// 일본어 사전(약 17MB)은 앱 버전이 바뀌어도 다시 받지 않도록 별도 캐시에 둔다.
const DICT_CACHE = 'flashcard-dict-v1';
const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'storage.js',
  'japanese.js',
  'kuromoji-worker.js',
  'search.js',
  'embed.js',
  'script.js',
  'sync.js',
  'firebase-config.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', e => {
  // cache: 'reload' 로 브라우저 HTTP 캐시를 건너뛰고 항상 새로 받는다.
  e.waitUntil(caches.open(CACHE).then(c =>
    c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== DICT_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Firebase SDK: 처음 한 번 받아 두면 오프라인에서도 앱이 켜진다.
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    e.respondWith(caches.open(CACHE).then(async cache => {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }));
    return;
  }

  // 일본어 사전(kuromoji)과 의미 검색 라이브러리(Transformers.js, onnxruntime): 처음 한 번 받아 두면 이후엔 오프라인에서도 쓴다.
  // (모델 파일은 Transformers.js 가 자체 캐시에 보관한다)
  if (url.hostname === 'cdn.jsdelivr.net' && /^\/npm\/(kuromoji@|@huggingface\/transformers@|onnxruntime-web@)/.test(url.pathname)) {
    e.respondWith(caches.open(DICT_CACHE).then(async cache => {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }));
    return;
  }

  // 그 외 외부 요청(Firestore, 구글 로그인 등)은 건드리지 않는다.
  if (url.origin !== location.origin) return;

  // 네트워크 우선(항상 최신 버전), 오프라인이면 캐시.
  // no-cache: 브라우저 HTTP 캐시(GitHub Pages 는 max-age=600)가 아니라 서버에 최신인지 물어서 받는다.
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request)));
});
