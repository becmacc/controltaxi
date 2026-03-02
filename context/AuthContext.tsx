import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type IdTokenResult,
} from 'firebase/auth';
import { getApp, getApps, initializeApp } from 'firebase/app';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

type AuthRole = 'admin' | 'ops' | 'viewer' | 'unknown';

interface AuthContextType {
  status: AuthStatus;
  user: User | null;
  role: AuthRole;
  hasCoreAccess: boolean;
  isAuthConfigured: boolean;
  signIn: (email: string, password: string) => Promise<{ ok: boolean; reason?: string }>;
  signInWithGoogle: () => Promise<{ ok: boolean; reason?: string }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const isConfigured = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.authDomain &&
  firebaseConfig.projectId &&
  firebaseConfig.storageBucket &&
  firebaseConfig.messagingSenderId &&
  firebaseConfig.appId
);

const resolveRoleFromClaims = (tokenResult: IdTokenResult | null): AuthRole => {
  if (!tokenResult) return 'unknown';
  const claims = tokenResult.claims || {};

  const explicitRole = String(claims.role || '').trim().toLowerCase();
  if (explicitRole === 'admin' || explicitRole === 'ops' || explicitRole === 'viewer') {
    return explicitRole;
  }

  const roleSet = Array.isArray(claims.roles)
    ? claims.roles.map(value => String(value).trim().toLowerCase())
    : [];
  if (roleSet.includes('admin')) return 'admin';
  if (roleSet.includes('ops')) return 'ops';
  if (roleSet.includes('viewer')) return 'viewer';

  return 'unknown';
};

const hasCoreFromClaims = (tokenResult: IdTokenResult | null, role: AuthRole): boolean => {
  if (!tokenResult) return false;
  const claims = tokenResult.claims || {};

  if (claims.coreAccess === true) return true;
  if (role === 'admin' || role === 'ops') return true;

  const roleSet = Array.isArray(claims.roles)
    ? claims.roles.map(value => String(value).trim().toLowerCase())
    : [];

  return roleSet.includes('admin') || roleSet.includes('ops') || roleSet.includes('core');
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<AuthRole>('unknown');
  const [hasCoreAccess, setHasCoreAccess] = useState(false);

  useEffect(() => {
    if (!isConfigured) {
      setStatus('unauthenticated');
      setUser(null);
      setRole('unknown');
      setHasCoreAccess(false);
      return;
    }

    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    const auth = getAuth(app);

    const unsubscribe = onAuthStateChanged(auth, async nextUser => {
      if (!nextUser) {
        setUser(null);
        setRole('unknown');
        setHasCoreAccess(false);
        setStatus('unauthenticated');
        return;
      }

      try {
        const tokenResult = await nextUser.getIdTokenResult();
        const nextRole = resolveRoleFromClaims(tokenResult);
        const nextHasCoreAccess = hasCoreFromClaims(tokenResult, nextRole);

        setUser(nextUser);
        setRole(nextRole);
        setHasCoreAccess(nextHasCoreAccess);
        setStatus('authenticated');
      } catch {
        setUser(nextUser);
        setRole('unknown');
        setHasCoreAccess(false);
        setStatus('authenticated');
      }
    });

    return () => unsubscribe();
  }, []);

  const signIn: AuthContextType['signIn'] = async (email, password) => {
    if (!isConfigured) {
      return { ok: false, reason: 'Firebase auth is not configured in environment variables.' };
    }

    try {
      const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
      const auth = getAuth(app);
      await signInWithEmailAndPassword(auth, email.trim(), password);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to sign in.';
      return { ok: false, reason: message };
    }
  };

  const signInWithGoogle: AuthContextType['signInWithGoogle'] = async () => {
    if (!isConfigured) {
      return { ok: false, reason: 'Firebase auth is not configured in environment variables.' };
    }

    try {
      const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
      const auth = getAuth(app);
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to sign in with Google.';
      return { ok: false, reason: message };
    }
  };

  const signOut = async () => {
    if (!isConfigured) return;
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    const auth = getAuth(app);
    await firebaseSignOut(auth);
  };

  const value = useMemo<AuthContextType>(() => ({
    status,
    user,
    role,
    hasCoreAccess,
    isAuthConfigured: isConfigured,
    signIn,
    signInWithGoogle,
    signOut,
  }), [status, user, role, hasCoreAccess]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
