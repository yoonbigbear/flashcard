// 복습 간격(일): box 0~5. 높을수록 오래 간격을 둔다.
const INTERVALS = [0, 1, 3, 7, 14, 30];
const DAY = 24 * 60 * 60 * 1000;
const NOTE_CLEAR_STREAK = 2;   // 오답노트에서 연속 N번 맞히면 졸업
const QUIZ_LENGTH = 10;
const MATCH_PAIRS = 6;

const $view = document.getElementById('view');
const $title = document.getElementById('title');
const $back = document.getElementById('backBtn');
const $toast = document.getElementById('toast');

// DOM 헬퍼: h('div', {class:'x', onclick: fn}, '텍스트', child...)
// 텍스트는 항상 textNode로 넣으므로 사용자 입력이 HTML로 해석되지 않는다.
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

function toast(msg) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { $toast.hidden = true; }, 2000);
}

// 게스트(소유자가 아닌 사람)는 카드를 보고 학습만 할 수 있고, 추가/수정/삭제는 못 한다.
// 실제 차단은 firestore.rules 가 하고, 여기서는 쓸 수 없는 버튼을 숨긴다.
const isReadOnly = () => !!(window.Sync && window.Sync.state.readOnly);

const shuffle = arr => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const unique = arr => [...new Set(arr)];

// '꼭 외울 것' 모음: 모든 덱에서 별표한 카드를 모아 보여주는 가상 덱. 카드는 원래 덱에 그대로 있다.
const STARRED = '__starred__';
const STARRED_NAME = '★ 꼭 외울 것';
async function deckCards(deckId) {
  if (deckId !== STARRED) return Store.listCards(deckId);
  const [cards, decks] = await Promise.all([Store.listAllCards(), Store.listDecks()]);
  const ids = new Set(decks.map(d => d.id));
  return cards.filter(c => c.star && !c.script && ids.has(c.deckId));
}
const toggleStar = card => applyPatch(card, { star: !card.star });
const starLabel = card => (card.star ? '★ 꼭 외울 것' : '☆ 꼭 외우기');
// 학습·퀴즈 중 카드 아래에 띄우는 별표 토글 버튼 (게스트·스크립트 줄은 없음)
function starButton(card, hidden) {
  if (isReadOnly() || card.script) return null;
  const btn = h('button', {
    class: 'related-btn', hidden,
    onclick: async () => { await toggleStar(card); btn.textContent = starLabel(card); }
  }, starLabel(card));
  return btn;
}

const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); };

// ---------- 빈칸(cloze) 문장 ----------
// 문장 안에서 {{단어}} 로 빈칸을 지정한다.
const CLOZE_RE = /\{\{(.+?)\}\}/g;
const clozeAnswers = text => [...text.matchAll(CLOZE_RE)].map(m => m[1].trim());

// reveal: 모든 빈칸을 정답으로 표시. focus: 해당 번호만 빈칸, 나머지는 정답 표시.
function clozeNodes(text, reveal, focus = null) {
  const nodes = [];
  let last = 0, i = 0;
  for (const m of text.matchAll(CLOZE_RE)) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const show = reveal || (focus !== null && i !== focus);
    nodes.push(h('span', { class: show ? 'answer' : 'blank' }, show ? m[1].trim() : '＿＿＿'));
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// 앞/뒤 한 쌍으로 다루는 카드 (4지선다 보기, 매칭 게임에 쓸 수 있다)
const isPairCard = c => c.type === 'basic' || c.type === 'sentence';

// 문장 카드의 발음 줄 (일본어 발음 / 한국어 발음). 비어 있으면 생략.
function pronNodes(card) {
  return [['일본어', card.pronJa], ['한국어', card.pronKo]]
    .filter(([, v]) => v)
    .map(([label, v]) => h('div', { class: 'pron' }, h('span', { class: 'pron-label' }, label), v));
}

// 예시 문장 (있을 때만). 여러 개는 example 에 한 줄씩 저장하고, 한 줄마다 따로 보여준다.
const exampleList = card => (card.example || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const exampleNode = card => {
  const list = exampleList(card);
  return list.length ? list.map(s => h('div', { class: 'example' }, s)) : null;
};

// 카드 한 면의 내용. dir: 'f'(앞→뒤) | 'r'(뒤→앞)
function faceNodes(card, dir, flipped) {
  if (card.type === 'sentence') {
    return flipped
      ? [h('div', { class: 'q-small' }, card.front), h('div', null, card.back), pronNodes(card), exampleNode(card)]
      : [h('div', null, card.front)];
  }
  if (card.type === 'cloze') {
    return flipped
      ? [h('div', null, clozeNodes(card.front, true)),
         card.back ? h('div', { class: 'q-small' }, card.back) : null,
         exampleNode(card)]
      : [h('div', null, clozeNodes(card.front, false))];
  }
  const q = dir === 'r' ? card.back : card.front;
  const a = dir === 'r' ? card.front : card.back;
  return flipped
    ? [h('div', { class: 'q-small' }, q), h('div', null, a), exampleNode(card)]
    : [h('div', null, q)];
}

// ---------- 복습 일정 / 오답노트 ----------
// 오늘 복습할 (카드, 방향) 목록
function dueItems(cards) {
  const end = endOfToday();
  const items = [];
  for (const c of cards) {
    if (c.script) continue; // 대화 스크립트 줄은 따로 연습한다
    if (c.due <= end) items.push({ card: c, dir: 'f' });
    if (c.type === 'basic' && c.reverse && c.rdue <= end) items.push({ card: c, dir: 'r' });
  }
  return items;
}

const wrongPatch = card => ({ wrong: card.wrong + 1, note: true, streak: 0 });

// 오답노트에 있는 카드를 맞히면 연속 정답을 세고, 기준을 넘으면 노트에서 뺀다.
function correctNotePatch(card) {
  if (!card.note) return {};
  const streak = card.streak + 1;
  return streak >= NOTE_CLEAR_STREAK ? { streak: 0, note: false } : { streak };
}

// 일반 학습의 평가 결과 → 저장할 변경값
function ratePatch(card, dir, result) {
  const bk = dir === 'r' ? 'rbox' : 'box';
  const dk = dir === 'r' ? 'rdue' : 'due';
  if (result === 'again') {
    return { ...wrongPatch(card), [bk]: 0, [dk]: Date.now() };
  }
  if (result === 'hard') {
    return { [dk]: Date.now() + DAY };
  }
  const box = Math.min(card[bk] + 1, INTERVALS.length - 1);
  return { ...correctNotePatch(card), [bk]: box, [dk]: Date.now() + INTERVALS[box] * DAY };
}

// 오답노트 복습: 복습 일정은 건드리지 않고 노트 상태만 갱신한다.
function noteRatePatch(card, dir, result) {
  if (result === 'again') return wrongPatch(card);
  if (result === 'good') return correctNotePatch(card);
  return {};
}

async function applyPatch(card, patch) {
  if (!Object.keys(patch).length) return;
  Object.assign(card, patch);
  await Store.updateCard(card.id, patch);
}

// ---------- 라우팅 ----------
let nav = { tab: 'decks', deckId: null, mode: null, tag: null, scriptId: null };
let formMemo = { type: 'basic', tags: [], reverse: false }; // 연속 입력 시 유지할 값

function go(next) {
  nav = { tab: 'decks', deckId: null, mode: null, tag: null, scriptId: null, ...next };
  render();
}

document.querySelectorAll('.tabbar button').forEach(b => {
  b.addEventListener('click', () => go({ tab: b.dataset.tab }));
});

async function render() {
  // 게스트는 오답노트를 쓰지 않는다.
  if (isReadOnly() && nav.tab === 'note') nav = { tab: 'decks', deckId: null, mode: null, tag: null, scriptId: null };
  document.querySelectorAll('.tabbar button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === nav.tab);
    if (b.dataset.tab === 'note') b.hidden = isReadOnly();
  });
  $view.replaceChildren();
  $view.scrollTop = 0;

  if (nav.tab === 'settings') return renderSettings();
  if (nav.tab === 'search') return renderSearch();
  if (nav.tab === 'note') return nav.mode === 'study' ? renderNoteStudy() : renderNote();
  if (nav.deckId) {
    if (nav.mode === 'study') return renderStudy(nav.deckId);
    if (nav.mode === 'quiz') return renderQuiz(nav.deckId);
    if (nav.mode === 'match') return renderMatch(nav.deckId);
    if (nav.mode === 'script') return renderScriptPractice(nav.deckId, nav.scriptId);
    return renderDeck(nav.deckId);
  }
  return renderDecks();
}

function setHeader(title, backTo) {
  $title.textContent = title;
  $back.hidden = !backTo;
  $back.onclick = backTo ? () => go(backTo) : null;
}

// ---------- 덱 목록 ----------
async function renderDecks() {
  setHeader('내 덱');
  const decks = await Store.listDecks();
  const list = h('div', { class: 'list' });

  const starred = await deckCards(STARRED);
  if (starred.length) {
    const due = dueItems(starred).length;
    list.append(h('button', { class: 'deck-item', onclick: () => go({ deckId: STARRED }) },
      h('div', { class: 'deck-name' }, STARRED_NAME),
      h('div', { class: 'deck-meta' }, `카드 ${starred.length}장`,
        due > 0 ? h('span', { class: 'badge' }, `복습 ${due}`) : null)));
  }

  for (const deck of decks) {
    const cards = await Store.listCards(deck.id);
    const due = dueItems(cards).length;
    const scriptDeck = isScriptDeck(deck, cards);
    list.append(h('button', { class: 'deck-item', onclick: () => go({ deckId: deck.id }) },
      h('div', { class: 'deck-name' }, deck.name),
      h('div', { class: 'deck-meta' },
        scriptDeck ? `대화 스크립트 · ${cards.length}줄` : `카드 ${cards.length}장`,
        due > 0 ? h('span', { class: 'badge' }, `복습 ${due}`) : null)));
  }

  if (!decks.length) {
    list.append(h('p', { class: 'empty' }, isReadOnly()
      ? '아직 덱이 없어요.'
      : '아직 덱이 없어요.\n아래 + 버튼으로 첫 덱을 만들어 보세요.'));
  }
  $view.append(list);

  if (isReadOnly()) return;
  $view.append(h('button', {
    class: 'fab', 'aria-label': '덱 추가',
    onclick: () => newDeckDialog()
  }, '+'));
}

// 덱 종류: 일반 카드 덱 / 대화 스크립트 덱. 스크립트 기능은 스크립트 덱에서만 나온다.
const isScriptDeck = (deck, cards) => deck.kind === 'script' || cards.some(c => c.script);

function newDeckDialog() {
  const name = h('input', { type: 'text', class: 'text-input', placeholder: '덱 이름' });
  const kind = h('select', { 'aria-label': '덱 종류' },
    h('option', { value: 'cards' }, '일반 카드 덱 (앞/뒤, 빈칸, 퀴즈)'),
    h('option', { value: 'script' }, '대화 스크립트 덱 (대화문 빈칸 채우기)'));

  const create = async () => {
    const n = name.value.trim();
    if (!n) return toast('덱 이름을 입력하세요');
    const deck = await Store.addDeck(n, kind.value === 'script' ? 'script' : undefined);
    dlg.close();
    go({ deckId: deck.id });
  };
  name.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) create(); });

  const dlg = h('dialog', { class: 'dialog' },
    h('h2', null, '새 덱'),
    h('div', { class: 'card-fields' }, name, kind),
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: () => dlg.close() }, '취소'),
      h('button', { type: 'button', class: 'primary', onclick: create }, '만들기')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  name.focus();
}

// ---------- 카드 입력 폼 (추가/수정 공용) ----------
function cardForm(card) {
  const c = card || { type: 'basic', front: '', back: '', tags: [], reverse: false };

  const type = h('select', { 'aria-label': '카드 종류' },
    h('option', { value: 'basic' }, '기본 카드 (앞/뒤)'),
    h('option', { value: 'cloze' }, '빈칸 문장'),
    h('option', { value: 'sentence' }, '문장 (뜻 + 발음)'));
  type.value = c.type;

  const front = h('textarea', { rows: '2' });
  front.value = c.front;
  const back = h('textarea', { rows: '2' });
  back.value = c.back;

  const blankBtn = h('button', {
    type: 'button',
    onmousedown: e => e.preventDefault(), // 텍스트 선택이 풀리지 않게
    onclick: () => {
      const s = front.selectionStart, e = front.selectionEnd;
      if (s === e) return toast('빈칸으로 만들 부분을 먼저 선택하세요');
      const v = front.value;
      front.value = `${v.slice(0, s)}{{${v.slice(s, e)}}}${v.slice(e)}`;
      front.focus();
    }
  }, '선택한 부분을 빈칸으로');

  // 대화 스크립트의 줄은 한글 발음 칸이 있고, 앞/뒤 형태로만 쓴다.
  const isLine = !!c.script;
  const read = h('input', { type: 'text', class: 'text-input', placeholder: '한글 발음 (예: 아리가토 고자이마스)' });
  read.value = c.read || '';
  // 영상이 연결된 스크립트의 줄은 재생 시작 시간도 고칠 수 있다.
  const hasVideo = isLine && !!c.video;
  const start = h('input', { type: 'text', class: 'text-input', placeholder: '재생 시작 시간 (예: 1:23)' });
  start.value = Number.isFinite(c.start) ? JP.formatTime(c.start) : '';

  const pronJa = h('input', { type: 'text', class: 'text-input', placeholder: '일본어 발음 (선택, 예: こんにちは)' });
  pronJa.value = c.pronJa || '';
  const pronKo = h('input', { type: 'text', class: 'text-input', placeholder: '한국어 발음 (선택, 예: 곤니치와)' });
  pronKo.value = c.pronKo || '';

  // 예시 문장: 입력칸을 필요한 만큼 늘릴 수 있다. 저장할 때 한 줄에 하나씩 합친다.
  const exampleRows = h('div', { class: 'example-rows' });
  const exampleInputs = [];
  const addExample = (value = '') => {
    const input = h('input', { type: 'text', class: 'text-input', placeholder: '예시 문장 (선택)' });
    input.value = value;
    const del = h('button', {
      type: 'button', class: 'icon-btn', 'aria-label': '예시 문장 삭제',
      onclick: () => {
        if (exampleInputs.length === 1) { input.value = ''; return; }
        exampleInputs.splice(exampleInputs.indexOf(input), 1);
        row.remove();
      }
    }, '✕');
    // Enter 로 다음 예시 칸을 연다 (한글 조합 중에는 제외)
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      const next = exampleInputs[exampleInputs.indexOf(input) + 1];
      if (next) next.focus(); else addExample().focus();
    });
    const row = h('div', { class: 'example-row' }, input, del);
    exampleInputs.push(input);
    exampleRows.append(row);
    return input;
  };
  const initialExamples = exampleList(c);
  (initialExamples.length ? initialExamples : ['']).forEach(addExample);
  const example = h('div', { class: 'example-field' }, exampleRows,
    h('button', { type: 'button', onclick: () => addExample().focus() }, '+ 예시 문장 추가'));

  const tags = h('input', { type: 'text', class: 'text-input', placeholder: '태그 (쉼표로 구분, 예: 명사, 시험)' });
  tags.value = c.tags.join(', ');

  const rev = h('input', { type: 'checkbox' });
  rev.checked = c.reverse;
  const revLabel = h('label', { class: 'check' }, rev, '양방향 (뒤→앞도 복습)');

  const starCheck = h('input', { type: 'checkbox' });
  starCheck.checked = !!c.star;
  const starRow = h('label', { class: 'check' }, starCheck, '★ 꼭 외울 것');

  function sync() {
    const cloze = type.value === 'cloze';
    const sentence = type.value === 'sentence';
    front.placeholder = cloze ? '문장 (빈칸은 {{단어}} 로 표시)' : sentence ? '문장' : '앞면 (질문)';
    back.placeholder = cloze ? '메모 / 뜻 (선택)' : sentence ? '뜻 (답)' : '뒷면 (답)';
    blankBtn.hidden = !cloze;
    revLabel.hidden = cloze || sentence;
    pronJa.hidden = pronKo.hidden = !sentence;
  }
  type.addEventListener('change', sync);
  sync();
  if (isLine) { type.hidden = true; blankBtn.hidden = true; revLabel.hidden = true; pronJa.hidden = pronKo.hidden = true; example.hidden = true; starRow.hidden = true; }

  return {
    el: h('div', { class: 'card-fields' }, type, front, blankBtn, back, pronJa, pronKo, example, isLine ? read : null, hasVideo ? start : null, tags, revLabel, starRow),
    front,
    // 검증에 실패하면 null
    get() {
      const isCloze = type.value === 'cloze';
      const isSentence = type.value === 'sentence';
      const f = front.value.trim(), b = back.value.trim();
      if (!f) { toast('내용을 입력하세요'); return null; }
      if (isCloze && !clozeAnswers(f).length) { toast('{{단어}} 형태로 빈칸을 하나 이상 지정하세요'); return null; }
      if (!isCloze && !b && !isLine) { toast('앞면과 뒷면을 모두 입력하세요'); return null; }
      const startSec = hasVideo ? JP.parseTime(start.value) : null;
      if (Number.isNaN(startSec)) { toast('시간은 1:23 처럼 적어 주세요'); return null; }
      return {
        type: type.value,
        front: f,
        back: b,
        tags: unique(tags.value.split(/[,，]/).map(t => t.trim()).filter(Boolean)),
        reverse: !isCloze && !isSentence && rev.checked,
        pronJa: isSentence ? pronJa.value.trim() : '',
        pronKo: isSentence ? pronKo.value.trim() : '',
        ...(isLine ? {} : { star: starCheck.checked }),
        example: isLine ? '' : exampleInputs.map(i => i.value.trim()).filter(Boolean).join('\n'),
        ...(isLine ? { read: read.value.trim() } : {}),
        ...(hasVideo ? { start: startSec } : {})
      };
    }
  };
}

function editCard(card, onDone) {
  const form = cardForm(card);
  const dlg = h('dialog', { class: 'dialog' },
    h('h2', null, '카드 수정'),
    form.el,
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: () => dlg.close() }, '취소'),
      h('button', {
        type: 'button', class: 'primary',
        onclick: async () => {
          const v = form.get();
          if (!v) return;
          // 스크립트 줄의 원문이 바뀌면 빈칸 후보(단어 분리)도 다시 만든다.
          if (card.script && v.front !== card.front) v.tokens = JP.analyze(v.front);
          await Store.updateCard(card.id, v);
          dlg.close();
          onDone();
        }
      }, '저장')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// ---------- 덱 상세 ----------
async function renderDeck(deckId) {
  const decks = await Store.listDecks();
  const deck = deckId === STARRED ? { id: STARRED, name: STARRED_NAME } : decks.find(d => d.id === deckId);
  if (!deck) return go({});
  const deckNames = deckId === STARRED ? new Map(decks.map(d => [d.id, d.name])) : null;
  setHeader(deck.name, {});

  // 대화 스크립트의 줄은 스크립트 영역에서 따로 다루고, 일반 카드 목록·학습에서는 뺀다.
  const everything = await deckCards(deckId);
  const lineCards = everything.filter(c => c.script);
  const cards = everything.filter(c => !c.script).sort((a, b) => b.created - a.created);
  const tag = nav.tag;
  const scoped = tag ? cards.filter(c => c.tags.includes(tag)) : cards;
  const due = dueItems(scoped);
  const basicCount = scoped.filter(isPairCard).length;
  const allTags = unique(cards.flatMap(c => c.tags)).sort();

  // 대화 스크립트 덱: 스크립트 목록과 연습만 있고 일반 학습·카드 입력은 없다.
  if (isScriptDeck(deck, everything)) {
    $view.append(scriptSection(deckId, lineCards));
    if (!isReadOnly()) $view.append(deckManageRow(deck, everything.length));
    return;
  }

  // 태그 필터
  if (allTags.length) {
    const chip = (label, value) => h('button', {
      class: 'chip' + (tag === value ? ' active' : ''),
      onclick: () => go({ deckId, tag: value })
    }, label);
    $view.append(h('div', { class: 'chips' }, chip('전체', null), allTags.map(t => chip(t, t))));
  }

  // 학습 시작 + 추가 모드
  $view.append(
    h('button', {
      class: 'primary big', disabled: due.length === 0,
      onclick: () => go({ deckId, tag, mode: 'study' })
    }, due.length ? `학습 시작 (${due.length}장)` : '오늘 복습할 카드가 없어요'),
    h('div', { class: 'row' },
      h('button', {
        disabled: scoped.length < 2,
        onclick: () => go({ deckId, tag, mode: 'quiz' })
      }, '4지선다'),
      h('button', {
        disabled: basicCount < 2,
        onclick: () => go({ deckId, tag, mode: 'match' })
      }, '매칭 게임')));

  // 카드 추가 폼 (게스트는 숨김, 모음 덱에서는 추가하지 않는다)
  if (!isReadOnly() && deckId !== STARRED) {
    const form = cardForm({ type: formMemo.type, front: '', back: '', tags: formMemo.tags, reverse: formMemo.reverse });
    const addBtn = h('button', {
      type: 'button', class: 'primary',
      onclick: async () => {
        const v = form.get();
        if (!v) return;
        await Store.addCard(deckId, v);
        formMemo = { type: v.type, tags: v.tags, reverse: v.reverse };
        toast('추가됨');
        await render();
        $view.querySelector('.card-form textarea')?.focus();
      }
    }, '카드 추가');
    $view.append(h('div', { class: 'card-form' }, form.el, addBtn));
  }

  // 검색 + 목록
  const listEl = h('div', { class: 'list' });
  const search = h('input', { type: 'search', placeholder: '카드 검색 (내용, 태그)', class: 'search' });
  const paint = () => {
    listEl.replaceChildren();
    const shown = Search.filter(scoped, search.value);
    for (const c of shown) listEl.append(cardRow(c, deckNames && h('span', { class: 'tag' }, deckNames.get(c.deckId))));
    if (!shown.length) {
      listEl.append(h('p', { class: 'empty' }, scoped.length ? '검색 결과가 없어요.'
        : deckId === STARRED ? '별표한 카드가 없어요.' : isReadOnly() ? '카드가 없어요.' : '카드를 추가해 보세요.'));
    }
  };
  search.addEventListener('input', paint);
  $view.append(search, listEl);
  paint();

  // 덱 관리 (게스트는 숨김, 모음 덱은 이름 변경·삭제 없음)
  if (!isReadOnly() && deckId !== STARRED) $view.append(deckManageRow(deck, everything.length));
}

function deckManageRow(deck, cardCount) {
  return h('div', { class: 'row' },
    h('button', {
      onclick: async () => {
        const name = (prompt('덱 이름 변경', deck.name) || '').trim();
        if (name) { await Store.renameDeck(deck.id, name); render(); }
      }
    }, '덱 이름 변경'),
    h('button', {
      class: 'danger',
      onclick: async () => {
        if (!confirm(`'${deck.name}' 덱과 카드 ${cardCount}장을 삭제할까요?`)) return;
        await Store.deleteDeck(deck.id);
        go({});
      }
    }, '덱 삭제'));
}

async function moveCardDialog(card) {
  const decks = (await Store.listDecks()).filter(d => d.id !== card.deckId);
  if (!decks.length) return toast('옮길 다른 덱이 없어요');
  const sel = h('select', { 'aria-label': '이동할 덱' }, decks.map(d => h('option', { value: d.id }, d.name)));
  const dlg = h('dialog', { class: 'dialog' },
    h('h2', null, '다른 덱으로 이동'),
    sel,
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: () => dlg.close() }, '취소'),
      h('button', {
        type: 'button', class: 'primary',
        onclick: async () => {
          await Store.updateCard(card.id, { deckId: sel.value });
          dlg.close();
          toast('이동됨');
          render();
        }
      }, '이동')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

function cardRow(c, extra) {
  const body = c.type === 'cloze' ? clozeNodes(c.front, true) : c.front;
  return h('div', { class: 'card-row' },
    h('div', { class: 'card-text' },
      h('div', { class: 'card-front' }, body),
      c.back ? h('div', { class: 'card-back' }, c.back) : null,
      c.type === 'sentence' ? pronNodes(c) : null,
      exampleNode(c),
      h('div', { class: 'card-meta' },
        c.type === 'cloze' ? h('span', { class: 'tag kind' }, '빈칸') : null,
        c.type === 'sentence' ? h('span', { class: 'tag kind' }, '문장') : null,
        c.reverse ? h('span', { class: 'tag kind' }, '↔ 양방향') : null,
        c.star ? h('span', { class: 'tag kind' }, '★') : null,
        c.note ? h('span', { class: 'tag warn' }, '오답노트') : null,
        c.wrong ? h('span', { class: 'tag' }, `✗ ${c.wrong}`) : null,
        c.tags.map(t => h('span', { class: 'tag' }, '#' + t)),
        extra || null)),
    h('div', { class: 'card-actions' },
      isReadOnly() || c.script ? null : h('button', {
        class: 'icon-btn', 'aria-label': c.star ? '꼭 외울 것 해제' : '꼭 외울 것으로 표시',
        onclick: async () => { await toggleStar(c); render(); }
      }, c.star ? '★' : '☆'),
      h('button', { class: 'icon-btn', 'aria-label': '관련 카드', onclick: () => relatedDialog(c) }, '🔗'),
      isReadOnly() ? null : [
        h('button', { class: 'icon-btn', 'aria-label': '수정', onclick: () => editCard(c, render) }, '✎'),
        h('button', { class: 'icon-btn', 'aria-label': '다른 덱으로 이동', onclick: () => moveCardDialog(c) }, '⇄'),
        h('button', {
          class: 'icon-btn', 'aria-label': '삭제',
          onclick: async () => {
            if (!confirm('이 카드를 삭제할까요?')) return;
            await Store.deleteCard(c.id);
            render();
          }
        }, '🗑')
      ]));
}

// 이 카드와 관련 있는 다른 카드 (모든 덱에서). 목록의 카드를 누르면 그 카드의 관련 카드로 이어진다.
// 글자·태그 기준 결과를 먼저 보여주고, 의미 검색이 켜져 있으면 뜻 유사도를 더해 다시 그린다.
const RELATED_LIMIT = 10;
async function relatedDialog(card) {
  const [cards, decks] = await Promise.all([Store.listAllCards(), Store.listDecks()]);
  const names = new Map(decks.map(d => [d.id, d.name]));
  const pool = cards.filter(c => names.has(c.deckId));
  const front = c => (c.type === 'cloze' ? clozeNodes(c.front, true) : c.front);

  const box = h('div');
  const note = h('p', { class: 'hint' });
  const paint = found => box.replaceChildren(found.length
    ? h('div', { class: 'list' }, found.map(({ card: c, reasons }) => h('button', {
        type: 'button', class: 'related-item',
        onclick: () => { dlg.close(); relatedDialog(c); }
      },
        h('div', { class: 'card-front' }, front(c)),
        c.back ? h('div', { class: 'card-back' }, c.back) : null,
        h('div', { class: 'card-meta' },
          h('span', { class: 'tag kind' }, names.get(c.deckId)),
          reasons.map(r => h('span', { class: 'tag' }, r))))))
    : h('p', { class: 'empty' }, '관련된 카드를 찾지 못했어요.\n태그를 달거나 예시 문장을 넣으면 더 잘 찾아요.'));

  const dlg = h('dialog', { class: 'dialog' },
    h('h2', null, '관련 카드'),
    h('div', { class: 'related-base' },
      h('div', { class: 'card-front' }, front(card)),
      card.back ? h('div', { class: 'card-back' }, card.back) : null),
    note, box,
    h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => dlg.close() }, '닫기')));
  dlg.addEventListener('close', () => dlg.remove());
  paint(Search.related(card, pool).slice(0, RELATED_LIMIT));
  document.body.append(dlg);
  dlg.showModal();

  if (!(window.Embed && Embed.isEnabled())) return note.remove();
  note.textContent = '의미 분석 중…';
  try {
    const semantic = await Embed.similarTo(card, pool, (d, t) => { note.textContent = `의미 분석 중… ${d}/${t}`; });
    if (dlg.isConnected) paint(Search.related(card, pool, semantic).slice(0, RELATED_LIMIT));
    note.remove();
  } catch (e) {
    note.textContent = '의미 분석을 쓸 수 없어요: ' + e.message;
  }
}

// ---------- 플래시카드 세션 (학습 / 오답노트 복습 공용) ----------
const FLASH_BATCH = 20; // 한 번에 보여줄 카드 수

function flashSession({ items, patchFn, onFinish }) {
  // 전체를 무작위로 섞은 뒤 FLASH_BATCH 장씩 나눠서 학습한다.
  const pool = shuffle(items);
  if (!pool.length) return onFinish();
  let queue = pool.splice(0, FLASH_BATCH);
  let total = queue.length;

  const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const count = h('div', { class: 'progress-text' });
  const stage = h('div', { class: 'stage' });
  $view.append(count, bar, stage);

  let done = 0;

  function show() {
    stage.replaceChildren();
    const item = queue[0];
    if (!item) return finish();
    const { card, dir } = item;
    bar.firstChild.style.width = `${(done / total) * 100}%`;
    count.textContent = `${done} / ${total}`;

    const flipCard = h('button', { class: 'flip-card', 'aria-label': '카드 뒤집기' }, faceNodes(card, dir, false));
    const buttons = h('div', { class: 'rate', hidden: true },
      h('button', { class: 'danger', onclick: () => rate('again') }, '모름'),
      h('button', { onclick: () => rate('hard') }, '애매'),
      h('button', { class: 'primary', onclick: () => rate('good') }, '알아'));

    // 뒤집은 뒤에만 보이는 보조 버튼: 관련 카드 / 꼭 외울 것 표시
    const relBtn = h('button', { class: 'related-btn', onclick: () => relatedDialog(card) }, '🔗 관련 카드 보기');
    const extra = h('div', { class: 'extra-actions', hidden: true }, relBtn, starButton(card, false));

    let flipped = false;
    flipCard.addEventListener('click', () => {
      flipped = !flipped;
      flipCard.classList.toggle('flipped', flipped);
      extra.hidden = !flipped;
      // replaceChildren 은 null 을 "null" 글자로, 배열을 통째로 문자열로 바꾸므로 h() 처럼 걸러서 넘긴다.
      flipCard.replaceChildren(...faceNodes(card, dir, flipped).flat(Infinity).filter(n => n != null && n !== false));
      buttons.hidden = !flipped;
    });

    const label = dir === 'r' ? '뒤 → 앞' : null;
    stage.append(
      label ? h('div', { class: 'dir-label' }, label) : null,
      flipCard,
      card.tags.length ? h('div', { class: 'study-tags' }, card.tags.map(t => h('span', { class: 'tag' }, '#' + t))) : null,
      h('p', { class: 'hint' }, '카드를 탭하면 뒤집혀요'),
      extra,
      buttons);
  }

  async function rate(result) {
    const item = queue.shift();
    await applyPatch(item.card, patchFn(item.card, item.dir, result));
    if (result === 'again') queue.push(item); // 이번 세션에서 다시 보여준다
    else done++;
    show();
  }

  function finish() {
    bar.firstChild.style.width = '100%';
    count.textContent = `${total} / ${total}`;
    if (pool.length) {
      stage.replaceChildren(
        h('div', { class: 'done' }, '🎉', h('p', null, `${total}장 완료! 남은 카드 ${pool.length}장`)),
        h('button', { class: 'primary big', onclick: nextBatch }, `다음 ${Math.min(FLASH_BATCH, pool.length)}장 계속`),
        h('button', { class: 'big', onclick: onFinish }, '여기까지'));
      return;
    }
    stage.replaceChildren(
      h('div', { class: 'done' }, '🎉', h('p', null, '학습을 마쳤어요!')),
      h('button', { class: 'primary big', onclick: onFinish }, '돌아가기'));
  }

  function nextBatch() {
    queue = pool.splice(0, FLASH_BATCH);
    total = queue.length;
    done = 0;
    show();
  }

  show();
}

async function renderStudy(deckId) {
  setHeader('학습', { deckId, tag: nav.tag });
  const cards = (await deckCards(deckId)).filter(c => !c.script);
  const scoped = nav.tag ? cards.filter(c => c.tags.includes(nav.tag)) : cards;
  flashSession({
    items: dueItems(scoped),
    patchFn: ratePatch,
    onFinish: () => go({ deckId, tag: nav.tag })
  });
}

// ---------- 4지선다 ----------
function makeQuestion(card, dir, pool) {
  let prompt, answer, distractors;
  if (card.type === 'cloze') {
    const answers = clozeAnswers(card.front);
    if (!answers.length) return null;
    answer = answers[0];
    prompt = clozeNodes(card.front, false, 0);
    distractors = pool
      .filter(c => c.id !== card.id && c.type === 'cloze')
      .flatMap(c => clozeAnswers(c.front));
  } else {
    const f = dir === 'f';
    prompt = f ? card.front : card.back;
    answer = f ? card.back : card.front;
    distractors = pool
      .filter(c => c.id !== card.id && isPairCard(c))
      .map(c => (f ? c.back : c.front));
  }
  distractors = unique(distractors.filter(w => w !== answer));
  if (!distractors.length) return null;
  return {
    card, prompt, answer,
    options: shuffle([answer, ...shuffle(distractors).slice(0, 3)])
  };
}

async function renderQuiz(deckId) {
  setHeader('4지선다', { deckId, tag: nav.tag });
  const all = (await deckCards(deckId)).filter(c => !c.script);
  const scoped = nav.tag ? all.filter(c => c.tags.includes(nav.tag)) : all;

  const questions = shuffle(scoped)
    .map(c => makeQuestion(c, c.type === 'basic' && c.reverse && Math.random() < 0.5 ? 'r' : 'f', all))
    .filter(Boolean)
    .slice(0, QUIZ_LENGTH);

  if (!questions.length) {
    $view.append(h('p', { class: 'empty' }, '보기를 만들 카드가 부족해요.\n카드를 더 추가해 주세요.'));
    return;
  }

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

    const star = starButton(q.card, true);
    const buttons = q.options.map(opt => {
      const b = h('button', { class: 'opt' }, opt);
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
      next.hidden = false;
      if (star) star.hidden = false;
    }

    stage.append(h('div', { class: 'quiz-q' }, q.prompt), h('div', { class: 'options' }, buttons), star, next);
  }

  function finish() {
    count.textContent = `${questions.length} / ${questions.length}`;
    stage.replaceChildren(
      h('div', { class: 'done' }, score === questions.length ? '🎉' : '👍',
        h('p', null, `${questions.length}문제 중 ${score}개 정답`)),
      isReadOnly() ? null : h('p', { class: 'hint' }, '틀린 문제는 오답노트에 담겼어요.'),
      h('button', { class: 'primary big', onclick: () => render() }, '다시 풀기'),
      h('button', { onclick: () => go({ deckId, tag: nav.tag }) }, '덱으로 돌아가기'));
  }

  show();
}

// ---------- 매칭 게임 ----------
async function renderMatch(deckId) {
  setHeader('매칭 게임', { deckId, tag: nav.tag });
  const all = (await deckCards(deckId)).filter(c => !c.script);
  const scoped = (nav.tag ? all.filter(c => c.tags.includes(nav.tag)) : all).filter(isPairCard);
  const picked = shuffle(scoped).slice(0, MATCH_PAIRS);

  if (picked.length < 2) {
    $view.append(h('p', { class: 'empty' }, '기본 카드가 2장 이상 필요해요.'));
    return;
  }

  const status = h('div', { class: 'progress-text' });
  const grid = h('div', { class: 'match-grid' });
  $view.append(status, grid);

  const byId = new Map(picked.map(c => [c.id, c]));
  const makeItem = (c, side) => {
    const b = h('button', { class: 'match-item' }, side === 'l' ? c.front : c.back);
    b.dataset.id = c.id;
    b.dataset.side = side;
    return b;
  };
  const lefts = shuffle(picked).map(c => makeItem(c, 'l'));
  const rights = shuffle(picked).map(c => makeItem(c, 'r'));
  grid.append(
    h('div', { class: 'match-col' }, lefts),
    h('div', { class: 'match-col' }, rights));

  const started = Date.now();
  const missed = new Set();
  let matched = 0, mistakes = 0, selected = null;
  const updateStatus = () => { status.textContent = `${matched} / ${picked.length} · 실수 ${mistakes}`; };
  updateStatus();

  [...lefts, ...rights].forEach(btn => btn.addEventListener('click', async () => {
    if (btn.classList.contains('matched')) return;

    if (!selected || selected.dataset.side === btn.dataset.side) {
      selected?.classList.remove('selected');
      selected = btn;
      btn.classList.add('selected');
      return;
    }

    const first = selected;
    selected = null;
    first.classList.remove('selected');

    if (first.dataset.id === btn.dataset.id) {
      first.classList.add('matched');
      btn.classList.add('matched');
      matched++;
      updateStatus();
      if (matched === picked.length) finish();
    } else {
      mistakes++;
      updateStatus();
      [first, btn].forEach(b => {
        b.classList.add('wrong');
        setTimeout(() => b.classList.remove('wrong'), 450);
      });
      // 헷갈린 카드는 오답노트에 (게임당 카드별 한 번만)
      for (const id of [first.dataset.id, btn.dataset.id]) {
        if (missed.has(id)) continue;
        missed.add(id);
        const card = byId.get(id);
        await applyPatch(card, wrongPatch(card));
      }
    }
  }));

  function finish() {
    const sec = Math.round((Date.now() - started) / 1000);
    grid.replaceChildren(
      h('div', { class: 'done' }, '🎉', h('p', null, `${sec}초 · 실수 ${mistakes}번`)),
      mistakes && !isReadOnly() ? h('p', { class: 'hint' }, '헷갈린 카드는 오답노트에 담겼어요.') : null,
      h('button', { class: 'primary big', onclick: () => render() }, '한 판 더'),
      h('button', { onclick: () => go({ deckId, tag: nav.tag }) }, '덱으로 돌아가기'));
  }
}

// ---------- 전체 검색 ----------
const SEARCH_LIMIT = 100;
const SEMANTIC_LIMIT = 20;
let lastQuery = '';

async function renderSearch() {
  setHeader('검색');
  const [cards, decks] = await Promise.all([Store.listAllCards(), Store.listDecks()]);
  const names = new Map(decks.map(d => [d.id, d.name]));
  const pool = cards.filter(c => names.has(c.deckId));
  const deckChip = c => h('button', {
    class: 'tag kind', type: 'button', onclick: () => go({ deckId: c.deckId })
  }, names.get(c.deckId));

  const input = h('input', {
    type: 'search', class: 'search', value: lastQuery,
    placeholder: '한글 · English · 日本語 · romaji 로 검색',
    autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false'
  });
  const info = h('p', { class: 'hint' });
  const listEl = h('div', { class: 'list' });
  const semEl = h('div', { class: 'list' });

  // 의미 검색: 글자가 안 맞아도 뜻이 비슷한 카드를 아래에 덧붙인다 (설정에서 켠 경우에만)
  let seq = 0, timer;
  const semanticPaint = (q, found, baseInfo) => {
    clearTimeout(timer);
    const mine = ++seq;
    semEl.replaceChildren();
    if (!q.trim() || !(window.Embed && Embed.isEnabled())) return;
    timer = setTimeout(async () => {
      try {
        const sims = await Embed.similarToText(q, pool, (d, t) => {
          if (mine === seq) info.textContent = `의미 분석 중… ${d}/${t}`;
        });
        if (mine !== seq) return;
        info.textContent = baseInfo;
        const seen = new Set(found.map(c => c.id));
        const more = pool
          .filter(c => !seen.has(c.id) && (sims.get(c.id) || 0) >= Search.SEMANTIC_MIN)
          .sort((a, b) => sims.get(b.id) - sims.get(a.id))
          .slice(0, SEMANTIC_LIMIT);
        if (!more.length) return;
        semEl.append(h('p', { class: 'hint' }, '뜻이 비슷한 카드'),
          more.map(c => cardRow(c, [deckChip(c), h('span', { class: 'tag' }, `의미 ${Math.round(sims.get(c.id) * 100)}%`)])));
      } catch (e) {
        if (mine === seq) info.textContent = '의미 검색을 쓸 수 없어요: ' + e.message;
      }
    }, 400);
  };

  const paint = () => {
    lastQuery = input.value;
    listEl.replaceChildren();
    if (!input.value.trim()) {
      info.textContent = `카드 ${pool.length}장 전체에서 찾아요. 뜻·발음·예문·태그 어디에 있어도 나와요.`;
      return semanticPaint('', [], '');
    }
    const found = Search.filter(pool, input.value, names);
    info.textContent = found.length ? `${found.length}장` : '검색 결과가 없어요.';
    for (const c of found.slice(0, SEARCH_LIMIT)) listEl.append(cardRow(c, deckChip(c)));
    if (found.length > SEARCH_LIMIT) {
      listEl.append(h('p', { class: 'hint' }, `처음 ${SEARCH_LIMIT}장만 보여줘요. 검색어를 더 적어 보세요.`));
    }
    semanticPaint(input.value, found, info.textContent);
  };
  input.addEventListener('input', paint);
  $view.append(input, info, listEl, semEl);
  paint();
}

// ---------- 오답노트 ----------
async function loadNoteCards() {
  const [cards, decks] = await Promise.all([Store.listAllCards(), Store.listDecks()]);
  const names = new Map(decks.map(d => [d.id, d.name]));
  const list = cards
    .filter(c => c.note && names.has(c.deckId))
    .sort((a, b) => b.wrong - a.wrong);
  return { list, names };
}

async function renderNote() {
  setHeader('오답노트');
  const { list, names } = await loadNoteCards();

  if (!list.length) {
    $view.append(h('p', { class: 'empty' }, '오답노트가 비어 있어요.\n학습이나 퀴즈에서 틀린 카드가 여기에 모여요.'));
    return;
  }

  $view.append(
    h('button', { class: 'primary big', onclick: () => go({ tab: 'note', mode: 'study' }) },
      `오답 복습 (${list.length}장)`),
    h('p', { class: 'hint' }, `'알아'를 ${NOTE_CLEAR_STREAK}번 연속 맞히면 오답노트에서 빠져요.`));

  const listEl = h('div', { class: 'list' });
  for (const c of list) {
    const row = cardRow(c, h('span', { class: 'tag' }, names.get(c.deckId)));
    row.append(h('button', {
      class: 'icon-btn', 'aria-label': '오답노트에서 빼기',
      onclick: async () => {
        await Store.updateCard(c.id, { note: false, streak: 0 });
        render();
      }
    }, '✓'));
    listEl.append(row);
  }
  $view.append(listEl);
}

async function renderNoteStudy() {
  setHeader('오답 복습', { tab: 'note' });
  const { list } = await loadNoteCards();
  flashSession({
    items: list.map(card => ({ card, dir: 'f' })),
    patchFn: noteRatePatch,
    onFinish: () => go({ tab: 'note' })
  });
}

// ---------- 설정 ----------
// 의미 검색(임베딩) 켜기/끄기. 켜면 모델(약 135MB)을 한 번 받고 모든 카드를 분석해 둔다.
function semanticPanel() {
  const on = Embed.isEnabled();
  const status = h('p', null, on
    ? '켜져 있어요. 관련 카드와 검색에서 뜻이 비슷한 카드도 찾아요.'
    : '카드의 뜻이 비슷한 것도 찾아요 (犬 ↔ 猫, 개 ↔ dog). 처음 한 번 약 135MB 모델을 받고, 계산은 이 기기에서만 해요. 카드 내용은 밖으로 나가지 않아요.');
  const btn = h('button', { class: on ? '' : 'primary' }, on ? '끄기 (분석 데이터 삭제)' : '켜기 (약 135MB 다운로드)');
  btn.addEventListener('click', async () => {
    if (!on && !confirm('약 135MB를 내려받아요. Wi-Fi에 연결돼 있나요? 계속할까요?')) return;
    btn.disabled = true;
    try {
      if (on) {
        await Embed.disable();
        toast('껐어요');
      } else {
        await Embed.enable((l, t) => { status.textContent = `모델 받는 중… ${Math.round(l / 1048576)} / ${Math.round(t / 1048576)}MB`; });
        await Embed.ensureIndex(await Store.listAllCards(), (d, t) => { status.textContent = `카드 분석 중… ${d}/${t}`; });
        toast('켜졌어요');
      }
      render();
    } catch (e) {
      status.textContent = '실패: ' + e.message;
      btn.disabled = false;
    }
  });
  return h('section', { class: 'panel' }, h('h2', null, '의미 검색 (AI)'), status, btn);
}

function renderSettings() {
  setHeader('설정');
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (!confirm('가져오면 현재 데이터가 백업 파일 내용으로 교체돼요. 계속할까요?')) return;
    try {
      await Store.importAll(await file.text());
      toast('가져오기 완료');
      go({});
    } catch (e) {
      toast('가져오기 실패: ' + e.message);
    }
  });

  const sync = window.Sync && window.Sync.state;
  if (sync && sync.enabled) {
    $view.append(h('section', { class: 'panel' },
      h('h2', null, '클라우드 동기화'),
      sync.user
        ? [
            h('p', null, `${sync.user.name || sync.user.email} 계정으로 로그인됨`
              + (sync.syncing ? ' · 동기화 중…' : ' · 동기화됨')),
            h('p', null, sync.isOwner
              ? '소유자 계정이에요. 이 기기의 카드가 클라우드와 동기화돼요.'
              : '본인 계정의 데이터예요. 다른 사람의 카드와 섞이지 않고, 같은 계정으로 로그인한 기기끼리 동기화돼요.'),
            h('p', null, '로그아웃하면 소유자의 카드를 읽기 전용으로 보게 돼요. 로그인한 계정의 카드는 다시 로그인하면 돌아와요.'),
            sync.error ? h('p', { class: 'error' }, sync.error) : null,
            h('button', { onclick: () => window.Sync.signOut() }, '로그아웃')
          ]
        : [
            h('p', null, '지금은 읽기 전용이에요. 카드를 보고 학습만 할 수 있어요. 본인 카드를 만들고 오답노트를 쓰려면 구글 계정으로 로그인하세요.'),
            sync.error ? h('p', { class: 'error' }, sync.error) : null,
            h('button', { class: 'primary', onclick: () => window.Sync.signIn() }, '구글로 로그인')
          ]));
  }

  if (window.Embed) $view.append(semanticPanel());

  // 게스트는 가져오기(데이터 교체)를 쓸 수 없다.
  if (isReadOnly()) return;
  $view.append(h('section', { class: 'panel' },
    h('h2', null, '백업'),
    h('p', null, '카드는 이 기기의 브라우저에만 저장돼요. 브라우저 데이터를 지우면 사라지니 가끔 백업하세요.'),
    h('div', { class: 'row' },
      h('button', {
        class: 'primary',
        onclick: async () => {
          const blob = new Blob([await Store.exportAll()], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: `flashcard-backup-${new Date().toISOString().slice(0, 10)}.json` });
          a.click();
          URL.revokeObjectURL(a.href);
        }
      }, '내보내기'),
      h('button', { onclick: () => fileInput.click() }, '가져오기'),
      fileInput)));
}

// 다른 기기에서 바뀐 내용이 들어오면 화면을 갱신한다.
// 학습/퀴즈 진행 중이거나 입력 중이면 방해하지 않는다.
Store.onRemoteChange(() => {
  if (nav.mode || document.querySelector('dialog[open]')) return;
  const el = document.activeElement;
  if (el && /^(TEXTAREA|INPUT|SELECT)$/.test(el.tagName)) return;
  render();
});
let lastReadOnly = isReadOnly();
window.addEventListener('sync-state', () => {
  // 로그인 상태가 바뀌어 편집 권한이 달라지면 화면을 다시 그린다.
  const changed = lastReadOnly !== isReadOnly();
  lastReadOnly = isReadOnly();
  const busy = nav.mode || document.querySelector('dialog[open]');
  if (nav.tab === 'settings' || (changed && !busy)) render();
});

Store.requestPersistence();
render();
