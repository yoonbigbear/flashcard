// 대화 스크립트: 붙여넣은 대화문을 줄 단위 카드로 저장하고, 빈칸 채우기로 연습한다.
//
// 스크립트의 한 줄은 평범한 basic 카드에 아래 필드를 더한 것이다.
//   script      스크립트 id (같은 값끼리 한 스크립트)
//   scriptName  스크립트 이름
//   order       스크립트 안에서의 순서
//   speaker     화자 (A, B ...)
//   read        한글 발음
//   tokens      단어 분리 결과 [{s, k, p}] (japanese.js 참고). 빈칸 후보는 k === 2
// front=일본어, back=한국어 뜻. 일반 학습/퀴즈에서는 빠지고 이 연습 모드에서만 쓰인다.

const SCRIPT_OPTS_KEY = 'flashcard-script-opts';
const SCRIPT_PRESETS = {
  easy:   { ratio: 0.1, distract: 0, meaning: true,  read: true },
  normal: { ratio: 0.2, distract: 2, meaning: true,  read: false },
  hard:   { ratio: 0.4, distract: 4, meaning: false, read: false }
};
const SCRIPT_PRESET_NAMES = { easy: '쉬움', normal: '보통', hard: '어려움' };

function loadScriptOpts() {
  const base = { level: 'normal', ...SCRIPT_PRESETS.normal, input: 'bank', chunk: 4 };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(SCRIPT_OPTS_KEY)) };
  } catch (e) {
    return base;
  }
}
const saveScriptOpts = opts => localStorage.setItem(SCRIPT_OPTS_KEY, JSON.stringify(opts));

const scriptTokens = card =>
  Array.isArray(card.tokens) && card.tokens.length ? card.tokens : JP.fallbackTokens(card.front);

// ---------- 덱 화면의 스크립트 영역 ----------
function scriptSection(deckId, lineCards) {
  const groups = new Map();
  for (const c of lineCards) {
    if (!groups.has(c.script)) groups.set(c.script, []);
    groups.get(c.script).push(c);
  }

  const el = h('section', { class: 'panel' }, h('h2', null, '대화 스크립트'));
  if (!groups.size) {
    el.append(h('p', null, '대화문을 붙여넣으면 빈칸 채우기로 연습할 수 있어요.'));
  }
  for (const [id, lines] of groups) {
    lines.sort((a, b) => (a.order || 0) - (b.order || 0));
    el.append(scriptItem(deckId, id, lines));
  }
  if (!isReadOnly()) {
    el.append(h('button', { class: 'primary', onclick: () => addScriptDialog(deckId) }, '+ 스크립트 추가'));
  }
  return el;
}

function scriptItem(deckId, scriptId, lines) {
  const name = lines[0].scriptName || '대화';
  const missingRead = lines.some(c => !c.read);

  const actions = h('div', { class: 'row' },
    h('button', {
      class: 'primary',
      onclick: () => go({ deckId, mode: 'script', scriptId })
    }, '연습 시작'));

  if (!isReadOnly()) {
    if (missingRead) {
      actions.append(h('button', {
        onclick: async e => {
          e.target.disabled = true;
          if (await fillReadings(lines)) render();
          else e.target.disabled = false;
        }
      }, '발음 생성'));
    }
    actions.append(h('button', {
      class: 'danger',
      onclick: async () => {
        if (!confirm(`'${name}' 스크립트(${lines.length}줄)를 삭제할까요?`)) return;
        for (const c of lines) await Store.deleteCard(c.id);
        render();
      }
    }, '삭제'));
  }

  const list = h('div', { class: 'list' }, lines.map(c => {
    const extra = [
      c.speaker ? h('span', { class: 'tag kind' }, c.speaker) : null,
      c.read ? h('span', { class: 'tag' }, c.read) : null
    ];
    return cardRow(c, extra);
  }));

  return h('details', { class: 'script-item' },
    h('summary', null, name, h('span', { class: 'tag' }, `${lines.length}줄`)),
    actions, list);
}

// 한자 읽기와 단어 분리를 사전(kuromoji)으로 다시 계산해 저장한다.
// 이미 적어 둔 발음은 건드리지 않는다. 성공하면 true.
async function fillReadings(lines) {
  toast('일본어 사전을 불러오는 중… (처음 한 번만 걸려요)');
  try {
    await JP.load();
  } catch (e) {
    toast(e.message);
    return false;
  }
  for (const c of lines) {
    const tokens = JP.analyze(c.front);
    await Store.updateCard(c.id, { tokens, ...(c.read ? {} : { read: JP.hangulReading(tokens) }) });
  }
  toast('발음을 만들었어요. 틀린 곳은 ✎ 로 고칠 수 있어요');
  return true;
}

// ---------- 스크립트 추가 ----------
function addScriptDialog(deckId) {
  const name = h('input', { type: 'text', class: 'text-input', placeholder: '스크립트 이름 (예: 식당에서)' });
  const text = h('textarea', {
    rows: '9',
    placeholder: 'A: 昨日、映画館で友達に会いました。\n어제 영화관에서 친구를 만났어요.\nB: 何を見たんですか。\n무엇을 봤어요?\n\n'
      + '(한 줄에 `일본어 | 뜻` 으로 적어도 돼요)'
  });
  const preview = h('p', { class: 'hint' }, '대화문을 붙여넣으세요.');
  const reading = h('input', { type: 'checkbox' });
  reading.checked = true;
  const status = h('p', { class: 'hint' });

  text.addEventListener('input', () => {
    const { items, skipped } = JP.parseScript(text.value);
    if (!items.length) { preview.textContent = text.value.trim() ? '일본어 문장을 찾지 못했어요.' : '대화문을 붙여넣으세요.'; return; }
    const first = items[0];
    preview.textContent = `${items.length}줄 인식` + (skipped ? ` · 건너뜀 ${skipped}` : '')
      + ` · 첫 줄: ${first.front}${first.back ? ' / ' + first.back : ''}`;
  });

  const cancel = h('button', { type: 'button', onclick: () => dlg.close() }, '취소');
  const save = h('button', {
    type: 'button', class: 'primary',
    onclick: async () => {
      const { items } = JP.parseScript(text.value);
      if (!items.length) return toast('일본어 문장을 찾지 못했어요');
      cancel.disabled = save.disabled = true;

      if (reading.checked) {
        status.textContent = '일본어 사전을 불러오는 중… (처음 한 번만 걸려요)';
        try { await JP.load(); } catch (e) { toast(e.message + ' 발음 없이 저장해요.'); }
      }

      status.textContent = '저장하는 중…';
      const id = Date.now().toString(36);
      const scriptName = name.value.trim() || '대화 ' + new Date().toLocaleDateString();
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const tokens = JP.analyze(it.front);
        await Store.addCard(deckId, {
          type: 'basic', front: it.front, back: it.back, tags: [], reverse: false,
          script: id, scriptName, order: i, speaker: it.speaker,
          read: it.read || (JP.isLoaded() ? JP.hangulReading(tokens) : ''),
          tokens
        });
      }
      dlg.close();
      toast(`${items.length}줄을 저장했어요`);
      render();
    }
  }, '저장');

  const dlg = h('dialog', { class: 'dialog' },
    h('h2', null, '대화 스크립트 추가'),
    h('div', { class: 'card-fields' },
      name, text, preview,
      h('label', { class: 'check' }, reading, '한글 발음 자동 생성 (처음 한 번 사전 약 17MB 다운로드)'),
      status),
    h('div', { class: 'row' }, cancel, save));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  text.focus();
}

// ---------- 연습: 설정 화면 ----------
async function renderScriptPractice(deckId, scriptId) {
  const lines = (await Store.listCards(deckId))
    .filter(c => c.script === scriptId)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  if (!lines.length) return go({ deckId });

  setHeader(lines[0].scriptName || '대화 연습', { deckId });
  const opts = loadScriptOpts();
  const panel = h('section', { class: 'panel' });
  $view.append(panel);

  const select = (label, options, value, onChange) => {
    const el = h('select', null, options.map(([v, text]) => h('option', { value: String(v) }, text)));
    el.value = String(value);
    el.addEventListener('change', () => onChange(el.value));
    return h('label', { class: 'field' }, h('span', null, label), el);
  };
  const toggle = (label, value, onChange) => {
    const el = h('input', { type: 'checkbox' });
    el.checked = value;
    el.addEventListener('change', () => onChange(el.checked));
    return h('label', { class: 'check' }, el, label);
  };
  const set = (patch, custom = true) => {
    Object.assign(opts, patch);
    if (custom) opts.level = 'custom';
    saveScriptOpts(opts);
    paint();
  };

  function paint() {
    const blanks = lines.reduce((n, c) => n + scriptTokens(c).filter(t => t.k === 2).length, 0);
    panel.replaceChildren(
      h('h2', null, `${lines.length}줄 · 빈칸 후보 ${blanks}개`),
      h('div', { class: 'chips' }, Object.entries(SCRIPT_PRESET_NAMES).map(([key, label]) =>
        h('button', {
          class: 'chip' + (opts.level === key ? ' active' : ''),
          onclick: () => set({ level: key, ...SCRIPT_PRESETS[key] }, false)
        }, label))),
      select('빈칸 비율', [[0.1, '10%'], [0.2, '20%'], [0.3, '30%'], [0.5, '50%'], [0.7, '70%']],
        opts.ratio, v => set({ ratio: Number(v) })),
      select('답하는 방식', [['bank', '단어 은행에서 고르기'], ['type', '직접 입력']],
        opts.input, v => set({ input: v }, false)),
      opts.input === 'bank'
        ? select('오답 단어', [[0, '없음'], [2, '2개 섞기'], [4, '4개 섞기'], [6, '6개 섞기']],
          opts.distract, v => set({ distract: Number(v) }))
        : null,
      select('한 번에 보기', [[3, '3줄'], [4, '4줄'], [6, '6줄'], [0, '전체']],
        opts.chunk, v => set({ chunk: Number(v) }, false)),
      toggle('한국어 뜻 보기', opts.meaning, v => set({ meaning: v })),
      toggle('한글 발음 보기', opts.read, v => set({ read: v })),
      h('button', { class: 'primary big', onclick: () => runScript(deckId, lines, opts) }, '시작'));
  }
  paint();
}

// ---------- 연습: 진행 화면 ----------
function runScript(deckId, lines, opts) {
  $view.replaceChildren();
  const rounds = [];
  const size = opts.chunk > 0 ? opts.chunk : lines.length;
  for (let i = 0; i < lines.length; i += size) rounds.push(lines.slice(i, i + size));

  // 오답 단어는 같은 스크립트의 다른 단어에서 가져온다.
  const pool = unique(lines.flatMap(c => scriptTokens(c).filter(t => t.k === 2).map(t => t.s)));

  const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const count = h('div', { class: 'progress-text' });
  const stage = h('div', { class: 'stage' });
  $view.append(count, bar, stage);

  let round = 0, right = 0, total = 0;

  function showRound() {
    stage.replaceChildren();
    $view.scrollTop = 0;
    bar.firstChild.style.width = `${(round / rounds.length) * 100}%`;
    count.textContent = `${round + 1} / ${rounds.length}`;
    const cards = rounds[round];

    // 빈칸 고르기
    const cands = [];
    cards.forEach((card, li) => scriptTokens(card).forEach((t, ti) => {
      if (t.k === 2 && /\S/.test(t.s)) cands.push(`${li}:${ti}`);
    }));
    const n = cands.length ? Math.min(cands.length, Math.max(1, Math.round(cands.length * opts.ratio))) : 0;
    const chosen = new Set(shuffle(cands).slice(0, n));

    const typing = opts.input === 'type';
    const gaps = [];
    let active = null;
    let graded = false;

    const lineEls = cards.map((card, li) => {
      const text = h('div', { class: 'script-text' });
      scriptTokens(card).forEach((t, ti) => {
        if (!chosen.has(`${li}:${ti}`)) { text.append(t.s); return; }
        const el = typing
          ? h('input', {
            type: 'text', class: 'gap-input', autocomplete: 'off', autocapitalize: 'off',
            spellcheck: 'false', lang: 'ja', 'aria-label': '빈칸'
          })
          : h('button', { type: 'button', class: 'gap', 'aria-label': '빈칸' });
        el.style.minWidth = `${Math.max(2.5, t.s.length * 1.15 + 1)}em`;
        const gap = { card, ans: t.s, el, chip: null };
        gaps.push(gap);
        text.append(el);
        if (typing) {
          el.addEventListener('keydown', e => {
            if (e.key !== 'Enter' || e.isComposing) return;
            e.preventDefault();
            const next = gaps[gaps.indexOf(gap) + 1];
            if (next) next.el.focus(); else grade();
          });
        } else {
          el.addEventListener('click', () => {
            if (graded) return;
            if (gap.chip) release(gap);
            setActive(gap);
          });
        }
      });

      // 뜻·발음을 숨겼다면 채점 후에 보여 준다.
      const read = card.read ? h('div', { class: 'script-read', hidden: !opts.read }, card.read) : null;
      const meaning = card.back ? h('div', { class: 'script-meaning', hidden: !opts.meaning }, card.back) : null;
      return {
        meaning, read,
        el: h('div', { class: 'script-line' },
          card.speaker ? h('span', { class: 'script-speaker' }, card.speaker) : null,
          h('div', { class: 'script-body' }, text, read, meaning))
      };
    });

    // 단어 은행
    const answers = gaps.map(g => g.ans);
    const extra = shuffle(pool.filter(w => !answers.includes(w))).slice(0, opts.distract);
    const chips = typing ? [] : shuffle([...answers, ...extra]).map(word => {
      const chip = { word, used: false, el: h('button', { type: 'button', class: 'word' }, word) };
      chip.el.addEventListener('click', () => place(chip));
      return chip;
    });

    function setActive(g) {
      active?.el.classList.remove('active');
      active = g;
      g?.el.classList.add('active');
    }
    function release(g) {
      g.chip.used = false;
      g.chip.el.disabled = false;
      g.chip = null;
      g.el.textContent = '';
      g.el.classList.remove('filled');
    }
    function place(chip) {
      if (graded || chip.used || !active) return;
      if (active.chip) release(active);
      active.chip = chip;
      chip.used = true;
      chip.el.disabled = true;
      active.el.textContent = chip.word;
      active.el.classList.add('filled');
      setActive(gaps.find(g => !g.chip) || active);
    }

    const action = h('button', { type: 'button', class: 'primary big', onclick: () => grade() }, '채점하기');
    const bank = h('div', { class: 'bank-wrap' },
      chips.length ? h('div', { class: 'bank' }, chips.map(c => c.el)) : null,
      action);

    stage.append(h('div', { class: 'script' }, lineEls.map(l => l.el)), bank);

    async function grade() {
      if (graded) return;
      graded = true;
      const wrongCards = new Set();

      for (const g of gaps) {
        const given = typing ? g.el.value : (g.chip ? g.chip.word : '');
        const ok = JP.sameAnswer(given, g.ans);
        total++;
        if (ok) right++; else wrongCards.add(g.card);
        g.el.replaceWith(h('span', { class: 'gap-result ' + (ok ? 'ok' : 'ng') },
          !ok && given ? h('s', null, given) : null,
          g.ans));
      }
      chips.forEach(c => { c.el.disabled = true; });
      lineEls.forEach(l => { if (l.meaning) l.meaning.hidden = false; if (l.read) l.read.hidden = false; });

      // 틀린 줄은 오답노트로, 맞힌 줄은 노트에서의 연속 정답으로 센다.
      for (const card of new Set(gaps.map(g => g.card))) {
        await applyPatch(card, wrongCards.has(card) ? wrongPatch(card) : correctNotePatch(card));
      }

      action.textContent = round === rounds.length - 1 ? '결과 보기' : '다음';
      action.onclick = () => { round++; if (round >= rounds.length) finish(); else showRound(); };
    }

    if (gaps.length) setActive(gaps[0]);
  }

  function finish() {
    bar.firstChild.style.width = '100%';
    count.textContent = `${rounds.length} / ${rounds.length}`;
    stage.replaceChildren(
      h('div', { class: 'done' }, right === total ? '🎉' : '👍',
        h('p', null, total ? `빈칸 ${total}개 중 ${right}개 정답` : '빈칸이 없었어요')),
      total && right < total ? h('p', { class: 'hint' }, '틀린 줄은 오답노트에 담겼어요.') : null,
      h('button', { class: 'primary big', onclick: () => runScript(deckId, lines, opts) }, '다시 (새 빈칸)'),
      h('button', { onclick: () => render() }, '난이도 바꾸기'),
      h('button', { onclick: () => go({ deckId }) }, '덱으로 돌아가기'));
  }

  showRound();
}
