// 데이터 저장 계층. 앱은 이 로컬 저장소를 기준으로 동작하고(빠르고 오프라인 가능),
// 클라우드 동기화(sync.js)는 아래 훅을 통해 변경 사항을 주고받는다.
//
// card 필드
//   type     'basic'(앞/뒤) | 'cloze'(front 안에 {{빈칸}} 표시)
//   tags     태그 배열
//   reverse  양방향 여부 (basic 전용: 뒤→앞도 복습)
//   box/due  앞→뒤(또는 빈칸) 복습 상태,  rbox/rdue  뒤→앞 복습 상태
//   wrong    틀린 횟수,  note  오답노트 포함 여부,  streak  오답노트에서 연속 정답 횟수
//   updated  마지막 수정 시각(ms). 기기 간 충돌 시 더 최근 것이 이긴다.
const Store = (() => {
  const KEY = 'flashcard-data-v1';

  const normalizeCard = c => ({
    type: 'basic', tags: [], reverse: false,
    box: 0, due: 0, rbox: 0, rdue: 0,
    wrong: 0, note: false, streak: 0, updated: 0,
    ...c,
    tags: Array.isArray(c.tags) ? c.tags : []
  });

  function normalize(data) {
    return {
      decks: Array.isArray(data.decks) ? data.decks : [],
      cards: Array.isArray(data.cards) ? data.cards.map(normalizeCard) : []
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) { /* 손상된 데이터는 빈 상태로 시작 */ }
    return { decks: [], cards: [] };
  }

  let data = load();

  function save() {
    localStorage.setItem(KEY, JSON.stringify(data));
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const copy = c => ({ ...c, tags: [...c.tags] });

  // 동기화 훅
  const writeListeners = [];   // 로컬에서 바뀐 것 → 클라우드로
  const remoteListeners = [];  // 클라우드에서 바뀐 것이 반영됨 → 화면 갱신
  const emit = (kind, op, item) => {
    for (const fn of writeListeners) {
      try { fn({ kind, op, item }); } catch (e) { /* 동기화 오류가 앱을 막지 않게 */ }
    }
  };

  return {
    async listDecks() {
      return data.decks.map(d => ({ ...d }));
    },
    // kind: 'script'(대화 스크립트 덱) | 생략하면 일반 카드 덱
    async addDeck(name, kind) {
      const deck = { id: uid(), name, created: Date.now(), updated: Date.now(), ...(kind ? { kind } : {}) };
      data.decks.push(deck);
      save();
      emit('deck', 'set', { ...deck });
      return { ...deck };
    },
    async renameDeck(id, name) {
      const d = data.decks.find(d => d.id === id);
      if (!d) return;
      d.name = name;
      d.updated = Date.now();
      save();
      emit('deck', 'set', { ...d });
    },
    async deleteDeck(id) {
      const removed = data.cards.filter(c => c.deckId === id);
      data.decks = data.decks.filter(d => d.id !== id);
      data.cards = data.cards.filter(c => c.deckId !== id);
      save();
      removed.forEach(c => emit('card', 'delete', { id: c.id }));
      emit('deck', 'delete', { id });
    },

    async listCards(deckId) {
      return data.cards.filter(c => c.deckId === deckId).map(copy);
    },
    async listAllCards() {
      return data.cards.map(copy);
    },
    // fields: { type, front, back, tags, reverse }
    async addCard(deckId, fields) {
      const card = normalizeCard({ ...fields, id: uid(), deckId, created: Date.now(), updated: Date.now() });
      data.cards.push(card);
      save();
      emit('card', 'set', copy(card));
      return copy(card);
    },
    async updateCard(id, patch) {
      const c = data.cards.find(c => c.id === id);
      if (!c) return;
      Object.assign(c, patch, { updated: Date.now() });
      save();
      emit('card', 'set', copy(c));
    },
    async deleteCard(id) {
      data.cards = data.cards.filter(c => c.id !== id);
      save();
      emit('card', 'delete', { id });
    },

    async exportAll() {
      return JSON.stringify(data, null, 2);
    },
    async importAll(text) {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed.decks) || !Array.isArray(parsed.cards)) {
        throw new Error('올바른 백업 파일이 아닙니다.');
      }
      const next = normalize(parsed);
      const now = Date.now();
      next.decks.forEach(d => { d.updated = now; });
      next.cards.forEach(c => { c.updated = now; });

      // 가져오기로 사라지는 항목은 클라우드에서도 지운다.
      const deckIds = new Set(next.decks.map(d => d.id));
      const cardIds = new Set(next.cards.map(c => c.id));
      data.cards.filter(c => !cardIds.has(c.id)).forEach(c => emit('card', 'delete', { id: c.id }));
      data.decks.filter(d => !deckIds.has(d.id)).forEach(d => emit('deck', 'delete', { id: d.id }));

      data = next;
      save();
      next.decks.forEach(d => emit('deck', 'set', { ...d }));
      next.cards.forEach(c => emit('card', 'set', copy(c)));
    },

    // ----- 동기화용 -----
    onLocalWrite(fn) { writeListeners.push(fn); },
    onRemoteChange(fn) { remoteListeners.push(fn); },
    snapshot() {
      return { decks: data.decks.map(d => ({ ...d })), cards: data.cards.map(copy) };
    },
    // changes: [{ kind: 'deck'|'card', op: 'set'|'delete', item }]
    // 더 최근에 수정된 쪽이 이긴다(last-write-wins).
    applyRemote(changes) {
      let changed = false;
      let deckDeleted = false;
      for (const { kind, op, item } of changes) {
        const list = kind === 'deck' ? data.decks : data.cards;
        const i = list.findIndex(x => x.id === item.id);
        if (op === 'delete') {
          if (i >= 0) { list.splice(i, 1); changed = true; deckDeleted ||= kind === 'deck'; }
        } else if (i < 0) {
          list.push(kind === 'card' ? normalizeCard(item) : { ...item });
          changed = true;
        } else if ((item.updated || 0) > (list[i].updated || 0)) {
          list[i] = kind === 'card' ? normalizeCard(item) : { ...item };
          changed = true;
        }
      }
      if (deckDeleted) {
        const ids = new Set(data.decks.map(d => d.id));
        data.cards = data.cards.filter(c => ids.has(c.deckId));
      }
      if (changed) {
        save();
        remoteListeners.forEach(fn => { try { fn(); } catch (e) { /* 무시 */ } });
      }
    },

    // 브라우저가 저장소를 임의로 지우지 않도록 요청한다.
    async requestPersistence() {
      if (navigator.storage && navigator.storage.persist) {
        try { await navigator.storage.persist(); } catch (e) { /* 무시 */ }
      }
    }
  };
})();
