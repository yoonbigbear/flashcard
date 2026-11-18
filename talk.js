// 대화 질문 덱: 보이스룸 같은 대화방에서 바로 꺼내 쓸 질문·맞장구를 일본어와 영어로 같이 적어 두는 덱.
//
// 카드(type 'basic')
//   front  한국어 (하고 싶은 말),  back  일본어,  en  영어
//   pronJa 일본어 읽기,  pronKo  한국어 발음 (비워 두면 읽기에서 만든다)
//   talk   true (대화 질문 카드 표시),  tags  [주제]
// 앞면(한국어)을 보고 일본어·영어로 말해 본 뒤 뒤집어 맞춰 본다. 일반 카드처럼 복습 일정이 돈다.
//
// 데이터(talk-data.json)
//   categories  [[주제, [[한국어, 일본어, 읽기, 영어], ...]], ...]
//   읽기는 jlpt-data.json 과 같은 규칙이다(띄어 쓰고, 와로 소리 나는 は 앞에 | 를 붙인다).
let talkDataPromise = null;
function loadTalkData() {
  if (!talkDataPromise) {
    talkDataPromise = fetch('talk-data.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(e => { talkDataPromise = null; throw e; });
  }
  return talkDataPromise;
}

const isTalkDeck = deck => !!deck && deck.kind === 'talk';

// 직접 적은 읽기로 한국어 발음을 만든다 (jlpt.js 의 jlptKo 와 같은 규칙).
const talkKo = read => (read ? jlptKo(read) : '');

// 덱을 만들고, fill 이면 기본 질문을 채운다.
async function createTalkDeck(name, fill) {
  const deck = await Store.addDeck(name, 'talk');
  if (!fill) return deck;
  const { categories } = await loadTalkData();
  let no = 0;
  await Store.addCards(deck.id, categories.flatMap(([topic, list]) => list.map(([ko, ja, read, en]) => ({
    type: 'basic', talk: true, front: ko, back: ja, en,
    pronJa: jlptReading(read), pronKo: talkKo(read), tags: [topic], no: ++no
  }))));
  return deck;
}

// 뒷면에 일본어 아래로 보이는 영어·발음 줄
function talkNodes(card) {
  return [
    card.en ? h('div', { class: 'pron', lang: 'en' }, h('span', { class: 'pron-label', lang: 'ko' }, '영어'), card.en) : null,
    pronNodes(card)
  ];
}
