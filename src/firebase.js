import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';

const config = {
  apiKey: "AIzaSyCgMAcy8nvYnSJurbHY_CObIkFr4PyhyMA",
  authDomain: "gamezone-a22a0.firebaseapp.com",
  projectId: "gamezone-a22a0",
  storageBucket: "gamezone-a22a0.firebasestorage.app",
  messagingSenderId: "48112485918",
  appId: "1:48112485918:web:37b1e32dd5f5f5ec4e500f"
};

export const ready = Object.values(config).every(
  v => v && !v.startsWith('PASTE_')
);

let db = null;
let auth = null;

if (ready) {
  const app = initializeApp(config);
  db = getFirestore(app);
  auth = getAuth(app);
}

export { db };

export async function connect() {
  if (!ready) return false;
  if (!auth.currentUser) {
    await signInAnonymously(auth);
  }
  return true;
}