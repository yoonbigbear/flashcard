// AI 회화 연습 (Google Gemini). 브라우저에서 Gemini API 를 직접 호출한다.
//
// API 키는 이 기기의 localStorage 에만 저장한다. Store/동기화(Firestore)에는 절대 넣지 않는다.
// 대화 내용도 저장하지 않고 메모리에만 두며, 마음에 든 문장만 스크립트 덱에 줄로 저장한다.

const AI_KEY_STORE = 'flashcard-gemini-key';
const AI_MODEL_STORE = 'flashcard-gemini-model';
const AI_OPTS_STORE = 'flashcard-chat-opts';
const AI_MODELS = [
  ['gemini-3.5-flash-lite', '3.5 Flash-Lite (가볍고 빠름, 기본)'],
  ['gemini-3.1-flash-lite', '3.1 Flash-Lite'],
  ['gemini-3.6-flash', '3.6 Flash'],
  ['gemini-3.8-flash', '3.8 Flash (가장 똑똑함)']
];
const AI_SITUATIONS = [
  '카페에서 주문하기', '식당에서 주문하기', '길 묻기', '호텔 체크인', '쇼핑하기',
  '자기소개 / 처음 만난 사람과 대화', '병원·약국', '자유 대화'
];
const AI_LEVELS = [
  ['초급 (N5~N4): 짧고 쉬운 문장', '초급'],
  ['중급 (N3): 일상 회화', '중급'],
  ['상급 (N2~N1): 자연스러운 표현', '상급']
];

const Gemini = {
  key: () => localStorage.getItem(AI_KEY_STORE) || '',
  model: () => localStorage.getItem(AI_MODEL_STORE) || AI_MODELS[0][0],

  errorMessage(status, data) {
    const detail = data && data.error && data.error.message ? ` (${data.error.message.slice(0, 120)})` : '';
    if (status === 400 && /API key/i.test(detail)) return 'API 키가 올바르지 않아요. 설정에서 다시 확인하세요.';
    if (status === 400) return '요청이 거절됐어요.' + detail;
    if (status === 401 || status === 403) return 'API 키 권한에 문제가 있어요. 키가 맞는지, 사용 가능한 지역인지 확인하세요.' + detail;
    if (status === 404) return '모델을 찾을 수 없어요. 설정에서 다른 모델을 골라 보세요.';
    if (status === 429) return '무료 사용 한도에 걸렸어요. 잠시 뒤에 다시 하거나 설정에서 다른 모델을 고르세요.';
    if (status >= 500) return 'Gemini 서버가 바빠요. 잠시 뒤에 다시 시도하세요.';
    return `오류가 났어요 (${status})` + detail;
  },

  // contents: [{role: 'user'|'model', parts: [{text}]}]. 응답 텍스트를 돌려준다.
  async generate({ system, contents, json = true, temperature = 0.8 }) {
    const key = this.key();
    if (!key) throw new Error('설정 탭에서 Gemini API 키를 먼저 넣어 주세요.');
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
      + `${encodeURIComponent(this.model())}:generateContent?key=${encodeURIComponent(key)}`;
    const body = {
      contents,
      generationConfig: { temperature, ...(json ? { responseMimeType: 'application/json' } : {}) }
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    let res;
    try {
      res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
    } catch (e) {
      throw new Error('네트워크 오류예요. 인터넷 연결을 확인하세요.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(this.errorMessage(res.status, data));

    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content
      && data.candidates[0].content.parts) || [];
    const text = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();
    if (!text) throw new Error('답변이 비어 있어요. 다른 말로 다시 시도해 보세요.');
    return text;
  }
};

function loadChatOpts() {
  const base = { situation: AI_SITUATIONS[0], custom: '', level: '초급', read: true, meaning: true };
  try { return { ...base, ...JSON.parse(localStorage.getItem(AI_OPTS_STORE)) }; } catch (e) { return base; }
}
const saveChatOpts = o => localStorage.setItem(AI_OPTS_STORE, JSON.stringify(o));

function chatSystemPrompt(opts) {
  const situation = opts.situation === '직접 입력' ? (opts.custom || '자유 대화') : opts.situation;
  return [
    'You are a friendly Japanese conversation partner for a Korean learner.',
    `Situation: ${situation}. Learner level: ${opts.level}.`,
    'Play your role in the situation and keep the conversation going.',
    'Always reply in natural Japanese suited to the level: 1-3 short sentences, ending with a short question or prompt for the learner to answer.',
    'Output JSON only with these string fields:',
    '- reply: your Japanese reply.',
    '- read: Korean Hangul pronunciation of the reply, with spaces between words (e.g. "고레와 펜데스").',
    '- meaning: natural Korean translation of the reply.',
    '- correction: if the learner\'s last message contained a mistake or sounded unnatural, the corrected natural Japanese sentence; if it was fine, an empty string.',
    '  If the learner wrote in Korean, put the natural Japanese way to say it here.',
    '- explanation: one or two short sentences in Korean explaining the correction (or how to say it). Empty string if correction is empty.',
    'Never output anything outside the JSON.'
  ].join('\n');
}

// 지금 진행 중인 대화(탭을 오가도 유지, 새로고침하면 사라짐)
let chatSession = null;

function renderChat() {
  setHeader('AI 대화');
  if (!chatSession) return renderChatSetup();
  renderChatRoom();
}

function renderChatSetup() {
  const opts = loadChatOpts();
  const panel = h('section', { class: 'panel' }, h('h2', null, '어떤 상황으로 대화할까요?'));
  $view.append(panel);

  const field = (label, control) => h('label', { class: 'field' }, h('span', null, label), control);
  const situation = h('select', null,
    [...AI_SITUATIONS, '직접 입력'].map(s => h('option', { value: s }, s)));
  situation.value = opts.situation;
  const custom = h('input', { type: 'text', class: 'text-input', placeholder: '예: 공항에서 짐 찾기' });
  custom.value = opts.custom;
  const level = h('select', null, AI_LEVELS.map(([label, v]) => h('option', { value: v }, label)));
  level.value = opts.level;
  const read = h('input', { type: 'checkbox' });
  read.checked = opts.read;
  const meaning = h('input', { type: 'checkbox' });
  meaning.checked = opts.meaning;

  const syncCustom = () => { custom.hidden = situation.value !== '직접 입력'; };
  situation.addEventListener('change', syncCustom);
  syncCustom();

  panel.append(
    field('상황', situation), custom,
    field('수준', level),
    h('label', { class: 'check' }, read, '한글 발음 보기'),
    h('label', { class: 'check' }, meaning, '한국어 뜻 보기'),
    Gemini.key() ? null : h('p', { class: 'error' }, '설정 탭에서 Gemini API 키를 먼저 넣어 주세요.'),
    h('button', {
      class: 'primary big',
      onclick: () => {
        const next = {
          situation: situation.value, custom: custom.value.trim(), level: level.value,
          read: read.checked, meaning: meaning.checked
        };
        saveChatOpts(next);
        chatSession = { opts: next, turns: [], busy: false, target: null };
        renderChat();
        sendChat(null); // AI 가 먼저 말을 건다
      }
    }, '대화 시작'));
}

const speakJa = text => {
  if (!('speechSynthesis' in window)) return toast('이 브라우저는 음성을 지원하지 않아요');
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  u.rate = 0.9;
  window.speechSynthesis.speak(u);
};

function parseChatReply(text) {
  try {
    const o = JSON.parse(text);
    return {
      reply: String(o.reply || '').trim(), read: String(o.read || '').trim(),
      meaning: String(o.meaning || '').trim(), correction: String(o.correction || '').trim(),
      explanation: String(o.explanation || '').trim()
    };
  } catch (e) {
    return { reply: text, read: '', meaning: '', correction: '', explanation: '' };
  }
}

// text 가 null 이면 AI 가 먼저 대화를 시작한다.
async function sendChat(text) {
  const s = chatSession;
  if (!s || s.busy) return;
  if (text) s.turns.push({ who: 'me', text });
  s.busy = true;
  s.error = '';
  renderChatRoom();

  // 대화 기록 → API 형식 (최근 24개, 첫 항목은 user 여야 한다)
  let contents = [{ role: 'user', parts: [{ text: '会話を始めてください。' }] }];
  for (const t of s.turns) {
    contents.push(t.who === 'me'
      ? { role: 'user', parts: [{ text: t.text }] }
      : { role: 'model', parts: [{ text: t.raw }] });
  }
  contents = contents.slice(-24);
  while (contents.length && contents[0].role !== 'user') contents.shift();

  try {
    const raw = await Gemini.generate({ system: chatSystemPrompt(s.opts), contents });
    const r = parseChatReply(raw);
    // 교정은 방금 보낸 내 말 아래에 붙인다.
    const mine = [...s.turns].reverse().find(t => t.who === 'me');
    if (text && mine && r.correction) { mine.correction = r.correction; mine.explanation = r.explanation; }
    s.turns.push({ who: 'ai', raw, ...r });
  } catch (e) {
    s.error = e.message;
  }
  s.busy = false;
  if (chatSession === s && nav.tab === 'chat') renderChatRoom();
}

function renderChatRoom() {
  const s = chatSession;
  $view.replaceChildren();
  const log = h('div', { class: 'chat' });

  for (const t of s.turns) {
    if (t.who === 'me') {
      log.append(h('div', { class: 'bubble me' }, h('div', null, t.text)));
      if (t.correction) {
        log.append(h('div', { class: 'bubble fix' },
          h('div', { class: 'fix-title' }, '💡 이렇게 말하면 더 자연스러워요'),
          h('div', { class: 'fix-text' }, t.correction),
          t.explanation ? h('div', { class: 'script-meaning' }, t.explanation) : null,
          h('div', { class: 'row' },
            h('button', { onclick: () => speakJa(t.correction) }, '🔊'),
            isReadOnly() ? null : h('button', {
              onclick: () => saveChatLine({ front: t.correction, back: t.explanation, read: '', speaker: '나' })
            }, '저장'))));
      }
    } else {
      log.append(h('div', { class: 'bubble ai' },
        h('div', { class: 'ai-text' }, t.reply),
        t.read && s.opts.read ? h('div', { class: 'script-read' }, t.read) : null,
        t.meaning && s.opts.meaning ? h('div', { class: 'script-meaning' }, t.meaning) : null,
        h('div', { class: 'row' },
          h('button', { onclick: () => speakJa(t.reply) }, '🔊'),
          h('button', {
            onclick: e => {
              const b = e.target.closest('.bubble');
              b.querySelectorAll('.script-read, .script-meaning').forEach(el => { el.hidden = !el.hidden; });
            }
          }, '발음·뜻'),
          isReadOnly() ? null : h('button', {
            onclick: () => saveChatLine({ front: t.reply, back: t.meaning, read: t.read, speaker: 'AI' })
          }, '저장'))));
    }
  }
  if (s.busy) log.append(h('div', { class: 'bubble ai' }, '…'));
  if (s.error) {
    log.append(h('div', { class: 'bubble fix' }, h('div', { class: 'error' }, s.error),
      h('button', { onclick: () => retryChat() }, '다시 시도')));
  }

  const input = h('textarea', {
    rows: '2', placeholder: '일본어로 답해 보세요 (한국어로 써도 돼요)', lang: 'ja', disabled: s.busy
  });
  const send = () => {
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    sendChat(v);
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  $view.append(
    h('div', { class: 'row' },
      h('button', {
        onclick: () => {
          if (s.turns.length && !confirm('대화를 끝내고 새로 시작할까요?')) return;
          chatSession = null;
          renderChat();
        }
      }, '새 대화')),
    log,
    h('div', { class: 'chat-input' }, input,
      h('button', { class: 'primary', disabled: s.busy, onclick: send }, '보내기')));

  if (!s.busy) input.focus({ preventScroll: true });
  requestAnimationFrame(() => { $view.scrollTop = $view.scrollHeight; });
}

function retryChat() {
  const s = chatSession;
  if (!s) return;
  const last = s.turns[s.turns.length - 1];
  // 마지막이 내 말이면 그 말을 다시 보낸다. 대화 시작 실패였다면 처음부터 다시 요청한다.
  if (last && last.who === 'me') { s.turns.pop(); sendChat(last.text); } else sendChat(null);
}

// ---------- 스크립트 덱에 저장 ----------
async function saveChatLine(line) {
  const s = chatSession;
  if (!s.target) {
    const target = await pickScriptTarget(s.opts);
    if (!target) return;
    s.target = target;
  }
  const t = s.target;
  const tokens = JP.analyze(line.front);
  await Store.addCard(t.deckId, {
    type: 'basic', front: line.front, back: line.back || '', tags: [], reverse: false,
    script: t.scriptId, scriptName: t.scriptName, order: t.count++, speaker: line.speaker,
    video: '', start: null,
    read: line.read || (JP.isLoaded() ? JP.hangulReading(tokens) : ''),
    tokens
  });
  toast(`'${t.scriptName}' 에 저장했어요`);
}

// 저장할 스크립트 덱을 고르는 창. 취소하면 null.
function pickScriptTarget(opts) {
  return new Promise(async resolve => {
    const decks = await Store.listDecks();
    const all = await Store.listAllCards();
    const scriptDecks = decks.filter(d => isScriptDeck(d, all.filter(c => c.deckId === d.id)));

    const situation = opts.situation === '직접 입력' ? (opts.custom || '자유 대화') : opts.situation;
    const name = h('input', { type: 'text', class: 'text-input' });
    name.value = `AI 대화 · ${situation} · ${new Date().toLocaleDateString()}`;
    const deck = h('select', { 'aria-label': '저장할 덱' },
      scriptDecks.map(d => h('option', { value: d.id }, d.name)),
      h('option', { value: '' }, '+ 새 스크립트 덱 만들기 (AI 대화)'));

    let done = false;
    const finish = v => { if (done) return; done = true; dlg.close(); resolve(v); };
    const dlg = h('dialog', { class: 'dialog' },
      h('h2', null, '어디에 저장할까요?'),
      h('div', { class: 'card-fields' },
        h('label', { class: 'field' }, h('span', null, '스크립트 덱'), deck),
        h('label', { class: 'field' }, h('span', null, '스크립트 이름'), name)),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => finish(null) }, '취소'),
        h('button', {
          type: 'button', class: 'primary',
          onclick: async () => {
            let deckId = deck.value;
            if (!deckId) deckId = (await Store.addDeck('AI 대화', 'script')).id;
            finish({
              deckId, scriptId: 'ai' + Date.now().toString(36),
              scriptName: name.value.trim() || 'AI 대화', count: 0
            });
          }
        }, '저장')));
    dlg.addEventListener('close', () => { dlg.remove(); finish(null); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

// ---------- 설정: API 키 / 모델 ----------
function aiSettingsPanel() {
  const key = h('input', { type: 'password', class: 'text-input', placeholder: 'Gemini API 키', autocomplete: 'off' });
  key.value = Gemini.key();
  const model = h('select', null, AI_MODELS.map(([v, label]) => h('option', { value: v }, label)));
  model.value = Gemini.model();
  model.addEventListener('change', () => localStorage.setItem(AI_MODEL_STORE, model.value));

  return h('section', { class: 'panel' },
    h('h2', null, 'AI 대화 (Gemini)'),
    h('p', null, 'API 키는 이 기기의 브라우저에만 저장되고, 동기화나 백업에는 포함되지 않아요. '
      + '무료 등급에서는 보낸 내용이 Google의 서비스 개선에 쓰일 수 있어요.'),
    h('p', null, h('a', {
      href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener'
    }, 'Google AI Studio 에서 키 발급받기')),
    key,
    h('label', { class: 'field' }, h('span', null, '모델'), model),
    h('div', { class: 'row' },
      h('button', {
        class: 'primary',
        onclick: () => {
          const v = key.value.trim();
          if (v) localStorage.setItem(AI_KEY_STORE, v); else localStorage.removeItem(AI_KEY_STORE);
          toast(v ? '키를 저장했어요' : '키를 삭제했어요');
        }
      }, '저장'),
      h('button', {
        onclick: async e => {
          const v = key.value.trim();
          if (v) localStorage.setItem(AI_KEY_STORE, v);
          e.target.disabled = true;
          try {
            await Gemini.generate({
              contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }], json: false
            });
            toast('연결 성공!');
          } catch (err) {
            toast(err.message);
          }
          e.target.disabled = false;
        }
      }, '연결 테스트'),
      h('button', {
        class: 'danger',
        onclick: () => { localStorage.removeItem(AI_KEY_STORE); key.value = ''; toast('키를 삭제했어요'); }
      }, '삭제')));
}
