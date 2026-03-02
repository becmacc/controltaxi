
import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { HashRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { StoreProvider } from './context/StoreContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { getApp, getApps, initializeApp } from 'firebase/app';
import { doc, getDoc, getFirestore, serverTimestamp, setDoc } from 'firebase/firestore';

const CalculatorPage = React.lazy(() => import('./pages/Calculator').then(module => ({ default: module.CalculatorPage })));
const TripsPage = React.lazy(() => import('./pages/Trips').then(module => ({ default: module.TripsPage })));
const DriversPage = React.lazy(() => import('./pages/Drivers').then(module => ({ default: module.DriversPage })));
const SettingsPage = React.lazy(() => import('./pages/Settings').then(module => ({ default: module.SettingsPage })));
const GMBriefPage = React.lazy(() => import('./pages/GMBrief').then(module => ({ default: module.GMBriefPage })));
const MissionWatchPage = React.lazy(() => import('./pages/MissionWatch').then(module => ({ default: module.MissionWatchPage })));
const CRMPage = React.lazy(() => import('./pages/CRM').then(module => ({ default: module.CRMPage })));
const LoginPage = React.lazy(() => import('./pages/Login').then(module => ({ default: module.LoginPage })));

const RouteFallback: React.FC = () => (
  <div className="h-full min-h-screen flex items-center justify-center text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
    Loading…
  </div>
);

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.authDomain &&
  firebaseConfig.projectId &&
  firebaseConfig.storageBucket &&
  firebaseConfig.messagingSenderId &&
  firebaseConfig.appId
);

const AccessBlocked: React.FC<{ uid?: string | null; email?: string | null; displayName?: string | null; onSignOut: () => void }> = ({ uid, email, displayName, onSignOut }) => {
  const [requestStatus, setRequestStatus] = useState<'idle' | 'pending' | 'approved' | 'rejected'>('idle');
  const [requestFeedback, setRequestFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);

  const firestore = useMemo(() => {
    if (!isFirebaseConfigured) return null;
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    return getFirestore(app);
  }, []);

  useEffect(() => {
    if (!firestore || !uid) return;
    let cancelled = false;

    const loadRequestState = async () => {
      try {
        const requestRef = doc(firestore, 'access_requests', uid);
        const snapshot = await getDoc(requestRef);
        if (cancelled) return;
        if (!snapshot.exists()) {
          setRequestStatus('idle');
          return;
        }
        const status = String((snapshot.data() as { status?: unknown }).status || '').trim().toLowerCase();
        if (status === 'pending' || status === 'approved' || status === 'rejected') {
          setRequestStatus(status);
        } else {
          setRequestStatus('idle');
        }
      } catch {
        if (!cancelled) {
          setRequestFeedback('Could not load request status.');
        }
      }
    };

    void loadRequestState();

    return () => {
      cancelled = true;
    };
  }, [firestore, uid]);

  const handleRequestAccess = async () => {
    if (!firestore || !uid) return;

    setSubmitting(true);
    setRequestFeedback('');

    try {
      await setDoc(
        doc(firestore, 'access_requests', uid),
        {
          uid,
          email: email || '',
          displayName: displayName || '',
          status: 'pending',
          requestedAt: serverTimestamp(),
          requestedAtMs: Date.now(),
          lastUpdatedAt: serverTimestamp(),
          lastUpdatedAtMs: Date.now(),
        },
        { merge: true }
      );
      setRequestStatus('pending');
      setRequestFeedback('Access request submitted. An admin must approve your account.');
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Failed to submit access request.';
      setRequestFeedback(reason);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCheckApprovalAgain = async () => {
    if (!firestore || !uid) return;

    setCheckingStatus(true);
    setRequestFeedback('');

    try {
      const [requestSnapshot, allowedSnapshot] = await Promise.all([
        getDoc(doc(firestore, 'access_requests', uid)),
        getDoc(doc(firestore, 'allowed_users', uid)),
      ]);

      if (requestSnapshot.exists()) {
        const status = String((requestSnapshot.data() as { status?: unknown }).status || '').trim().toLowerCase();
        if (status === 'pending' || status === 'approved' || status === 'rejected') {
          setRequestStatus(status);
        }
      }

      const isApprovedNow = allowedSnapshot.exists() && (allowedSnapshot.data() as { enabled?: unknown }).enabled === true;
      if (isApprovedNow) {
        setRequestStatus('approved');
        setRequestFeedback('Approval found. Please sign out and sign in again to continue.');
      } else if (!requestSnapshot.exists()) {
        setRequestStatus('idle');
        setRequestFeedback('No approval yet. You can request access below.');
      } else {
        setRequestFeedback('Still waiting for admin review. Check again later.');
      }
    } catch {
      setRequestFeedback('Could not check approval status. Try again.');
    } finally {
      setCheckingStatus(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-brand-950 text-slate-900 dark:text-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-3xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-900 shadow-2xl p-6 md:p-8 space-y-4">
        <h1 className="text-lg font-black uppercase tracking-tight">Access Not Approved</h1>
        <p className="text-[10px] font-bold text-slate-500 dark:text-slate-300">This Google account is not approved yet.</p>
        <p className="text-[10px] font-bold text-slate-500 dark:text-slate-300">OPS users get control-side access. Admin users get Core access (CRM + Settings).</p>
        {email ? (
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">Signed in as: {email}</p>
        ) : null}

        {requestStatus === 'pending' ? (
          <div className="rounded-xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-300">Request Pending Approval</p>
          </div>
        ) : requestStatus === 'approved' ? (
          <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300">Request Approved. Sign out and sign in again.</p>
          </div>
        ) : requestStatus === 'rejected' ? (
          <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-red-700 dark:text-red-300">Request Rejected</p>
          </div>
        ) : null}

        {requestFeedback ? (
          <p className="text-[10px] font-bold text-slate-500 dark:text-slate-300">{requestFeedback}</p>
        ) : null}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            onClick={handleRequestAccess}
            disabled={submitting || requestStatus === 'pending'}
            className="w-full h-10 rounded-xl border border-gold-500/30 bg-brand-900 text-gold-300 text-[10px] font-black uppercase tracking-[0.2em] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? 'Submitting...' : requestStatus === 'pending' ? 'Requested' : 'Request Access'}
          </button>

          <button
            type="button"
            onClick={handleCheckApprovalAgain}
            disabled={checkingStatus}
            className="w-full h-10 rounded-xl border border-blue-300 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 text-[10px] font-black uppercase tracking-[0.2em] text-blue-700 dark:text-blue-300 disabled:opacity-60"
          >
            {checkingStatus ? 'Checking...' : 'Check Again'}
          </button>

          <button
            type="button"
            onClick={onSignOut}
            className="w-full h-10 rounded-xl border border-slate-300 dark:border-white/15 bg-white dark:bg-brand-950 text-[10px] font-black uppercase tracking-[0.2em]"
          >
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
};

const AuthGate: React.FC<{ requireCore?: boolean }> = ({ requireCore = false }) => {
  const { status, isApproved, hasCoreAccess, user, signOut } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <RouteFallback />;
  }

  if (status !== 'authenticated') {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (!isApproved) {
    return <AccessBlocked uid={user?.uid} email={user?.email} displayName={user?.displayName} onSignOut={() => { void signOut(); }} />;
  }

  if (requireCore && !hasCoreAccess) {
    return <Navigate to="/brief" replace />;
  }

  return <Outlet />;
};

const AppShell: React.FC = () => (
  <Layout>
    <Outlet />
  </Layout>
);

function App() {
  return (
    <AuthProvider>
      <StoreProvider>
        <HashRouter>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />

              <Route element={<AuthGate />}>
                <Route element={<AppShell />}>
                  <Route path="/brief" element={<GMBriefPage />} />
                  <Route path="/" element={<CalculatorPage />} />
                  <Route path="/trips" element={<TripsPage />} />
                  <Route path="/drivers" element={<DriversPage />} />
                  <Route path="/watch" element={<MissionWatchPage />} />
                </Route>

                <Route element={<AuthGate requireCore />}>
                  <Route element={<AppShell />}>
                    <Route path="/crm" element={<CRMPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                  </Route>
                </Route>
              </Route>

              <Route path="*" element={<Navigate to="/brief" replace />} />
            </Routes>
          </Suspense>
        </HashRouter>
      </StoreProvider>
    </AuthProvider>
  );
}

export default App;
