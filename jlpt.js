// JLPT 문법 덱·문장 덱: 급수(N5~N3)를 골라 미리 채워 두는 일반 카드 덱.
// 새 카드 종류는 없고, 원래 있던 카드로 만든다.
//   문법 덱  기본 카드(앞: 문법, 뒤: 뜻 + 접속 방법) + 예시 문장 2개. 예문은 '문장 문제'에도 나온다.
//   문장 덱  문장 카드(문장 + 뜻 + 일본어 발음 + 한국어 발음). 그 급수의 어휘로 만든 짧은 문장.
// 카드에 태그(급수, '문법')가 붙어 있어 덱 화면의 태그 필터로 골라 볼 수 있다.
//
// 데이터(jlpt-data.json)
//   grammar[급수]    [[문법, 뜻, 접속, [[문장, 읽기, 뜻], [문장, 읽기, 뜻]]], ...]
//   sentences[급수]  [[문장, 읽기, 뜻], ...]
//   읽기는 히라가나로 띄어 쓴 것이고, '와'·'에' 로 소리 나는 조사 は·へ 앞에는 | 를 붙여 두었다(わたし|は).
//   화면에는 | 를 빼고 보여 주고, 한국어 발음은 덱을 만들 때 읽기에서 만든다.
const JLPT_LEVELS = ['N5', 'N4', 'N3'];
const JLPT_KINDS = {
  jgrammar: { key: 'grammar', name: 'JLPT 문법', unit: '문법' },
  jsentence: { key: 'sentences', name: 'JLPT 문장', unit: '문장' }
};

let jlptDataPromise = null;
function loadJlptData() {
  if (!jlptDataPromise) {
    jlptDataPromise = fetch('jlpt-data.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(e => { jlptDataPromise = null; throw e; });
  }
  return jlptDataPromise;
}

const jlptReading = read => read.replace(/\|/g, '');
// 읽기 → 한글 발음. 띄어쓰기는 읽기를 따르고(쉼표 뒤도 띈다), 조사 は·へ 는 와·에 로 적는다.
const jlptKo = read => read.replace(/、/g, '、 ').split(' ')
  .map(t => kanaKo(t.replace(/\|は/g, 'わ').replace(/\|へ/g, 'え'))).join(' ');
const jlptSentence = ([front, read, back]) => ({ front, back, pronJa: jlptReading(read), pronKo: jlptKo(read) });

// kind: 'jgrammar' | 'jsentence'
async function createJlptDeck(name, kind, level) {
  const list = (await loadJlptData())[JLPT_KINDS[kind].key][level];
  if (!list) throw new Error('unknown level');
  const deck = await Store.addDeck(name);
  await Store.addCards(deck.id, kind === 'jgrammar'
    ? list.map(([pattern, mean, form, examples]) => {
      const ex = examples.map(jlptSentence);
      return {
        type: 'basic', front: pattern, back: `${mean}\n접속: ${form}`, tags: [level, '문법'],
        examples: ex, example: exampleText(ex)
      };
    })
    : list.map(s => ({ type: 'sentence', ...jlptSentence(s), tags: [level] })));
  return deck;
}
