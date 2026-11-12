// 한자 덱: 일본어 상용한자(2136자)를 JLPT 급수별로 미리 채워 두고 공부하는 덱.
//
// 카드(type 'kanji')
//   front  한자,  back  뜻(훈음, 예: 배울 학)
//   on     음독(가타카나),  kun  훈독(히라가나, 괄호 안은 오쿠리가나)
//   words  예시 단어 [{w: 단어, r: 읽기, m: 뜻, k: 이 한자를 음독('o')으로 읽는지 훈독('k')으로 읽는지 (알 때만)}]
//   no     급수 안에서의 순서(자주 쓰는 한자가 앞).  strokes  획수
//   example 검색용으로 읽기·단어를 합친 글 (자동으로 만든다)
//
// 학습: 한 번도 학습하지 않은 한자(새 한자)는 '복습'에 세지 않고, 한자 덱의 학습을 시작할 때
//       순서대로 KANJI_NEW_BATCH 자씩 섞어 넣는다. 한 번 평가하면 그 뒤로는 일반 카드처럼 복습 일정이 돈다.
// 연습: 단어 읽기(단어 → 읽는 법 고르기) / 뜻 → 한자(보기에서 한자 고르기) / 써 보기(손으로 쓰고 정답과 비교)
//
// 데이터(kanji-data.json): 급수·획수·음독/훈독은 KANJIDIC2(EDRDG, CC BY-SA 4.0)에서 가져왔고(kanji-data 프로젝트 경유),
//       한국어 뜻과 예시 단어는 따로 붙였다. 예시 단어의 읽기는 JMdict 로 확인했다.
//       v2: 음독·훈독이 모두 있는 한자는 되도록 두 읽기의 단어를 하나씩 싣고(단어 추가), 단어마다 음/훈 표시를 붙였다.
//       읽기의 한글 발음은 데이터에 두지 않고 화면에 그릴 때 JP.kanaToHangul 로 만든다.
const KANJI_LEVELS = [
  ['N5', 'JLPT N5 · 79자 (가장 기초)'],
  ['N4', 'JLPT N4 · 166자'],
  ['N3', 'JLPT N3 · 367자'],
  ['N2', 'JLPT N2 · 367자'],
  ['N1', 'JLPT N1 · 1157자'],
  ['', '빈 한자 덱 (직접 입력)']
];
const KANJI_NEW_BATCH = 10;   // 학습 한 번에 새로 넣는 한자 수
const KANJI_LIST_LIMIT = 100; // 덱 화면 목록에 한 번에 보여줄 카드 수
const KANJI_SCOPE_KEY = 'flashcard-kanji-scope';

const isKanjiDeck = deck => !!deck && deck.kind === 'kanji';
// 아직 한 번도 학습(평가)하지 않은 한자
const isNewKanji = c => c.type === 'kanji' && !c.due;
const kanjiWords = c => (Array.isArray(c.words) ? c.words : []);
const kanjiSearchText = c =>
  [c.on, c.kun, ...kanjiWords(c).flatMap(w => [w.w, w.r, w.m])].filter(Boolean).join(' ');

// 다음에 새로 배울 한자 (순서대로 KANJI_NEW_BATCH 자)
function newKanjiItems(cards) {
  return cards.filter(isNewKanji)
    .sort((a, b) => (a.no || 1e9) - (b.no || 1e9) || a.created - b.created)
    .slice(0, KANJI_NEW_BATCH)
    .map(card => ({ card, dir: 'f' }));
}

// ---------- 데이터 ----------
let kanjiDataPromise = null;
function loadKanjiData() {
  if (!kanjiDataPromise) {
    kanjiDataPromise = fetch('kanji-data.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(e => { kanjiDataPromise = null; throw e; });
  }
  return kanjiDataPromise;
}

const stockKanjiWords = words => words.map(([w, r, m, k]) => ({ w, r, m, ...(k ? { k } : {}) }));

// 데이터(kanji-data.json)가 바뀌었을 때, 이미 만들어 둔 덱의 카드에 새 예시 단어·음/훈 표시를 반영한다.
// 사용자가 읽기나 단어를 고친 카드는 건드리지 않는다: 음독·훈독이 그대로이고,
// 카드의 단어가 새 목록의 앞부분과 같을 때(= 예전 데이터 그대로일 때)만 바꾼다.
async function upgradeKanjiCards(cards) {
  if (isReadOnly() || !cards.some(c => kanjiWords(c).length)) return false;
  let data;
  try { data = await loadKanjiData(); } catch (e) { return false; }
  const stock = new Map(Object.values(data.levels).flat().map(e => [e[0], e]));
  const patches = [];
  for (const c of cards) {
    const e = stock.get(c.front);
    const mine = kanjiWords(c);
    if (!e || !mine.length || c.on !== e[2] || c.kun !== e[3]) continue;
    const next = stockKanjiWords(e[5]);
    if (mine.length > next.length) continue;
    if (!mine.every((w, i) => w.w === next[i].w && w.r === next[i].r && w.m === next[i].m)) continue;
    if (mine.length === next.length && mine.every((w, i) => (w.k || '') === (next[i].k || ''))) continue;
    patches.push([c.id, { words: next, example: kanjiSearchText({ ...c, words: next }) }]);
  }
  if (patches.length) await Store.updateCards(patches);
  return patches.length > 0;
}

// 한자 덱을 만들고, 급수를 골랐으면 그 급수의 한자를 채운다.
async function createKanjiDeck(name, level) {
  const list = level ? (await loadKanjiData()).levels[level] : [];
  if (!list) throw new Error('unknown level');
  const deck = await Store.addDeck(name, 'kanji');
  await Store.addCards(deck.id, list.map(([k, mean, on, kun, strokes, words], i) => {
    const card = {
      type: 'kanji', front: k, back: mean, on, kun, strokes, no: i + 1,
      words: stockKanjiWords(words)
    };
    card.example = kanjiSearchText(card);
    return card;
  }));
  return deck;
}

// ---------- 표시 ----------
// 읽기(가나)의 한글 발음. 여러 읽기는 '、' 로 나뉘어 있고, 괄호(오쿠리가나)는 그대로 둔다.
// お단·う단 뒤의 う 는 장음이라 적지 않는다(とうきょう → 도쿄). 다만 괄호 안 오쿠리가나의 끝이나
// う 로 끝나는 동사(思う)의 마지막 う, 낱말 경계에 걸린 う(みずうみ)는 장음이 아니다.
const KANJI_LONG_U = /(ミズウミ|ツツウラ)|([ウクスツヌフムユルグズヅブプュオコソトノホモヨロゴゾドボポョ])ウ(?!\))/g;
// 가나 한 덩어리 → 한글. keepLastU: 끝의 う 를 장음으로 보지 않는다.
function kanaKo(kana, keepLastU) {
  let s = kana.replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));
  const tail = keepLastU && s.endsWith('ウ') ? 'ウ' : '';
  if (tail) s = s.slice(0, -1);
  return JP.kanaToHangul(s.replace(KANJI_LONG_U, (m, keep, a) => keep || a + 'ー') + tail);
}
function kanjiKo(kana, word) {
  const verb = /[うウ]$/.test(word || '');
  return String(kana || '').split('、').map(t => kanaKo(t.replace(/-/g, '').trim(), verb))
    .filter(Boolean).join(', ');
}
const kanjiKoNode = (kana, word) => {
  const ko = kanjiKo(kana, word);
  return ko ? h('span', { class: 'pron-ko', lang: 'ko' }, ko) : null;
};
const KANJI_WORD_KINDS = { o: '음', k: '훈' };

// 예시 단어 한 줄: [음/훈] 단어（읽기）한글 발음 뜻
const kanjiWordNode = w => h('div', { lang: 'ja' },
  KANJI_WORD_KINDS[w.k] ? h('span', { class: 'pron-label', lang: 'ko' }, KANJI_WORD_KINDS[w.k]) : null,
  w.r && w.r !== w.w ? `${w.w}（${w.r}）` : w.w,
  w.r ? kanjiKoNode(w.r, w.w) : null,
  w.m ? h('span', { lang: 'ko' }, ' ' + w.m) : null);

// 읽기(음독/훈독) 줄과 예시 단어
function kanjiInfoNodes(c) {
  return [
    c.on || c.kun ? h('div', { class: 'pron kanji-read', lang: 'ja' },
      c.on ? h('span', null, h('span', { class: 'pron-label', lang: 'ko' }, '음'), c.on, kanjiKoNode(c.on)) : null,
      c.kun ? h('span', null, h('span', { class: 'pron-label', lang: 'ko' }, '훈'), c.kun, kanjiKoNode(c.kun)) : null) : null,
    kanjiWords(c).length ? h('div', { class: 'example' }, kanjiWords(c).map(kanjiWordNode)) : null
  ];
}

// 플래시카드 면: 앞은 한자만 크게, 뒤는 뜻·읽기·단어
function kanjiFaceNodes(card, flipped) {
  return flipped
    ? [h('div', { class: 'kanji-big small', lang: 'ja' }, card.front), h('div', null, card.back), kanjiInfoNodes(card)]
    : [h('div', { class: 'kanji-big', lang: 'ja' }, card.front)];
}

// ---------- 입력 폼 (추가/수정 공용) ----------
function kanjiForm(card) {
  const c = card || { front: '', back: '', on: '', kun: '', words: [], tags: [] };
  const input = (value, placeholder, lang) => {
    const el = h('input', { type: 'text', class: 'text-input', placeholder, lang });
    el.value = value || '';
    return el;
  };
  const front = input(c.front, '한자 (예: 学)', 'ja');
  const back = input(c.back, '뜻 (예: 배울 학)');
  const on = input(c.on, '음독 (예: ガク)', 'ja');
  const kun = input(c.kun, '훈독 (예: まな(ぶ))', 'ja');
  const words = h('textarea', { rows: '3', placeholder: '예시 단어 — 한 줄에 하나씩\n단어 | 읽기 | 뜻  (예: 学校 | がっこう | 학교)' });
  words.value = kanjiWords(c).map(w => [w.w, w.r, w.m].join(' | ')).join('\n');

  const starCheck = h('input', { type: 'checkbox' });
  starCheck.checked = !!c.star;
  const flagCheck = h('input', { type: 'checkbox' });
  flagCheck.checked = !!c.flag;

  return {
    el: h('div', { class: 'card-fields' }, front, back, on, kun, words,
      h('label', { class: 'check' }, starCheck, '★ 꼭 외울 것'),
      h('label', { class: 'check' }, flagCheck, '🚩 수정 필요')),
    front,
    // 검증에 실패하면 null
    get() {
      const f = front.value.trim(), b = back.value.trim();
      if (!f || !b) { toast('한자와 뜻을 입력하세요'); return null; }
      const list = words.value.split(/\r?\n/).map(line => line.split(/[|｜]/).map(t => t.trim()))
        .filter(p => p[0])
        .map(([w, r, m]) => ({ w, r: r || '', m: m || '' }))
        // 읽기를 고치지 않은 단어는 음/훈 표시를 그대로 둔다.
        .map(w => {
          const old = kanjiWords(c).find(o => o.w === w.w && o.r === w.r);
          return old && old.k ? { ...w, k: old.k } : w;
        });
      const v = {
        type: 'kanji', front: f, back: b, on: on.value.trim(), kun: kun.value.trim(), words: list,
        tags: c.tags || [], reverse: false, examples: [],
        star: starCheck.checked, flag: flagCheck.checked
      };
      v.example = kanjiSearchText(v);
      return v;
    }
  };
}

// ---------- 덱 화면 ----------
const kanjiScope = () => (localStorage.getItem(KANJI_SCOPE_KEY) === 'all' ? 'all' : 'learned');
// 연습 문제를 낼 범위: 배운 한자만(4자 이상일 때) 또는 전체
function kanjiPracticePool(cards) {
  const learned = cards.filter(c => !isNewKanji(c));
  return kanjiScope() === 'learned' && learned.length >= 4 ? learned : cards;
}

function renderKanjiDeck(deck, everything) {
  const deckId = deck.id;
  const cards = everything.filter(c => c.type === 'kanji').sort((a, b) => (a.no || 1e9) - (b.no || 1e9) || a.created - b.created);
  const learned = cards.filter(c => !isNewKanji(c));
  const due = dueItems(cards);
  const fresh = newKanjiItems(cards);
  const studyCount = due.length + fresh.length;

  // 데이터가 새로워졌으면 예시 단어를 반영하고 다시 그린다 (바뀐 것이 없으면 아무 일도 없다).
  upgradeKanjiCards(cards).then(changed => { if (changed && nav.deckId === deckId && !nav.mode) render(); }).catch(() => {});

  // 진도
  const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  bar.firstChild.style.width = cards.length ? `${(learned.length / cards.length) * 100}%` : '0';
  $view.append(h('div', { class: 'progress-text' }, `배운 한자 ${learned.length} / ${cards.length}`), bar);

  // 학습 (한자 → 뜻·읽기)
  $view.append(h('button', {
    class: 'primary big', disabled: studyCount === 0,
    onclick: () => go({ deckId, mode: 'study' })
  }, !cards.length ? '한자를 추가해 주세요'
    : studyCount ? `학습 시작 (복습 ${due.length} · 새 한자 ${fresh.length})`
    : '오늘 복습할 한자가 없어요'));

  // 연습 모드
  const canLearned = learned.length >= 4;
  const scope = h('select', { 'aria-label': '연습 범위' },
    h('option', { value: 'learned', disabled: !canLearned }, `연습 범위: 배운 한자만 (${learned.length}자)`),
    h('option', { value: 'all' }, `연습 범위: 덱 전체 (${cards.length}자)`));
  scope.value = canLearned ? kanjiScope() : 'all';
  scope.addEventListener('change', () => localStorage.setItem(KANJI_SCOPE_KEY, scope.value));
  const hasWords = cards.some(c => kanjiWords(c).some(w => w.r));
  appendAll($view,
    h('div', { class: 'row' },
      h('button', { disabled: cards.length < 4 || !hasWords, onclick: () => go({ deckId, mode: 'kread' }) }, '단어 읽기'),
      h('button', { disabled: cards.length < 4, onclick: () => go({ deckId, mode: 'kpick' }) }, '뜻 → 한자'),
      h('button', { disabled: !cards.length, onclick: () => go({ deckId, mode: 'kwrite' }) }, '써 보기')),
    scope,
    canLearned ? null : h('p', { class: 'hint' }, '한자를 4자 이상 배우면 배운 한자만으로 연습할 수 있어요.'));

  // 한자 직접 추가 (게스트는 숨김)
  if (!isReadOnly()) {
    const form = kanjiForm();
    const addBtn = h('button', {
      type: 'button', class: 'primary',
      onclick: async () => {
        const v = form.get();
        if (!v) return;
        await Store.addCard(deckId, { ...v, no: cards.reduce((m, c) => Math.max(m, c.no || 0), 0) + 1 });
        toast('추가됨');
        render();
      }
    }, '한자 추가');
    $view.append(h('details', { class: 'card-form kanji-add' }, h('summary', null, '한자 직접 추가'), form.el, addBtn));
  }

  // 검색 + 목록 (많으면 앞에서부터 일부만)
  const listEl = h('div', { class: 'list' });
  const search = h('input', { type: 'search', placeholder: '한자 검색 (한자, 뜻, 읽기, 단어)', class: 'search' });
  const paint = () => {
    listEl.replaceChildren();
    const shown = Search.filter(cards, search.value);
    for (const c of shown.slice(0, KANJI_LIST_LIMIT)) listEl.append(cardRow(c));
    if (shown.length > KANJI_LIST_LIMIT) {
      listEl.append(h('p', { class: 'hint' }, `${shown.length}자 중 처음 ${KANJI_LIST_LIMIT}자만 보여줘요. 검색으로 찾아보세요.`));
    }
    if (!shown.length) listEl.append(h('p', { class: 'empty' }, cards.length ? '검색 결과가 없어요.' : '한자가 없어요.'));
  };
  search.addEventListener('input', paint);
  $view.append(search, listEl);
  paint();

  if (!isReadOnly()) $view.append(deckManageRow(deck, everything.length));
}

// ---------- 연습 ----------
const KANJI_MODE_TITLES = { kread: '단어 읽기', kpick: '뜻 → 한자', kwrite: '써 보기' };

async function renderKanjiPractice(deckId, mode) {
  setHeader(KANJI_MODE_TITLES[mode], { deckId });
  const all = (await deckCards(deckId)).filter(c => c.type === 'kanji');
  const pool = kanjiPracticePool(all);
  if (mode === 'kwrite') return kanjiWriteSession(shuffle(pool).slice(0, QUIZ_LENGTH), deckId);

  const make = mode === 'kread' ? kanjiReadQuestion : kanjiPickQuestion;
  const questions = [];
  for (const c of shuffle(pool)) {
    const q = make(c, all);
    if (q) questions.push(q);
    if (questions.length >= QUIZ_LENGTH) break;
  }
  if (!questions.length) {
    $view.append(h('p', { class: 'empty' }, '문제를 만들 한자가 부족해요.'));
    return;
  }
  kanjiChoiceSession(questions, deckId, mode === 'kpick');
}

// 단어 읽기: 한자가 들어간 단어를 보고 읽는 법을 고른다.
function kanjiReadQuestion(card, all) {
  const mine = kanjiWords(card).filter(w => w.w && w.r && w.r !== w.w);
  if (!mine.length) return null;
  const word = mine[Math.floor(Math.random() * mine.length)];
  // 보기: 다른 단어의 읽기. 글자 수가 같은 것을 먼저 써서 길이만으로 답이 드러나지 않게 한다.
  const others = unique(all.flatMap(c => kanjiWords(c)).filter(w => w.r && w.w !== word.w).map(w => w.r))
    .filter(r => r !== word.r);
  const near = shuffle(others.filter(r => r.length === word.r.length));
  const rest = shuffle(others.filter(r => r.length !== word.r.length))
    .sort((a, b) => Math.abs(a.length - word.r.length) - Math.abs(b.length - word.r.length));
  const distractors = [...near, ...rest].slice(0, 3);
  if (!distractors.length) return null;
  return {
    card, answer: word.r,
    prompt: [h('div', { class: 'kanji-word', lang: 'ja' }, word.w), h('div', { class: 'q-small' }, '읽는 법을 고르세요')],
    after: [kanjiWordNode(word), h('div', { class: 'q-small' }, h('span', { lang: 'ja' }, card.front), ` ${card.back}`)],
    options: shuffle([word.r, ...distractors])
  };
}

// 뜻 → 한자: 뜻과 읽기를 보고 맞는 한자를 고른다. 보기는 획수가 비슷한 한자를 먼저 쓴다.
function kanjiPickQuestion(card, all) {
  const others = all.filter(c => c.id !== card.id && c.front !== card.front && c.back !== card.back);
  const st = card.strokes || 0;
  const near = shuffle(others.filter(c => st && Math.abs((c.strokes || 0) - st) <= 2));
  const rest = shuffle(others.filter(c => !near.includes(c)));
  const distractors = unique([...near, ...rest].map(c => c.front)).slice(0, 3);
  if (!distractors.length) return null;
  return {
    card, answer: card.front,
    prompt: [h('div', null, card.back), kanjiInfoNodes({ on: card.on, kun: card.kun })],
    after: kanjiWords(card).map(kanjiWordNode),
    options: shuffle([card.front, ...distractors])
  };
}

// 보기 고르기 진행 (틀리면 오답노트에 담는다)
function kanjiChoiceSession(questions, deckId, kanjiOptions) {
  const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const count = h('div', { class: 'progress-text' });
  const stage = h('div', { class: 'stage' });
  $view.append(count, bar, stage);
  let i = 0, score = 0;

  function show() {
    stage.replaceChildren();
    bar.firstChild.style.width = `${(i / questions.length) * 100}%`;
    count.textContent = `${i} / ${questions.length}`;
    if (i >= questions.length) return finish();

    const q = questions[i];
    const next = h('button', { class: 'primary big', hidden: true, onclick: () => { i++; show(); } },
      i === questions.length - 1 ? '결과 보기' : '다음');
    const after = h('div', { class: 'listen-answer', hidden: true }, q.after);
    const star = starButton(q.card, true);
    const flag = flagButton(q.card, true);
    const buttons = q.options.map(opt => {
      const b = h('button', { class: 'opt', lang: 'ja' }, opt);
      b.addEventListener('click', () => choose(b, opt));
      return b;
    });

    async function choose(btn, opt) {
      buttons.forEach(b => { b.disabled = true; });
      buttons.find(b => b.textContent === q.answer).classList.add('correct');
      if (opt === q.answer) {
        score++;
        await applyPatch(q.card, correctNotePatch(q.card));
      } else {
        btn.classList.add('wrong');
        await applyPatch(q.card, wrongPatch(q.card));
      }
      after.hidden = !q.after.length;
      next.hidden = false;
      if (star) star.hidden = false;
      if (flag) flag.hidden = false;
    }

    appendAll(stage, h('div', { class: 'quiz-q kanji-q' }, q.prompt),
      h('div', { class: 'options' + (kanjiOptions ? ' kanji-options' : '') }, buttons), after, star, flag, next);
  }

  function finish() {
    count.textContent = `${questions.length} / ${questions.length}`;
    replaceAll(stage,
      h('div', { class: 'done' }, score === questions.length ? '🎉' : '👍',
        h('p', null, `${questions.length}문제 중 ${score}개 정답`)),
      isReadOnly() || score === questions.length ? null : h('p', { class: 'hint' }, '틀린 한자는 오답노트에 담겼어요.'),
      h('button', { class: 'primary big', onclick: () => render() }, '다시 풀기'),
      h('button', { onclick: () => go({ deckId }) }, '덱으로 돌아가기'));
  }

  show();
}

// 손으로 쓰는 칸. 정답을 보면 쓴 글씨 뒤에 정답 한자가 옅게 깔린다.
function kanjiPad() {
  const SIZE = 600;
  const canvas = h('canvas', { class: 'pad-canvas', width: SIZE, height: SIZE, 'aria-label': '한자를 쓰는 칸' });
  const guide = h('div', { class: 'pad-guide', lang: 'ja' });
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#000';

  let last = null, used = false;
  const pos = e => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * SIZE / r.width, (e.clientY - r.top) * SIZE / r.height];
  };
  const line = (from, to) => { ctx.beginPath(); ctx.moveTo(from[0], from[1]); ctx.lineTo(to[0], to[1]); ctx.stroke(); };
  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
    last = pos(e);
    used = true;
    line(last, [last[0] + 0.1, last[1] + 0.1]); // 점만 찍어도 보이게
  });
  canvas.addEventListener('pointermove', e => {
    if (!last) return;
    e.preventDefault();
    const p = pos(e);
    line(last, p);
    last = p;
  });
  const end = () => { last = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  return {
    el: h('div', { class: 'pad' }, guide, canvas),
    clear() { ctx.clearRect(0, 0, SIZE, SIZE); used = false; },
    isUsed: () => used,
    showAnswer(ch) { guide.textContent = ch; }
  };
}

// 써 보기: 뜻·읽기를 보고 한자를 손으로 쓴 뒤, 정답과 비교해 스스로 채점한다.
function kanjiWriteSession(cards, deckId) {
  if (!cards.length) {
    $view.append(h('p', { class: 'empty' }, '연습할 한자가 없어요.'));
    return;
  }
  const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const count = h('div', { class: 'progress-text' });
  const stage = h('div', { class: 'stage' });
  $view.append(count, bar, stage);
  let i = 0, score = 0;

  function show() {
    stage.replaceChildren();
    bar.firstChild.style.width = `${(i / cards.length) * 100}%`;
    count.textContent = `${i} / ${cards.length}`;
    if (i >= cards.length) return finish();

    const card = cards[i];
    // 힌트 단어: 쓸 한자 자리를 〇 로 가린다.
    const hints = kanjiWords(card).filter(w => w.w.includes(card.front)).map(w =>
      ({ w: w.w.split(card.front).join('〇'), r: w.r, m: w.m }));
    const pad = kanjiPad();

    const answer = h('div', { class: 'listen-answer', hidden: true },
      h('div', { class: 'kanji-answer', lang: 'ja' }, card.front), kanjiWords(card).map(kanjiWordNode));
    const clearBtn = h('button', { onclick: () => pad.clear() }, '지우기');
    const revealBtn = h('button', { class: 'primary', onclick: reveal }, '정답 보기');
    const tools = h('div', { class: 'row' }, clearBtn, revealBtn);
    const rate = h('div', { class: 'row', hidden: true },
      h('button', { class: 'danger', onclick: () => grade(false) }, '틀렸어요'),
      h('button', { class: 'primary', onclick: () => grade(true) }, '맞았어요'));
    const star = starButton(card, true);
    const flag = flagButton(card, true);

    function reveal() {
      pad.showAnswer(card.front);
      answer.hidden = false;
      tools.hidden = true;
      rate.hidden = false;
      if (star) star.hidden = false;
      if (flag) flag.hidden = false;
    }
    async function grade(ok) {
      if (ok) score++;
      await applyPatch(card, ok ? correctNotePatch(card) : wrongPatch(card));
      i++;
      show();
    }

    appendAll(stage,
      h('div', { class: 'quiz-q kanji-q write' },
        h('div', null, card.back), kanjiInfoNodes({ on: card.on, kun: card.kun }),
        hints.length ? h('div', { class: 'example' }, hints.map(kanjiWordNode)) : null),
      pad.el, tools, answer, rate, star, flag);
  }

  function finish() {
    count.textContent = `${cards.length} / ${cards.length}`;
    replaceAll(stage,
      h('div', { class: 'done' }, score === cards.length ? '🎉' : '👍',
        h('p', null, `${cards.length}자 중 ${score}자 맞았어요`)),
      isReadOnly() || score === cards.length ? null : h('p', { class: 'hint' }, '틀린 한자는 오답노트에 담겼어요.'),
      h('button', { class: 'primary big', onclick: () => render() }, '다시 쓰기'),
      h('button', { onclick: () => go({ deckId }) }, '덱으로 돌아가기'));
  }

  show();
}
