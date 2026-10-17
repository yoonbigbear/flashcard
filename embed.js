// 의미 검색(임베딩): 글이 아니라 "뜻"이 비슷한 카드를 찾는다. (犬 ↔ 猫, 개 ↔ dog)
// 설정에서 켜야만 동작한다. 켜면 작은 다국어 모델(약 135MB)을 한 번 받아 브라우저 안에서 계산하고,
// 카드 내용은 밖으로 나가지 않는다.
//
// 저장
//   모델 파일  Transformers.js 가 브라우저 Cache Storage('transformers-cache')에 둔다.
//   카드 벡터  IndexedDB('flashcard-embed'). 카드 글의 해시가 바뀐 카드만 다시 계산한다.
//              카드에서 언제든 다시 만들 수 있는 값이라 동기화·백업하지 않는다.
const Embed = (() => {
  const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/transformers.min.js';
  const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
  const FLAG = 'flashcard-embed-on';
  const DB_NAME = 'flashcard-embed';
  const STORE = 'vecs';
  const BATCH = 16;
  const SCALE = 127; // 정규화된 벡터를 8비트 정수로 줄여 저장한다 (카드당 384바이트)

  const isEnabled = () => {
    try { return localStorage.getItem(FLAG) === '1'; } catch (e) { return false; }
  };

  // ---------- 모델 ----------
  let extractorPromise = null;

  // onProgress(받은 바이트, 전체 바이트)
  function load(onProgress) {
    extractorPromise ||= (async () => {
      const { pipeline, env } = await import(LIB);
      env.allowLocalModels = false;
      const files = new Map();
      return pipeline('feature-extraction', MODEL, {
        dtype: 'q8',
        progress_callback: p => {
          if (p.status !== 'progress' || !p.total) return;
          files.set(p.file, { loaded: p.loaded, total: p.total });
          let loaded = 0, total = 0;
          for (const f of files.values()) { loaded += f.loaded; total += f.total; }
          if (onProgress) onProgress(loaded, total);
        }
      });
    })().catch(e => { extractorPromise = null; throw e; });
    return extractorPromise;
  }

  // 글 목록 → 정규화된 벡터(Int8Array) 목록
  async function embedTexts(texts) {
    const extractor = await load();
    const out = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const t = await extractor(texts.slice(i, i + BATCH), { pooling: 'mean', normalize: true });
      const dim = t.dims[t.dims.length - 1];
      for (let j = 0; j < t.dims[0]; j++) {
        out.push(Int8Array.from(t.data.slice(j * dim, (j + 1) * dim), v => Math.round(v * SCALE)));
      }
    }
    return out;
  }

  const dot = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s / (SCALE * SCALE);
  };

  // ---------- 카드 → 글 ----------
  const cardText = c => [
    String(c.front || '').replace(/\{\{(.+?)\}\}/g, '$1'),
    c.back,
    String(c.example || '').replace(/\s*\n\s*/g, ' '),
    (c.tags || []).join(' ')
  ].filter(Boolean).join(' / ');

  const hashOf = s => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h);
  };

  // ---------- IndexedDB ----------
  const openDb = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function readAll() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const map = new Map();
      const req = db.transaction(STORE).objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) { map.set(cur.key, cur.value); cur.continue(); } else { db.close(); resolve(map); }
      };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }

  async function writeMany(entries) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const [id, value] of entries) store.put(value, id);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  // ---------- 색인 ----------
  // 바뀌었거나 새로 생긴 카드만 계산한다. 반환: Map(카드 id → { hash, vec })
  // 동시에 여러 번 불러도 순서대로 하나씩 돌아간다.
  let lock = Promise.resolve();
  function ensureIndex(cards, onProgress) {
    const run = async () => {
      const stored = await readAll();
      const todo = [];
      for (const c of cards) {
        const text = cardText(c);
        const hash = hashOf(text);
        const s = stored.get(c.id);
        if (!s || s.hash !== hash) todo.push({ id: c.id, text, hash });
      }
      for (let i = 0; i < todo.length; i += BATCH) {
        const part = todo.slice(i, i + BATCH);
        const vecs = await embedTexts(part.map(p => p.text));
        const entries = part.map((p, j) => [p.id, { hash: p.hash, vec: vecs[j] }]);
        await writeMany(entries);
        for (const [id, v] of entries) stored.set(id, v);
        if (onProgress) onProgress(Math.min(i + BATCH, todo.length), todo.length);
      }
      return stored;
    };
    const p = lock.then(run);
    lock = p.catch(() => {});
    return p;
  }

  // 다른 카드들과의 뜻 유사도(-1~1). 반환: Map(카드 id → 유사도)
  function scoreAgainst(q, cards, index, skipId) {
    const sims = new Map();
    for (const c of cards) {
      const s = index.get(c.id);
      if (c.id !== skipId && s) sims.set(c.id, dot(q, s.vec));
    }
    return sims;
  }

  async function similarTo(card, cards, onProgress) {
    const index = await ensureIndex(cards, onProgress);
    const own = index.get(card.id);
    return own ? scoreAgainst(own.vec, cards, index, card.id) : new Map();
  }

  async function similarToText(text, cards, onProgress) {
    const index = await ensureIndex(cards, onProgress);
    const [q] = await embedTexts([text]);
    return scoreAgainst(q, cards, index, null);
  }

  // ---------- 켜기 / 끄기 ----------
  async function enable(onProgress) {
    await load(onProgress);
    localStorage.setItem(FLAG, '1');
  }

  async function disable() {
    try { localStorage.removeItem(FLAG); } catch (e) { /* 무시 */ }
    extractorPromise = null;
    await new Promise(resolve => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
    try { await caches.delete('transformers-cache'); } catch (e) { /* 무시 */ }
  }

  return { isEnabled, enable, disable, ensureIndex, similarTo, similarToText };
})();
window.Embed = Embed; // 최상위 const 는 window 에 붙지 않으므로 직접 노출한다
