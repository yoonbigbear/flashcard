// 일본어 사전(kuromoji) 로딩과 형태소 분석을 화면과 다른 스레드에서 한다.
// 사전을 풀고 만드는 데 몇 초~몇십 초가 걸려서, 화면과 같은 스레드에서 하면 앱이 얼어붙는다.
self.window = self;
let tokenizer = null;

self.onmessage = e => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      importScripts(m.base + 'build/kuromoji.js');
    } catch (err) {
      self.postMessage({ type: 'init', error: '일본어 사전 스크립트를 불러오지 못했어요.' });
      return;
    }
    self.kuromoji.builder({ dicPath: m.base + 'dict/' }).build((err, t) => {
      if (err) return self.postMessage({ type: 'init', error: '일본어 사전을 불러오지 못했어요.' });
      tokenizer = t;
      self.postMessage({ type: 'init' });
    });
  } else if (m.type === 'tokenize') {
    self.postMessage({ type: 'tokenize', id: m.id, result: m.texts.map(s => tokenizer.tokenize(s)) });
  }
};
