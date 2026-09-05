// Explicit exports keep unused Firebase products out of the browser bundle.
export { initializeApp } from 'firebase/app';
export { getAuth, onAuthStateChanged, signInWithPopup, signOut, GoogleAuthProvider } from 'firebase/auth';
export { Bytes, collection, doc, getDocFromServer, initializeFirestore, limit,
  onSnapshot, query, runTransaction, serverTimestamp, where, writeBatch } from 'firebase/firestore';
