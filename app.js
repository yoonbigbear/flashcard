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

// 카드 한 면의 내용. dir: 'f'(앞→뒤) | 'r'(뒤→앞)
function faceNodes(card, dir, flipped) {
  if (card.type === 'cloze') {
    return flipped
      ? [h('div', null, clozeNodes(card.front, true)),
         card.back ? h('div', { class: 'q-small' }, card.back) : null]
      : [h('div', null, clozeNodes(card.front, false))];
  }
  const q = dir === 'r' ? card.back : card.front;
  const a = dir === 'r' ? card.front : card.back;
  return flipped
    ? [h('div', { class: 'q-small' }, q), h('div', null, a)]
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
  document.querySelectorAll('.tabbar button').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === nav.tab));
  $view.replaceChildren();
  $view.scrollTop = 0;

  if (nav.tab === 'settings') return renderSettings();
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
    h('option', { value: 'cloze' }, '빈칸 문장'));
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

  const tags = h('input', { type: 'text', class: 'text-input', placeholder: '태그 (쉼표로 구분, 예: 명사, 시험)' });
  tags.value = c.tags.join(', ');

  const rev = h('input', { type: 'checkbox' });
  rev.checked = c.reverse;
  const revLabel = h('label', { class: 'check' }, rev, '양방향 (뒤→앞도 복습)');

  function sync() {
    const cloze = type.value === 'cloze';
    front.placeholder = cloze ? '문장 (빈칸은 {{단어}} 로 표시)' : '앞면 (질문)';
    back.placeholder = cloze ? '메모 / 뜻 (선택)' : '뒷면 (답)';
    blankBtn.hidden = !cloze;
    revLabel.hidden = cloze;
  }
  type.addEventListener('change', sync);
  sync();
  if (isLine) { type.hidden = true; blankBtn.hidden = true; revLabel.hidden = true; }

  return {
    el: h('div', { class: 'card-fields' }, type, front, blankBtn, back, isLine ? read : null, tags, revLabel),
    front,
    // 검증에 실패하면 null
    get() {
      const isCloze = type.value === 'cloze';
      const f = front.value.trim(), b = back.value.trim();
      if (!f) { toast('내용을 입력하세요'); return null; }
      if (isCloze && !clozeAnswers(f).length) { toast('{{단어}} 형태로 빈칸을 하나 이상 지정하세요'); return null; }
      if (!isCloze && !b && !isLine) { toast('앞면과 뒷면을 모두 입력하세요'); return null; }
      return {
        type: type.value,
        front: f,
        back: b,
        tags: unique(tags.value.split(/[,，]/).map(t => t.trim()).filter(Boolean)),
        reverse: !isCloze && rev.checked,
        ...(isLine ? { read: read.value.trim() } : {})
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
  const deck = (await Store.listDecks()).find(d => d.id === deckId);
  if (!deck) return go({});
  setHeader(deck.name, {});

  // 대화 스크립트의 줄은 스크립트 영역에서 따로 다루고, 일반 카드 목록·학습에서는 뺀다.
  const everything = await Store.listCards(deckId);
  const lineCards = everything.filter(c => c.script);
  const cards = everything.filter(c => !c.script).sort((a, b) => b.created - a.created);
  const tag = nav.tag;
  const scoped = tag ? cards.filter(c => c.tags.includes(tag)) : cards;
  const due = dueItems(scoped);
  const basicCount = scoped.filter(c => c.type === 'basic').length;
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

  // 카드 추가 폼 (게스트는 숨김)
  if (!isReadOnly()) {
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
    const q = search.value.trim().toLowerCase();
    listEl.replaceChildren();
    const shown = scoped.filter(c =>
      !q || (c.front + ' ' + c.back + ' ' + c.tags.join(' ')).toLowerCase().includes(q));
    for (const c of shown) listEl.append(cardRow(c));
    if (!shown.length) {
      listEl.append(h('p', { class: 'empty' }, scoped.length ? '검색 결과가 없어요.'
        : isReadOnly() ? '카드가 없어요.' : '카드를 추가해 보세요.'));
    }
  };
  search.addEventListener('input', paint);
  $view.append(search, listEl);
  paint();

  // 덱 관리 (게스트는 숨김)
  if (!isReadOnly()) $view.append(deckManageRow(deck, everything.length));
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

function cardRow(c, extra) {
  const body = c.type === 'cloze' ? clozeNodes(c.front, true) : c.front;
  return h('div', { class: 'card-row' },
    h('div', { class: 'card-text' },
      h('div', { class: 'card-front' }, body),
      c.back ? h('div', { class: 'card-back' }, c.back) : null,
      h('div', { class: 'card-meta' },
        c.type === 'cloze' ? h('span', { class: 'tag kind' }, '빈칸') : null,
        c.reverse ? h('span', { class: 'tag kind' }, '↔ 양방향') : null,
        c.note ? h('span', { class: 'tag warn' }, '오답노트') : null,
        c.wrong ? h('span', { class: 'tag' }, `✗ ${c.wrong}`) : null,
        c.tags.map(t => h('span', { class: 'tag' }, '#' + t)),
        extra || null)),
    isReadOnly() ? null : h('div', { class: 'card-actions' },
      h('button', { class: 'icon-btn', 'aria-label': '수정', onclick: () => editCard(c, render) }, '✎'),
      h('button', {
        class: 'icon-btn', 'aria-label': '삭제',
        onclick: async () => {
          if (!confirm('이 카드를 삭제할까요?')) return;
          await Store.deleteCard(c.id);
          render();
        }
      }, '🗑')));
}

// ---------- 플래시카드 세션 (학습 / 오답노트 복습 공용) ----------
function flashSession({ items, patchFn, onFinish }) {
  const queue = shuffle(items);
  const total = queue.length;
  if (!total) return onFinish();

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

    let flipped = false;
    flipCard.addEventListener('click', () => {
      flipped = !flipped;
      flipCard.classList.toggle('flipped', flipped);
      flipCard.replaceChildren(...faceNodes(card, dir, flipped));
      buttons.hidden = !flipped;
    });

    const label = dir === 'r' ? '뒤 → 앞' : null;
    stage.append(
      label ? h('div', { class: 'dir-label' }, label) : null,
      flipCard,
      h('p', { class: 'hint' }, '카드를 탭하면 뒤집혀요'),
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
    stage.replaceChildren(
      h('div', { class: 'done' }, '🎉', h('p', null, '학습을 마쳤어요!')),
      h('button', { class: 'primary big', onclick: onFinish }, '돌아가기'));
  }

  show();
}

async function renderStudy(deckId) {
  setHeader('학습', { deckId, tag: nav.tag });
  const cards = (await Store.listCards(deckId)).filter(c => !c.script);
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
      .filter(c => c.id !== card.id && c.type === 'basic')
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
  const all = (await Store.listCards(deckId)).filter(c => !c.script);
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
    }

    stage.append(h('div', { class: 'quiz-q' }, q.prompt), h('div', { class: 'options' }, buttons), next);
  }

  function finish() {
    count.textContent = `${questions.length} / ${questions.length}`;
    stage.replaceChildren(
      h('div', { class: 'done' }, score === questions.length ? '🎉' : '👍',
        h('p', null, `${questions.length}문제 중 ${score}개 정답`)),
      h('p', { class: 'hint' }, '틀린 문제는 오답노트에 담겼어요.'),
      h('button', { class: 'primary big', onclick: () => render() }, '다시 풀기'),
      h('button', { onclick: () => go({ deckId, tag: nav.tag }) }, '덱으로 돌아가기'));
  }

  show();
}

// ---------- 매칭 게임 ----------
async function renderMatch(deckId) {
  setHeader('매칭 게임', { deckId, tag: nav.tag });
  const all = (await Store.listCards(deckId)).filter(c => !c.script);
  const scoped = (nav.tag ? all.filter(c => c.tags.includes(nav.tag)) : all).filter(c => c.type === 'basic');
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
      mistakes ? h('p', { class: 'hint' }, '헷갈린 카드는 오답노트에 담겼어요.') : null,
      h('button', { class: 'primary big', onclick: () => render() }, '한 판 더'),
      h('button', { onclick: () => go({ deckId, tag: nav.tag }) }, '덱으로 돌아가기'));
  }
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
            sync.readOnly ? h('p', null, '이 계정은 읽기 전용이에요. 카드를 보고 학습만 할 수 있어요.') : null,
            h('p', null, '로그아웃해도 이 기기의 카드는 그대로 남아 있어요.'),
            sync.error ? h('p', { class: 'error' }, sync.error) : null,
            h('button', { onclick: () => window.Sync.signOut() }, '로그아웃')
          ]
        : [
            h('p', null, '지금은 읽기 전용이에요. 카드를 보고 학습만 할 수 있어요. 편집하려면 소유자 계정으로 로그인하세요.'),
            sync.error ? h('p', { class: 'error' }, sync.error) : null,
            h('button', { class: 'primary', onclick: () => window.Sync.signIn() }, '구글로 로그인')
          ]));
  }

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
