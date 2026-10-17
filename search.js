// 카드 검색: 한글·영어·일본어(히라가나/가타카나/한자)·로마자 어느 쪽으로 찾아도 관련 카드가 나오게 한다.
// DOM 에 의존하지 않는다. (japanese.js 가 먼저 로드돼 있어야 한다)
//
// 맞추는 방법
//   - 대소문자·전각/반각·띄어쓰기·구두점·히라가나/가타카나 차이를 무시한다.
//   - 로마자로 치면 히라가나로도 바꿔서 찾는다. (tabemasu → たべます)
//   - 일본어 카드는 읽기(가타카나)와 그 한글 발음도 함께 찾는다. (たべる ↔ 食べる ↔ 타베루)
//   - 단어를 여러 개 적으면(공백 구분) 모두 들어 있는 카드만 나온다.
const Search = (() => {
  const toHira = s => s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));

  // 비교용으로 정리: 전각→반각, 가타카나→히라가나, 소문자, 글자·숫자만 남긴다.
  const norm = s => toHira(String(s || '').normalize('NFKC'))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

  // ---------- 로마자 → 히라가나 ----------
  const ROMAJI = {
    a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お',
    ka: 'か', ki: 'き', ku: 'く', ke: 'け', ko: 'こ',
    sa: 'さ', si: 'し', shi: 'し', su: 'す', se: 'せ', so: 'そ',
    ta: 'た', ti: 'ち', chi: 'ち', tu: 'つ', tsu: 'つ', te: 'て', to: 'と',
    na: 'な', ni: 'に', nu: 'ぬ', ne: 'ね', no: 'の',
    ha: 'は', hi: 'ひ', hu: 'ふ', fu: 'ふ', he: 'へ', ho: 'ほ',
    ma: 'ま', mi: 'み', mu: 'む', me: 'め', mo: 'も',
    ya: 'や', yu: 'ゆ', yo: 'よ',
    ra: 'ら', ri: 'り', ru: 'る', re: 'れ', ro: 'ろ',
    wa: 'わ', wi: 'うぃ', we: 'うぇ', wo: 'を',
    ga: 'が', gi: 'ぎ', gu: 'ぐ', ge: 'げ', go: 'ご',
    za: 'ざ', zi: 'じ', ji: 'じ', zu: 'ず', ze: 'ぜ', zo: 'ぞ',
    da: 'だ', di: 'ぢ', du: 'づ', de: 'で', do: 'ど',
    ba: 'ば', bi: 'び', bu: 'ぶ', be: 'べ', bo: 'ぼ',
    pa: 'ぱ', pi: 'ぴ', pu: 'ぷ', pe: 'ぺ', po: 'ぽ',
    kya: 'きゃ', kyu: 'きゅ', kyo: 'きょ',
    sha: 'しゃ', shu: 'しゅ', sho: 'しょ', sya: 'しゃ', syu: 'しゅ', syo: 'しょ',
    cha: 'ちゃ', chu: 'ちゅ', cho: 'ちょ', tya: 'ちゃ', tyu: 'ちゅ', tyo: 'ちょ',
    nya: 'にゃ', nyu: 'にゅ', nyo: 'にょ',
    hya: 'ひゃ', hyu: 'ひゅ', hyo: 'ひょ',
    mya: 'みゃ', myu: 'みゅ', myo: 'みょ',
    rya: 'りゃ', ryu: 'りゅ', ryo: 'りょ',
    gya: 'ぎゃ', gyu: 'ぎゅ', gyo: 'ぎょ',
    ja: 'じゃ', ju: 'じゅ', jo: 'じょ', jya: 'じゃ', jyu: 'じゅ', jyo: 'じょ', zya: 'じゃ', zyu: 'じゅ', zyo: 'じょ',
    bya: 'びゃ', byu: 'びゅ', byo: 'びょ',
    pya: 'ぴゃ', pyu: 'ぴゅ', pyo: 'ぴょ',
    fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ',
    tsa: 'つぁ', che: 'ちぇ', she: 'しぇ', je: 'じぇ', thi: 'てぃ', dhi: 'でぃ',
    la: 'ぁ', li: 'ぃ', lu: 'ぅ', le: 'ぇ', lo: 'ぉ', xa: 'ぁ', xi: 'ぃ', xu: 'ぅ', xe: 'ぇ', xo: 'ぉ',
    xtu: 'っ', ltu: 'っ', xya: 'ゃ', xyu: 'ゅ', xyo: 'ょ'
  };
  const VOWEL = /[aiueo]/;

  // 알파벳이 아닌 글자는 그대로 둔다. 끝에서 아직 덜 쳐진 로마자(예: tab 의 b)는 남는다.
  function romajiToKana(input) {
    const s = String(input || '').toLowerCase();
    let out = '';
    for (let i = 0; i < s.length;) {
      const c = s[i], next = s[i + 1];
      if (!/[a-z]/.test(c)) { out += c === '-' ? 'ー' : c; i++; continue; }
      // 같은 자음 두 번 → 촉음 (kk → っk)
      if (next === c && !VOWEL.test(c) && c !== 'n') { out += 'っ'; i++; continue; }
      // n: 모음·y 가 따라오지 않으면 ん
      if (c === 'n') {
        if (next === 'n' || next === "'") { out += 'ん'; i += 2; continue; }
        if (next && !VOWEL.test(next) && next !== 'y') { out += 'ん'; i++; continue; }
      }
      let hit = false;
      for (let len = 3; len >= 1; len--) {
        const kana = ROMAJI[s.slice(i, i + len)];
        if (kana) { out += kana; i += len; hit = true; break; }
      }
      if (!hit) { out += c; i++; }
    }
    return out;
  }

  // ---------- 카드별 검색 대상 글 ----------
  // 읽기(가타카나). 단어 분리 결과가 있으면 그것을, 없고 일본어 사전이 로드돼 있으면 새로 분석한다.
  const readingCache = new Map();
  function readingOf(card) {
    if (Array.isArray(card.tokens) && card.tokens.length) return card.tokens.map(t => t.p || t.s).join('');
    if (!JP.isLoaded() || !/[぀-ヿ㐀-鿿]/.test(card.front)) return '';
    const hit = readingCache.get(card.front);
    if (hit !== undefined) return hit;
    const r = JP.analyze(card.front).map(t => t.p || t.s).join('');
    readingCache.set(card.front, r);
    return r;
  }

  function haystack(card, deckName) {
    const reading = readingOf(card);
    const kana = [reading, card.pronJa].filter(Boolean).join(' ');
    return norm([
      card.front, card.back, card.pronJa, card.pronKo, card.example, card.read, card.speaker,
      card.scriptName, deckName, (card.tags || []).join(' '),
      reading,
      kana ? JP.kanaToHangul(kana) : ''   // 가나 읽기의 한글 발음 (한글로 쳐도 일본어 카드가 나온다)
    ].filter(Boolean).join(' '));
  }

  // 검색어 한 단어 → 맞춰 볼 후보들
  function variants(term) {
    const list = new Set([norm(term)]);
    if (/[a-z]/i.test(term)) {
      // 로마자 → 가나. 끝에 덜 쳐진 글자 하나는 떼고 맞춘다. (taber → たべ)
      // 그보다 많이 남으면 로마자가 아닌 영어 단어이므로(dog → ど) 가나로는 찾지 않는다.
      const full = norm(romajiToKana(term));
      const kana = full.replace(/[a-z]$/, '');
      if (kana && !/[a-z]/.test(kana) && (kana === full || kana.length >= 2)) list.add(kana);
    }
    list.delete('');
    return [...list];
  }

  // query 가 비어 있으면 모두 맞는 것으로 본다.
  function compile(query) {
    const groups = String(query || '').split(/\s+/).filter(Boolean).map(variants).filter(v => v.length);
    return {
      empty: !groups.length,
      test: hay => groups.every(vs => vs.some(v => hay.includes(v)))
    };
  }

  // cards 중 query 에 맞는 것만. deckNames: Map(deckId → 덱 이름) (선택)
  function filter(cards, query, deckNames) {
    const q = compile(query);
    if (q.empty) return cards;
    return cards.filter(c => q.test(haystack(c, deckNames && deckNames.get(c.deckId))));
  }

  return { filter, norm, romajiToKana };
})();
