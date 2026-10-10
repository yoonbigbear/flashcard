// 데이터 저장 계층. 나중에 Firebase/Supabase로 바꿀 때 이 파일만 교체하면 되도록
// 모든 함수를 Promise 기반 인터페이스로 맞춰 두었다.
//
// card 필드
//   type     'basic'(앞/뒤) | 'cloze'(front 안에 {{빈칸}} 표시)
//   tags     태그 배열
//   reverse  양방향 여부 (basic 전용: 뒤→앞도 복습)
//   box/due  앞→뒤(또는 빈칸) 복습 상태,  rbox/rdue  뒤→앞 복습 상태
//   wrong    틀린 횟수,  note  오답노트 포함 여부,  streak  오답노트에서 연속 정답 횟수
const Store = (() => {
  const KEY = 'flashcard-data-v1';

  const normalizeCard = c => ({
    type: 'basic', tags: [], reverse: false,
    box: 0, due: 0, rbox: 0, rdue: 0,
    wrong: 0, note: false, streak: 0,
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

  return {
    async listDecks() {
      return data.decks.map(d => ({ ...d }));
    },
    async addDeck(name) {
      const deck = { id: uid(), name, created: Date.now() };
      data.decks.push(deck);
      save();
      return deck;
    },
    async renameDeck(id, name) {
      const d = data.decks.find(d => d.id === id);
      if (d) { d.name = name; save(); }
    },
    async deleteDeck(id) {
      data.decks = data.decks.filter(d => d.id !== id);
      data.cards = data.cards.filter(c => c.deckId !== id);
      save();
    },

    async listCards(deckId) {
      return data.cards.filter(c => c.deckId === deckId).map(copy);
    },
    async listAllCards() {
      return data.cards.map(copy);
    },
    // fields: { type, front, back, tags, reverse }
    async addCard(deckId, fields) {
      const card = normalizeCard({ ...fields, id: uid(), deckId, created: Date.now() });
      data.cards.push(card);
      save();
      return copy(card);
    },
    async updateCard(id, patch) {
      const c = data.cards.find(c => c.id === id);
      if (c) { Object.assign(c, patch); save(); }
    },
    async deleteCard(id) {
      data.cards = data.cards.filter(c => c.id !== id);
      save();
    },

    async exportAll() {
      return JSON.stringify(data, null, 2);
    },
    async importAll(text) {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed.decks) || !Array.isArray(parsed.cards)) {
        throw new Error('올바른 백업 파일이 아닙니다.');
      }
      data = normalize(parsed);
      save();
    },

    // 브라우저가 저장소를 임의로 지우지 않도록 요청한다.
    async requestPersistence() {
      if (navigator.storage && navigator.storage.persist) {
        try { await navigator.storage.persist(); } catch (e) { /* 무시 */ }
      }
    }
  };
})();
