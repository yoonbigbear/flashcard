// 일본어 처리: 스크립트 파싱, 단어 분리, 한글 발음 변환. DOM 에 의존하지 않는 순수 함수 위주.
//
// 토큰 {s, k, p}
//   s  표면형(원문 그대로. 토큰을 이어 붙이면 원문이 된다)
//   k  0 기호 | 1 조사 | 2 내용어(빈칸 후보) | 3 어미·보조 (앞 단어에 붙는 말)
//   p  발음(가타카나). 모르면 ''
const JP = (() => {
  const KUROMOJI_VER = '0.1.2';
  const KUROMOJI_BASE = `https://cdn.jsdelivr.net/npm/kuromoji@${KUROMOJI_VER}/`;

  const RE_JA = /[぀-ヿ㐀-鿿]/g;
  const RE_KO = /[가-힣]/g;
  const RE_HIRA_ONLY = /^[ぁ-ゟ]+$/;
  const RE_KANA_ONLY = /^[ぁ-ヿー]+$/;

  // ---------- 스크립트 파싱 ----------
  function langOf(s) {
    const j = (s.match(RE_JA) || []).length;
    const k = (s.match(RE_KO) || []).length;
    if (!j && !k) return null;
    return k > j ? 'ko' : 'ja';
  }

  // "A: 문장" 처럼 앞에 붙은 화자 표시를 분리한다.
  const SPEAKER_RE = /^\s*([^\s:：「『（(]{1,8})\s*[:：]\s*/;
  function splitSpeaker(line) {
    const m = line.match(SPEAKER_RE);
    if (!m) return { speaker: '', text: line.trim() };
    return { speaker: m[1], text: line.slice(m[0].length).trim() };
  }

  // 줄 앞의 시간 표시. 시간 뒤에 남은 글이 없으면 text 는 ''.
  const TIME_RE = /^\s*[\[(（]?\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*[\])）]?\s*/;
  function takeTime(line) {
    const m = line.match(TIME_RE);
    if (!m) return { time: null, text: line };
    const sec = (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
    return { time: sec, text: line.slice(m[0].length).trim() };
  }

  // "1:23" · "1:02:03" · "83" → 초. 비어 있으면 null, 잘못된 값이면 NaN.
  function parseTime(str) {
    const s = String(str || '').trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
    const m = s.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
    if (!m) return NaN;
    return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
  }
  function formatTime(sec) {
    if (!Number.isFinite(sec)) return '';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const pad = n => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
  }

  // 유튜브 주소(또는 11자리 영상 id) → 영상 id. 아니면 ''.
  function videoId(input) {
    const s = String(input || '').trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    const m = s.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/);
    return m ? m[1] : '';
  }

  // 반환: { items: [{speaker, front, back, read, start}], skipped }
  //  - 한 줄에 `일본어 | 뜻 | 발음(선택)` 또는 탭으로 구분한 형식
  //  - 또는 일본어 줄 다음 줄에 한국어 뜻(한국어가 먼저여도 된다)
  //  - 줄 앞(또는 단독 줄)에 시간(`1:23`, `[1:02:03]`)이 있으면 start(초)로 저장한다.
  //    유튜브 "스크립트 표시"를 그대로 복사해 붙여도 된다.
  function parseScript(text) {
    // 시간 추출: 시간만 있는 줄은 다음 줄의 시간이 된다.
    const entries = [];
    let pending = null;
    for (const raw of text.split(/\r?\n/)) {
      const { time, text: t } = takeTime(raw.trim());
      if (!raw.trim()) continue;
      if (!t) { pending = time; continue; }
      entries.push({ line: t, time: time ?? pending });
      pending = null;
    }

    const items = [];
    let skipped = 0;

    const pushPair = (parts, speaker, start) => {
      let [a, b, c] = parts;
      if (langOf(a) === 'ko' && langOf(b || '') !== 'ko') [a, b] = [b || '', a];
      if (!a || langOf(a) !== 'ja') { skipped++; return; }
      items.push({
        speaker, front: splitSpeaker(a).text, back: splitSpeaker(b || '').text, read: (c || '').trim(), start
      });
    };

    const sepOf = line => (line.includes('\t') ? '\t' : (line.includes('|') ? '|' : null));

    // 줄바꿈 형식: 처음 나온 언어를 "대표 언어"로 보고, 그 언어 줄마다 새 항목을 만든다.
    const lead = entries.filter(e => !sepOf(e.line)).map(e => langOf(e.line)).find(Boolean);
    let cur = null;
    const flush = () => {
      if (!cur) return;
      const ja = lead === 'ja' ? cur.lead : cur.other;
      const ko = lead === 'ja' ? cur.other : cur.lead;
      if (ja) items.push({ speaker: cur.speaker, front: ja, back: ko || '', read: '', start: cur.start });
      else skipped++;
      cur = null;
    };

    for (const { line, time } of entries) {
      const sep = sepOf(line);
      if (sep) {
        flush();
        const parts = line.split(sep).map(p => p.trim());
        const sp = splitSpeaker(parts[0]);
        parts[0] = sp.text;
        pushPair(parts, sp.speaker || splitSpeaker(parts[1] || '').speaker, time);
        continue;
      }
      const lang = langOf(line);
      if (!lang) { skipped++; continue; }
      const sp = splitSpeaker(line);
      const { speaker } = sp;
      // "A: 0:03 문장" 처럼 화자 뒤에 시간이 올 수도 있다.
      const after = takeTime(sp.text);
      const t = after.text;
      const at = time ?? after.time;
      if (lang === lead) {
        flush();
        cur = { speaker, lead: t, other: '', start: at };
      } else if (cur && !cur.other) {
        cur.other = t;
        if (!cur.speaker) cur.speaker = speaker;
      } else {
        skipped++;
      }
    }
    flush();
    return { items, skipped };
  }

  // ---------- 단어 분리 ----------
  const toKatakana = s => s.replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const toHiragana = s => s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));

  // 사전이 없을 때 쓰는 대체 분리기(Intl.Segmenter). 조사/어미는 목록으로 걸러낸다.
  const FUNCTION_WORDS = new Set([
    'は', 'が', 'を', 'に', 'で', 'と', 'も', 'の', 'へ', 'や', 'か', 'ね', 'よ', 'な', 'わ', 'ぞ', 'ぜ',
    'から', 'まで', 'より', 'ので', 'のに', 'けど', 'けれど', 'って', 'など', 'でも', 'しか', 'だけ',
    'です', 'ます', 'でし', 'まし', 'ませ', 'ません', 'ました', 'でした', 'でしょ', 'でしょう', 'ましょう',
    'だ', 'た', 'て', 'ない', 'たい', 'いま', 'した', 'たん', 'ご', 'ざ'
  ]);

  let segmenter;
  function rawSegments(text) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      segmenter ||= new Intl.Segmenter('ja', { granularity: 'word' });
      return [...segmenter.segment(text)].map(x => ({ s: x.segment, word: x.isWordLike }));
    }
    const parts = text.match(/[一-鿿]+|[぀-ゟ]+|[゠-ヿ]+|[A-Za-z0-9]+|[\s\S]/g) || [];
    return parts.map(s => ({ s, word: /[\p{L}\p{N}]/u.test(s) }));
  }

  function fallbackTokens(text) {
    return rawSegments(text).map(({ s, word }) => {
      if (!word) return { s, k: 0, p: '' };
      const hira = RE_HIRA_ONLY.test(s);
      const fn = FUNCTION_WORDS.has(s) || (hira && s.length === 1);
      return { s, k: fn ? 1 : 2, p: RE_KANA_ONLY.test(s) ? toKatakana(s) : '' };
    });
  }

  // ---------- 형태소 분석(kuromoji) ----------
  // 사전은 Web Worker 에서 불러오고 분석한다(화면이 얼지 않게).
  let loadPromise = null;
  let worker = null;
  let ready = false;
  let nextId = 1;
  const pending = new Map();

  // 처음 한 번만 사전(약 17MB)을 받는다. 이후에는 서비스워커 캐시를 쓴다.
  function load() {
    loadPromise ||= new Promise((resolve, reject) => {
      worker = new Worker('kuromoji-worker.js');
      worker.onmessage = e => {
        const m = e.data;
        if (m.type === 'init') {
          if (m.error) return reject(new Error(m.error));
          ready = true;
          resolve();
        } else if (m.type === 'tokenize') {
          pending.get(m.id)?.(m.result);
          pending.delete(m.id);
        }
      };
      worker.onerror = () => reject(new Error('일본어 사전을 불러오지 못했어요.'));
      worker.postMessage({ type: 'init', base: KUROMOJI_BASE });
    }).catch(e => { worker?.terminate(); worker = null; loadPromise = null; throw e; });
    return loadPromise;
  }

  // 사전이 로드돼 있으면 워커에서 분석하고, 아니면 대체 분리기를 쓴다.
  async function analyzeMany(texts) {
    if (!ready) return texts.map(s => fallbackTokens(s));
    const id = nextId++;
    const raw = await new Promise(resolve => {
      pending.set(id, resolve);
      worker.postMessage({ type: 'tokenize', id, texts });
    });
    return raw.map(mapTokens);
  }
  const analyzeAsync = async text => (await analyzeMany([text]))[0];

  // 동기 버전은 사전 없이 대체 분리기만 쓴다. 사전 분석이 필요하면 analyzeAsync/analyzeMany.
  const analyze = fallbackTokens;

  const SYMBOL = '記号';
  function mapTokens(list) {
    return list.map(t => {
      const s = t.surface_form;
      const pron = t.pronunciation && t.pronunciation !== '*' ? t.pronunciation
        : t.reading && t.reading !== '*' ? t.reading
        : (RE_KANA_ONLY.test(s) ? toKatakana(s) : '');
      if (t.pos === SYMBOL || !s.trim()) return { s, k: 0, p: '' };
      if (t.pos === '助詞') return { s, k: 1, p: pron };
      const attached = t.pos === '助動詞' || t.pos_detail_1 === '非自立' || t.pos_detail_1 === '接尾';
      const tiny = RE_HIRA_ONLY.test(s) && s.length === 1;
      return { s, k: attached ? 3 : (tiny ? 1 : 2), p: pron };
    });
  }

  // ---------- 가타카나 → 한글 ----------
  // 값이 배열이면 [어두, 어중]. (か행·た행은 어두에서 평음, 어중에서 격음으로 적는다)
  const BASE = {
    ア: '아', イ: '이', ウ: '우', エ: '에', オ: '오',
    カ: ['가', '카'], キ: ['기', '키'], ク: ['구', '쿠'], ケ: ['게', '케'], コ: ['고', '코'],
    サ: '사', シ: '시', ス: '스', セ: '세', ソ: '소',
    タ: ['다', '타'], チ: ['지', '치'], ツ: '쓰', テ: ['데', '테'], ト: ['도', '토'],
    ナ: '나', ニ: '니', ヌ: '누', ネ: '네', ノ: '노',
    ハ: '하', ヒ: '히', フ: '후', ヘ: '헤', ホ: '호',
    マ: '마', ミ: '미', ム: '무', メ: '메', モ: '모',
    ヤ: '야', ユ: '유', ヨ: '요',
    ラ: '라', リ: '리', ル: '루', レ: '레', ロ: '로',
    ワ: '와', ヲ: '오',
    ガ: '가', ギ: '기', グ: '구', ゲ: '게', ゴ: '고',
    ザ: '자', ジ: '지', ズ: '즈', ゼ: '제', ゾ: '조',
    ダ: '다', ヂ: '지', ヅ: '즈', デ: '데', ド: '도',
    バ: '바', ビ: '비', ブ: '부', ベ: '베', ボ: '보',
    パ: '파', ピ: '피', プ: '푸', ペ: '페', ポ: '포',
    ヴ: '부'
  };
  const COMBO = {
    キャ: ['갸', '캬'], キュ: ['규', '큐'], キョ: ['교', '쿄'],
    シャ: '샤', シュ: '슈', ショ: '쇼',
    チャ: '차', チュ: '추', チョ: '초',
    ニャ: '냐', ニュ: '뉴', ニョ: '뇨',
    ヒャ: '햐', ヒュ: '휴', ヒョ: '효',
    ミャ: '먀', ミュ: '뮤', ミョ: '묘',
    リャ: '랴', リュ: '류', リョ: '료',
    ギャ: '갸', ギュ: '규', ギョ: '교',
    ジャ: '자', ジュ: '주', ジョ: '조',
    ビャ: '뱌', ビュ: '뷰', ビョ: '뵤',
    ピャ: '퍄', ピュ: '퓨', ピョ: '표',
    ティ: '티', ディ: '디', トゥ: '투', ドゥ: '두', テュ: '튜', デュ: '듀',
    ファ: '파', フィ: '피', フェ: '페', フォ: '포', フュ: '퓨',
    ヴァ: '바', ヴィ: '비', ヴェ: '베', ヴォ: '보',
    ウィ: '위', ウェ: '웨', ウォ: '워',
    シェ: '셰', ジェ: '제', チェ: '체',
    ツァ: '차', ツィ: '치', ツェ: '체', ツォ: '초', イェ: '예'
  };
  // 위 표에 없는 "자음 + 작은 모음" 조합용: 앞 글자의 모음만 바꾼다.
  const SMALL_VOWEL = { ァ: 0, ィ: 20, ゥ: 13, ェ: 5, ォ: 8 };
  const FINAL_N = 4;   // ㄴ
  const FINAL_S = 19;  // ㅅ
  const SYMBOL_MAP = { '。': '.', '、': ',', '！': '!', '？': '?', '・': '·', '〜': '~', '～': '~' };

  const isSyllable = ch => !!ch && ch >= '가' && ch <= '힣';
  const hasFinal = ch => (ch.charCodeAt(0) - 0xac00) % 28 !== 0;
  const withFinal = (ch, fin) => String.fromCharCode(ch.charCodeAt(0) + fin);
  function withVowel(ch, vowel) {
    const n = ch.charCodeAt(0) - 0xac00;
    const initial = Math.floor(n / 588);
    const final = n % 28;
    return String.fromCharCode(0xac00 + (initial * 21 + vowel) * 28 + final);
  }

  // 직전 글자가 받침 없는 ㅗ·ㅛ·ㅜ·ㅠ 모음이면 뒤따르는 う 는 장음이다.
  function isLongU(out) {
    const last = out[out.length - 1];
    if (!isSyllable(last) || hasFinal(last)) return false;
    const vowel = Math.floor(((last.charCodeAt(0) - 0xac00) % 588) / 28);
    return vowel === 8 || vowel === 12 || vowel === 13 || vowel === 17;
  }

  // 한 어절(띄어쓰기 단위)의 가타카나/히라가나를 한글로 바꾼다. 장음(ー)은 적지 않는다.
  function kanaToHangul(src) {
    const s = toKatakana(src);
    let out = '';
    let atStart = true;
    const pick = v => (Array.isArray(v) ? (atStart ? v[0] : v[1]) : v);
    const addFinal = (fin, alone) => {
      const last = out[out.length - 1];
      if (isSyllable(last) && !hasFinal(last)) out = out.slice(0, -1) + withFinal(last, fin);
      else out += alone;
    };

    for (let i = 0; i < s.length;) {
      const ch = s[i];
      const two = s.slice(i, i + 2);
      if (COMBO[two] !== undefined) {
        out += pick(COMBO[two]); atStart = false; i += 2;
      } else if (BASE[ch] !== undefined) {
        let syl = pick(BASE[ch]);
        let adv = 1;
        const small = SMALL_VOWEL[s[i + 1]];
        if (small !== undefined) { syl = withVowel(syl, small); adv = 2; }
        out += syl; atStart = false; i += adv;
      } else if (ch === 'ッ') {
        addFinal(FINAL_S, ''); i++;
      } else if (ch === 'ン') {
        addFinal(FINAL_N, 'ㄴ'); i++;
      } else if (ch === 'ー') {
        i++;
      } else if (ch === 'ウ' && isLongU(out)) {
        i++; // おう·うう 처럼 히라가나로 적힌 장음
      } else {
        out += SYMBOL_MAP[ch] ?? ch;
        atStart = /\s/.test(ch);
        i++;
      }
    }
    return out;
  }

  // 토큰 목록 → 한글 발음 문장. 내용어마다 띄어 쓰고 조사·어미는 앞 단어에 붙인다.
  function hangulReading(tokens) {
    const words = [];
    let cur = '';
    const flush = () => { if (cur) words.push(kanaToHangul(cur)); cur = ''; };
    for (const t of tokens) {
      if (t.k === 0) {
        flush();
        const sym = SYMBOL_MAP[t.s] ?? t.s;
        if (/^\s*$/.test(sym)) continue;
        if (words.length && /^[.,!?·~]$/.test(sym)) words[words.length - 1] += sym;
        else words.push(sym);
        continue;
      }
      if (t.k === 2) flush();
      cur += t.p || t.s;
    }
    flush();
    return words.join(' ');
  }

  // ---------- 정답 비교 ----------
  const normalize = s => toHiragana(s.normalize('NFKC')).replace(/\s+/g, '').toLowerCase();
  const sameAnswer = (a, b) => normalize(a) === normalize(b);

  return {
    parseScript, parseTime, formatTime, videoId, analyze, analyzeAsync, analyzeMany, fallbackTokens, load, hangulReading, kanaToHangul, sameAnswer,
    isLoaded: () => ready
  };
})();
