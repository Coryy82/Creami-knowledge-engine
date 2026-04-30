import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '@/firebase-applet-config.json';
import { OperationType, FirestoreErrorInfo } from '../types';

const app = initializeApp(firebaseConfig);
const databaseId = firebaseConfig.firestoreDatabaseId;
export const db = databaseId && databaseId !== '(default)'
  ? getFirestore(app, databaseId)
  : getFirestore(app);

// Optional connectivity check for local debugging only.
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'users', 'local-user'));
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        '[Firebase] Firestore connectivity check failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
if (process.env.NODE_ENV !== 'production' && process.env.VITE_FIREBASE_DEBUG_CONNECTION === 'true') {
  void testConnection();
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: 'local-user',
      email: null,
      emailVerified: null,
      isAnonymous: true,
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}
