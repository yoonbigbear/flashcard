// JLPT 단어 덱: 급수(N5·N4·N3)별 단어를 미리 채워 두고 공부하는 일반 카드 덱.
//
// 카드(type 'basic')
//   front  단어(한자 표기가 있으면 한자),  back  한국어 뜻,  pronJa  읽기(히라가나/가타카나, 표기와 같으면 비움)
//   vocab  true (이 덱에서 만든 단어 카드 표시),  no  덱 안에서의 순서,  tags  [급수]
//
// 학습: 한 번도 학습하지 않은 단어(새 단어)는 '복습'에 세지 않고, 학습을 시작할 때
//       순서대로 VOCAB_NEW_BATCH 개씩 섞어 넣는다. 한 번 평가하면 그 뒤로는 일반 카드처럼 복습 일정이 돈다.
//       (한자 덱의 새 한자와 같은 방식이다. kanji.js 참고)
//
// 데이터(vocab-data.json): 단어와 읽기는 open-anki-jlpt-decks(jamsinclair)의 JLPT 단어 목록
//       (Tanos 등 공개 목록 기반)에서 가져왔고, 한국어 뜻은 영어 뜻을 바탕으로 따로 번역했다.
//       JLPT 는 공식 단어 목록이 없어서, 이 목록은 시험에 자주 나오는 단어를 급수별로 묶은 참고용이다.
const VOCAB_LEVELS = [
  ['N5', 'JLPT N5 · 718개 (가장 기초)'],
  ['N4', 'JLPT N4 · 668개'],
  ['N3', 'JLPT N3 · 2140개'],
  ['', '일반 카드 덱 (빈 덱)']
];
const VOCAB_NEW_BATCH = 20; // 학습 한 번에 새로 넣는 단어 수

// 아직 한 번도 학습(평가)하지 않은 JLPT 단어
const isNewVocab = c => !!c.vocab && !c.due;

// 다음에 새로 배울 단어 (순서대로 VOCAB_NEW_BATCH 개)
function newVocabItems(cards) {
  return cards.filter(isNewVocab)
    .sort((a, b) => (a.no || 1e9) - (b.no || 1e9) || a.created - b.created)
    .slice(0, VOCAB_NEW_BATCH)
    .map(card => ({ card, dir: 'f' }));
}

let vocabDataPromise = null;
function loadVocabData() {
  if (!vocabDataPromise) {
    vocabDataPromise = fetch('vocab-data.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(e => { vocabDataPromise = null; throw e; });
  }
  return vocabDataPromise;
}

// 단어 덱을 만들고, 급수를 골랐으면 그 급수의 단어를 채운다.
async function createVocabDeck(name, level) {
  const list = level ? (await loadVocabData()).levels[level] : [];
  if (!list) throw new Error('unknown level');
  const deck = await Store.addDeck(name);
  await Store.addCards(deck.id, list.map(([word, reading, mean], i) => ({
    type: 'basic', front: word, back: mean,
    pronJa: reading && reading !== word ? reading : '',
    tags: [level], vocab: true, no: i + 1
  })));
  return deck;
}
