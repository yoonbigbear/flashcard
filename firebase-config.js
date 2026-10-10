// Firebase 콘솔의 "프로젝트 설정 → 내 앱 → SDK 설정 및 구성"에서 복사한 값.
// 이 값은 비밀이 아니다. 데이터 보호는 firestore.rules 가 담당한다.
// null 로 두면 클라우드 동기화 없이 이 기기에서만 동작한다.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyA53q4kSlSHDp4WzRZu1li4N5P8aJzBoo8",
  authDomain: "flashcard-1476f.firebaseapp.com",
  projectId: "flashcard-1476f",
  storageBucket: "flashcard-1476f.firebasestorage.app",
  messagingSenderId: "39962087064",
  appId: "1:39962087064:web:ef2e0ed11f70c54d490aed"
};

// 편집 권한이 있는 소유자의 uid. 다른 사람(게스트)은 이 사람의 카드를 읽기 전용으로 본다.
// firestore.rules 의 uid 와 같아야 한다.
window.OWNER_UID = "BZ9tnw3zjtc7Jh75G1SBOBR8ckM2";
