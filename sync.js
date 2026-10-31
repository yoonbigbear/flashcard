// Firebase(Auth + Firestore) 동기화. FIREBASE_CONFIG 가 없으면 아무 것도 하지 않는다.
//
// 구조: 앱은 항상 로컬 저장소(Store)를 기준으로 동작하고,
//   - 로컬 변경 → Store.onLocalWrite 훅 → Firestore 에 기록
//   - Firestore 변경 → onSnapshot → Store.applyRemote 로 병합
// Firestore 자체 오프라인 캐시가 있어서 오프라인 중 쓴 내용은 온라인이 되면 올라간다.
// 데이터 위치: users/{uid}/decks/{id}, users/{uid}/cards/{id}
//
// 계정별로 데이터가 분리된다.
//   - 로그아웃(게스트): 소유자의 데이터를 읽기 전용으로 받아 보기만 한다. (오답노트 없음)
//   - 소유자 계정: 소유자 데이터를 편집한다.
//   - 그 밖의 구글 계정: users/{본인 uid} 의 본인 데이터를 편집한다. (소유자 데이터와 섞이지 않음)
// 로컬 저장소도 같은 기준으로 나뉜다(Store.setScope).
const cfg = window.FIREBASE_CONFIG;
const OWNER_UID = window.OWNER_UID;
const SDK_VERSION = '11.0.2';
const SDK = `https://www.gstatic.com/firebasejs/${SDK_VERSION}/`;
const COLLECTION = { deck: 'decks', card: 'cards' };

const GUEST_SCOPE = 'flashcard-guest-v1';
const scopeFor = user =>
  !user ? (OWNER_UID ? GUEST_SCOPE : Store.DEFAULT_SCOPE)
    : user.uid === OWNER_UID ? Store.DEFAULT_SCOPE
    : 'flashcard-user-' + user.uid;

// 처음 방문한 기기는 로그인 확인 전까지 게스트로 본다.
if (cfg && OWNER_UID && !Store.hasScopePointer()) Store.setScope(GUEST_SCOPE);

// readOnly: 로그인하지 않은 게스트일 때 true. (동기화 꺼짐 = 로컬 전용이라 false)
const state = {
  enabled: !!cfg, user: null, syncing: false, error: '',
  readOnly: !!cfg && !!OWNER_UID && localStorage.getItem('flashcard-scope-v1') === GUEST_SCOPE,
  isOwner: false
};
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

  // uid: 구독할 데이터의 주인. readOnly 면 내려받기만 하고 로컬 변경은 올리지 않는다.
  function begin(uid, readOnly) {
    currentUid = readOnly ? null : uid; // null 이면 onLocalWrite 가 아무것도 쓰지 않는다
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
            if (initial.deck && initial.card) {
              if (readOnly) { state.syncing = false; notify(); }
              else pushLocalDiff().catch(fail);
            }
          }
        },
        fail);
      unsubscribers.push(unsub);
    }
  }

  A.onAuthStateChanged(auth, user => {
    stop();
    state.user = user ? { name: user.displayName || '', email: user.email || '' } : null;
    state.isOwner = !!user && user.uid === OWNER_UID;
    state.readOnly = !user && !!OWNER_UID;
    state.syncing = false;
    Store.setScope(scopeFor(user)); // 계정에 맞는 로컬 데이터로 전환
    notify();
    // 로그인했으면 본인 데이터를 양방향 동기화, 게스트면 소유자 데이터를 읽기 전용으로 구독한다.
    if (user) begin(user.uid, false);
    else if (OWNER_UID) begin(OWNER_UID, true);
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

  // 링크 공유: 내용은 shares/{id} 에 두고 링크에는 짧은 id 만 넣는다. 읽기는 누구나, 만들기는 로그인한 사람만.
  const ID_CHARS = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  window.Sync.createShare = async json => {
    if (!auth.currentUser) throw new Error('login required');
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => ID_CHARS[b % ID_CHARS.length]).join('');
    await F.setDoc(F.doc(db, 'shares', id), { d: json, owner: auth.currentUser.uid, created: Date.now() });
    return id;
  };
  window.Sync.getShare = async id => {
    const snap = await F.getDoc(F.doc(db, 'shares', id));
    return snap.exists() ? snap.data().d : null;
  };
}
