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
  const base = { level: 'normal', ...SCRIPT_PRESETS.normal, input: 'bank', chunk: 4, rate: 1, loop: false };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(SCRIPT_OPTS_KEY)) };
  } catch (e) {
    return base;
  }
}
const saveScriptOpts = opts => localStorage.setItem(SCRIPT_OPTS_KEY, JSON.stringify(opts));

const scriptTokens = card =>
  Array.isArray(card.tokens) && card.tokens.length ? card.tokens : JP.fallbackTokens(card.front);

// ---------- 유튜브 오디오 ----------
// 스크립트에 영상(video)이 연결돼 있으면, 줄마다 start 시간부터 다음 줄 시작까지만 재생한다.
const YT_ERRORS = {
  2: '영상 주소가 올바르지 않아요.',
  5: '플레이어에서 오류가 났어요.',
  100: '영상을 찾을 수 없어요.',
  101: '이 영상은 다른 사이트에서 재생할 수 없게 막혀 있어요.',
  150: '이 영상은 다른 사이트에서 재생할 수 없게 막혀 있어요.'
};

const YtAudio = (() => {
  let apiPromise = null;
  let current = null;

  const loadApi = () => {
    apiPromise ||= new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) return resolve();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
      const el = document.createElement('script');
      el.src = 'https://www.youtube.com/iframe_api';
      el.onerror = () => {
        apiPromise = null;
        reject(new Error('유튜브 플레이어를 불러오지 못했어요. 인터넷 연결을 확인하세요.'));
      };
      document.head.append(el);
    });
    return apiPromise;
  };

  // box 안에 플레이어를 만든다. 한 번에 하나만 쓰므로 이전 것은 정리한다.
  function mount(box, videoId, onError) {
    if (current) current.destroy();
    const holder = h('div');
    box.append(holder);
    let player = null, timer = null, destroyed = false;

    const ready = loadApi().then(() => new Promise(resolve => {
      if (destroyed) return;
      player = new window.YT.Player(holder, {
        videoId, width: '100%', height: '100%',
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => resolve(),
          onError: e => onError && onError(YT_ERRORS[e.data] || '영상을 재생할 수 없어요.')
        }
      });
    }));
    ready.catch(e => { if (onError) onError(e.message); });

    const stop = () => { clearInterval(timer); timer = null; };
    const ctl = {
      // start~end 구간 재생. end 가 없으면 계속 재생한다.
      async play(start, end, { rate = 1, loop = false } = {}) {
        try { await ready; } catch (e) { return; }
        if (destroyed) return;
        stop();
        player.setPlaybackRate(rate);
        player.seekTo(start, true);
        player.playVideo();
        if (end == null) return;
        let armed = false; // 이동(seek)이 끝나 구간 안에 들어온 뒤부터 끝 시간을 본다
        timer = setInterval(() => {
          const t = player.getCurrentTime();
          if (!armed) { armed = t >= start - 0.5 && t < end; return; }
          if (t < end) return;
          if (loop) { armed = false; player.seekTo(start, true); }
          else { player.pauseVideo(); stop(); }
        }, 120);
      },
      pause() { stop(); if (player && player.pauseVideo) player.pauseVideo(); },
      destroy() {
        destroyed = true;
        stop();
        try { if (player) player.destroy(); } catch (e) { /* 무시 */ }
        if (current === ctl) current = null;
      }
    };
    current = ctl;
    return ctl;
  }

  return { mount };
})();

// 줄 i 의 재생 구간. 끝은 다음 줄의 시작 시간(없으면 시작 + 8초).
function lineSegment(lines, i) {
  const start = lines[i].start;
  if (!Number.isFinite(start)) return null;
  const next = lines.slice(i + 1).find(c => Number.isFinite(c.start) && c.start > start);
  return { start, end: next ? next.start : start + 8 };
}

function audioBox(videoId) {
  const box = h('div', { class: 'yt-box' });
  const note = h('p', { class: 'hint error', hidden: true });
  const ctl = YtAudio.mount(box, videoId, msg => { note.textContent = msg; note.hidden = false; });
  return { el: h('div', null, box, note), ctl };
}

const RATES = [0.5, 0.75, 1, 1.25];

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
    actions.append(h('button', {
      onclick: async () => {
        const input = prompt('유튜브 링크 (비우면 영상 연결을 해제해요)', lines[0].video ? `https://youtu.be/${lines[0].video}` : '');
        if (input === null) return;
        const id = JP.videoId(input);
        if (input.trim() && !id) return toast('유튜브 주소를 인식하지 못했어요');
        for (const c of lines) await Store.updateCard(c.id, { video: id });
        render();
      }
    }, lines[0].video ? '영상 변경' : '영상 연결'));
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
      Number.isFinite(c.start) ? h('span', { class: 'tag' }, '⏱ ' + JP.formatTime(c.start)) : null,
      c.read ? h('span', { class: 'tag' }, c.read) : null
    ];
    return cardRow(c, extra);
  }));

  return h('details', { class: 'script-item' },
    h('summary', null, name,
      h('span', { class: 'tag' }, `${lines.length}줄`),
      lines[0].video ? h('span', { class: 'tag kind' }, '🔊 영상') : null),
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
  const all = await JP.analyzeMany(lines.map(c => c.front));
  for (const [i, c] of lines.entries()) {
    const tokens = all[i];
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
      + '(한 줄에 `일본어 | 뜻` 으로 적어도 되고, 줄 앞에 시간 `1:23` 을 붙이면 그 위치부터 재생해요.\n'
      + ' 유튜브의 "스크립트 표시"를 복사해 붙여도 돼요)'
  });
  const preview = h('p', { class: 'hint' }, '대화문을 붙여넣으세요.');
  const video = h('input', {
    type: 'url', class: 'text-input', placeholder: '유튜브 링크 (선택, 원어민 소리로 듣기 연습)'
  });
  const reading = h('input', { type: 'checkbox' });
  const status = h('p', { class: 'hint' });

  text.addEventListener('input', () => {
    const { items, skipped } = JP.parseScript(text.value);
    if (!items.length) { preview.textContent = text.value.trim() ? '일본어 문장을 찾지 못했어요.' : '대화문을 붙여넣으세요.'; return; }
    const first = items[0];
    const timed = items.filter(it => Number.isFinite(it.start)).length;
    preview.textContent = `${items.length}줄 인식` + (timed ? ` · 시간 ${timed}줄` : '')
      + (skipped ? ` · 건너뜀 ${skipped}` : '')
      + ` · 첫 줄: ${first.front}${first.back ? ' / ' + first.back : ''}`;
  });

  const cancel = h('button', { type: 'button', onclick: () => dlg.close() }, '취소');
  const save = h('button', {
    type: 'button', class: 'primary',
    onclick: async () => {
      const { items } = JP.parseScript(text.value);
      if (!items.length) return toast('일본어 문장을 찾지 못했어요');
      const videoId = JP.videoId(video.value);
      if (video.value.trim() && !videoId) return toast('유튜브 주소를 인식하지 못했어요');
      cancel.disabled = save.disabled = true;

      // 카드를 먼저 저장한다. 사전 로딩이 오래 걸리거나 멈춰도 입력한 내용은 남는다.
      status.textContent = '저장하는 중…';
      const id = Date.now().toString(36);
      const scriptName = name.value.trim() || '대화 ' + new Date().toLocaleDateString();
      const saved = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const tokens = JP.analyze(it.front);
        saved.push(await Store.addCard(deckId, {
          type: 'basic', front: it.front, back: it.back, tags: [], reverse: false,
          script: id, scriptName, order: i, speaker: it.speaker,
          video: videoId, start: Number.isFinite(it.start) ? it.start : null,
          read: it.read || '',
          tokens
        }));
      }
      dlg.close();
      toast(`${items.length}줄을 저장했어요`);
      render();
      // 발음은 저장 뒤에 사전을 받아 채운다(처음 한 번만 걸려요).
      if (reading.checked && await fillReadings(saved)) render();
    }
  }, '저장');

  const dlg = h('dialog', { class: 'dialog' },
    h('h2', null, '대화 스크립트 추가'),
    h('div', { class: 'card-fields' },
      name, video, text, preview,
      h('label', { class: 'check' }, reading, '한글 발음 자동 생성 (사전 약 17MB 다운로드, 저장 뒤 백그라운드에서 만들어요)'),
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
  const hasVideo = lines.some(c => c.video);
  const hasTimes = lines.some(c => Number.isFinite(c.start));
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
      hasVideo
        ? select('재생 속도', RATES.map(r => [r, r + '배']), opts.rate, v => set({ rate: Number(v) }, false))
        : null,
      h('button', { class: 'primary big', onclick: () => runScript(deckId, lines, opts) },
        hasVideo ? '빈칸 연습 시작' : '시작'),
      hasVideo ? h('button', {
        class: 'big',
        disabled: !hasTimes,
        onclick: () => runListen(deckId, lines, opts)
      }, hasTimes ? '🔊 듣기 연습 시작' : '듣기 연습 (줄마다 시간이 필요해요)') : null);
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

  // 영상이 연결돼 있으면 위에 플레이어를 두고, 시간이 있는 줄마다 ▶ 버튼을 단다.
  const video = lines.find(c => c.video);
  const audio = video ? audioBox(video.video) : null;
  $view.append(...(audio ? [audio.el] : []), count, bar, stage);

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
      const seg = audio ? lineSegment(lines, lines.indexOf(card)) : null;
      const play = seg ? h('button', {
        type: 'button', class: 'play-btn', 'aria-label': '이 줄 듣기',
        onclick: () => audio.ctl.play(seg.start, seg.end, { rate: opts.rate })
      }, '▶') : null;
      return {
        meaning, read,
        el: h('div', { class: 'script-line' },
          play,
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
      total && right < total && !isReadOnly() ? h('p', { class: 'hint' }, '틀린 줄은 오답노트에 담겼어요.') : null,
      h('button', { class: 'primary big', onclick: () => runScript(deckId, lines, opts) }, '다시 (새 빈칸)'),
      h('button', { onclick: () => render() }, '난이도 바꾸기'),
      h('button', { onclick: () => go({ deckId }) }, '덱으로 돌아가기'));
  }

  showRound();
}

// ---------- 듣기 연습 ----------
// 영상의 해당 구간만 들려주고, 들은 뒤에 문장을 확인하며 스스로 평가한다.
function runListen(deckId, lines, opts) {
  $view.replaceChildren();
  const video = lines.find(c => c.video);
  const queue = lines
    .map((card, i) => ({ card, seg: lineSegment(lines, i) }))
    .filter(item => item.seg);
  if (!video || !queue.length) { toast('영상과 줄마다 시간이 필요해요'); return render(); }

  const audio = audioBox(video.video);
  const total = queue.length;
  let done = 0;

  const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const count = h('div', { class: 'progress-text' });
  const stage = h('div', { class: 'stage' });
  $view.append(audio.el, count, bar, stage);

  function show() {
    stage.replaceChildren();
    const item = queue[0];
    if (!item) return finish();
    const { card, seg } = item;
    bar.firstChild.style.width = `${(done / total) * 100}%`;
    count.textContent = `${done} / ${total}`;

    const play = () => audio.ctl.play(seg.start, seg.end, { rate: opts.rate, loop: opts.loop });

    const speed = h('div', { class: 'chips' }, RATES.map(r => {
      const chip = h('button', {
        class: 'chip' + (opts.rate === r ? ' active' : ''),
        onclick: () => {
          opts.rate = r;
          saveScriptOpts(opts);
          speed.querySelectorAll('.chip').forEach((el, i) => el.classList.toggle('active', RATES[i] === r));
          play();
        }
      }, r + '배');
      return chip;
    }));
    const loopBtn = h('button', {
      class: 'chip' + (opts.loop ? ' active' : ''),
      onclick: () => {
        opts.loop = !opts.loop;
        saveScriptOpts(opts);
        loopBtn.classList.toggle('active', opts.loop);
        play();
      }
    }, '🔁 반복');
    speed.append(loopBtn);

    const answer = h('div', { class: 'listen-answer', hidden: true },
      h('div', { class: 'script-text' }, card.speaker ? `${card.speaker}: ` : '', card.front),
      card.read ? h('div', { class: 'script-read' }, card.read) : null,
      card.back ? h('div', { class: 'script-meaning' }, card.back) : null);

    const rate = h('div', { class: 'rate', hidden: true },
      h('button', { class: 'danger', onclick: () => finishLine('again') }, '못 들었어'),
      h('button', { onclick: () => finishLine('hard') }, '애매'),
      h('button', { class: 'primary', onclick: () => finishLine('good') }, '들렸어'));

    const reveal = h('button', {
      class: 'big',
      onclick: () => { audio.ctl.pause(); answer.hidden = false; rate.hidden = false; reveal.hidden = true; }
    }, '문장 보기');

    stage.append(
      h('button', { class: 'primary big', onclick: play }, '▶ 다시 듣기'),
      speed,
      reveal, answer, rate);
    play();
  }

  async function finishLine(result) {
    const item = queue.shift();
    if (result === 'again') {
      await applyPatch(item.card, wrongPatch(item.card));
      queue.push(item); // 이번 세션에서 다시 들려준다
    } else {
      done++;
      if (result === 'good') await applyPatch(item.card, correctNotePatch(item.card));
    }
    show();
  }

  function finish() {
    audio.ctl.pause();
    bar.firstChild.style.width = '100%';
    count.textContent = `${total} / ${total}`;
    stage.replaceChildren(
      h('div', { class: 'done' }, '🎧', h('p', null, '듣기 연습을 마쳤어요!')),
      h('button', { class: 'primary big', onclick: () => runListen(deckId, lines, opts) }, '처음부터 다시'),
      h('button', { onclick: () => render() }, '설정으로'),
      h('button', { onclick: () => go({ deckId }) }, '덱으로 돌아가기'));
  }

  show();
}
