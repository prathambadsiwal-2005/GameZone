import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth, signInAnonymously, signInWithEmailAndPassword, signOut } from 'firebase/auth';

const config = {
  apiKey: "AIzaSyCgMAcy8nvYnSJurbHY_CObIkFr4PyhyMA",
  authDomain: "gamezone-a22a0.firebaseapp.com",
  projectId: "gamezone-a22a0",
  storageBucket: "gamezone-a22a0.firebasestorage.app",
  messagingSenderId: "48112485918",
  appId: "1:48112485918:web:37b1e32dd5f5f5ec4e500f"
};

export const ADMIN_EMAIL = 'pbadsiwal2005@gmail.com';
export const ready = Object.values(config).every(v => v && !v.startsWith('PASTE_'));

let db = null;
let auth = null;
if (ready) {
  const app = initializeApp(config);
  db = getFirestore(app);
  auth = getAuth(app);
}

export { db, auth };

export async function connect() {
  if (!ready) return false;
  if (!auth.currentUser) await signInAnonymously(auth);
  return true;
}

export async function loginAdmin(email, password) {
  if (!ready) throw new Error('Firebase is not configured');
  if (email.toLowerCase() !== ADMIN_EMAIL) throw new Error('This email is not the configured admin account');
  return signInWithEmailAndPassword(auth, email, password);
}

export async function logoutAdmin() {
  if (!ready) return;
  await signOut(auth);
  await signInAnonymously(auth);
}
