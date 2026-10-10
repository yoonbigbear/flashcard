// Firebase(Auth + Firestore) 동기화. FIREBASE_CONFIG 가 없으면 아무 것도 하지 않는다.
//
// 구조: 앱은 항상 로컬 저장소(Store)를 기준으로 동작하고,
//   - 로컬 변경 → Store.onLocalWrite 훅 → Firestore 에 기록
//   - Firestore 변경 → onSnapshot → Store.applyRemote 로 병합
// Firestore 자체 오프라인 캐시가 있어서 오프라인 중 쓴 내용은 온라인이 되면 올라간다.
// 데이터 위치: users/{uid}/decks/{id}, users/{uid}/cards/{id}
const cfg = window.FIREBASE_CONFIG;
const SDK_VERSION = '11.0.2';
const SDK = `https://www.gstatic.com/firebasejs/${SDK_VERSION}/`;
const COLLECTION = { deck: 'decks', card: 'cards' };

const state = { enabled: !!cfg, user: null, syncing: false, error: '' };
const notify = () => window.dispatchEvent(new CustomEvent('sync-state'));

window.Sync = {
  state,
  signIn: async () => { throw new Error('동기화가 설정되지 않았어요.'); },
  signOut: async () => {}
};

if (cfg) {
  start().catch(e => {
    console.error(e);
    state.error = '동기화 모듈을 불러오지 못했어요. 인터넷 연결을 확인하세요.';
    notify();
  });
}

async function start() {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(SDK + 'firebase-app.js'),
    import(SDK + 'firebase-auth.js'),
    import(SDK + 'firebase-firestore.js')
  ]);

  const app = initializeApp(cfg);
  const auth = A.getAuth(app);

  let db;
  try {
    db = F.initializeFirestore(app, {
      localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() })
    });
  } catch (e) {
    db = F.getFirestore(app); // 오프라인 캐시를 못 쓰는 환경
  }

  let currentUid = null;
  let unsubscribers = [];

  const ref = (kind, id) => F.doc(db, 'users', currentUid, COLLECTION[kind], id);
  const plain = item => JSON.parse(JSON.stringify(item)); // undefined 제거
  const fail = e => {
    console.error(e);
    state.error = '동기화 오류: ' + (e.message || e);
    state.syncing = false;
    notify();
  };

  // 로컬 변경 → 클라우드
  Store.onLocalWrite(({ kind, op, item }) => {
    if (!currentUid) return;
    const r = ref(kind, item.id);
    (op === 'delete' ? F.deleteDoc(r) : F.setDoc(r, plain(item))).catch(fail);
  });

  function stop() {
    unsubscribers.forEach(fn => fn());
    unsubscribers = [];
    currentUid = null;
  }

  function begin(uid) {
    currentUid = uid;
    state.syncing = true;
    state.error = '';
    notify();

    const initial = { deck: null, card: null };

    // 첫 스냅샷이 양쪽 다 도착하면, 로컬에만 있거나 더 최신인 항목을 올린다.
    async function pushLocalDiff() {
      const snap = Store.snapshot();
      const writes = [];
      for (const kind of ['deck', 'card']) {
        for (const item of snap[kind === 'deck' ? 'decks' : 'cards']) {
          const remoteUpdated = initial[kind].get(item.id);
          if (remoteUpdated === undefined || (item.updated || 0) > remoteUpdated) {
            writes.push({ kind, item });
          }
        }
      }
      for (let i = 0; i < writes.length; i += 400) {
        const batch = F.writeBatch(db);
        writes.slice(i, i + 400).forEach(({ kind, item }) => batch.set(ref(kind, item.id), plain(item)));
        await batch.commit();
      }
      state.syncing = false;
      notify();
    }

    for (const kind of ['deck', 'card']) {
      const unsub = F.onSnapshot(
        F.collection(db, 'users', uid, COLLECTION[kind]),
        snap => {
          const changes = [];
          snap.docChanges().forEach(ch => {
            if (ch.doc.metadata.hasPendingWrites) return; // 내가 방금 쓴 것
            changes.push({
              kind,
              op: ch.type === 'removed' ? 'delete' : 'set',
              item: { ...ch.doc.data(), id: ch.doc.id }
            });
          });
          if (changes.length) Store.applyRemote(changes);

          if (initial[kind] === null) {
            initial[kind] = new Map(snap.docs.map(d => [d.id, d.data().updated || 0]));
            if (initial.deck && initial.card) pushLocalDiff().catch(fail);
          }
        },
        fail);
      unsubscribers.push(unsub);
    }
  }

  A.onAuthStateChanged(auth, user => {
    stop();
    state.user = user ? { name: user.displayName || '', email: user.email || '' } : null;
    state.syncing = false;
    notify();
    if (user) begin(user.uid);
  });

  window.Sync.signIn = async () => {
    state.error = '';
    try {
      await A.signInWithPopup(auth, new A.GoogleAuthProvider());
    } catch (e) {
      if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
      state.error = '로그인 실패: ' + (e.code || e.message);
      notify();
    }
  };
  window.Sync.signOut = () => A.signOut(auth);
}
