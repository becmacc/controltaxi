import React, { useMemo, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ShieldCheck, Loader2, LogIn } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export const LoginPage: React.FC = () => {
  const { status, signIn, signInWithGoogle, isAuthConfigured } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const redirectTarget = useMemo(() => {
    const state = location.state as { from?: { pathname?: string } } | null;
    return state?.from?.pathname || '/brief';
  }, [location.state]);

  if (status === 'authenticated') {
    return <Navigate to={redirectTarget} replace />;
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);

    const result = await signIn(email, password);
    setSubmitting(false);

    if (!result.ok) {
      setError(result.reason || 'Sign in failed.');
      return;
    }
  };

  const handleGoogleSignIn = async () => {
    setError('');
    setSubmitting(true);

    const result = await signInWithGoogle();
    setSubmitting(false);

    if (!result.ok) {
      setError(result.reason || 'Google sign in failed.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-brand-950 text-slate-900 dark:text-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-3xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-900 shadow-2xl p-6 md:p-8 space-y-6">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-brand-900 text-gold-400 inline-flex items-center justify-center">
            <ShieldCheck size={20} />
          </div>
          <div>
            <h1 className="text-lg font-black uppercase tracking-tight">Control Access</h1>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">Operator Authentication</p>
          </div>
        </div>

        {!isAuthConfigured ? (
          <div className="rounded-xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-300">Firebase auth is not configured.</p>
            <p className="mt-2 text-[10px] font-bold text-amber-700/90 dark:text-amber-300/90">Add Firebase env values, enable Email/Password in Firebase Auth, then reload.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Email</label>
              <input
                type="email"
                value={email}
                onChange={event => setEmail(event.target.value)}
                autoComplete="email"
                required
                className="w-full h-11 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-3 text-sm font-bold outline-none focus:ring-2 focus:ring-brand-900/30 dark:focus:ring-emerald-500/30"
                placeholder="operator@company.com"
              />
            </div>

            <div>
              <label className="block text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                autoComplete="current-password"
                required
                className="w-full h-11 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-3 text-sm font-bold outline-none focus:ring-2 focus:ring-brand-900/30 dark:focus:ring-emerald-500/30"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 px-3 py-2">
                <p className="text-[10px] font-black uppercase tracking-widest text-red-700 dark:text-red-300">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full h-11 rounded-xl border border-gold-500/30 bg-brand-900 text-gold-300 text-[10px] font-black uppercase tracking-[0.2em] inline-flex items-center justify-center disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? <Loader2 size={14} className="animate-spin mr-2" /> : <LogIn size={14} className="mr-2" />}
              Sign In
            </button>

            <button
              type="button"
              disabled={submitting}
              onClick={handleGoogleSignIn}
              className="w-full h-11 rounded-xl border border-slate-300 dark:border-white/15 bg-white dark:bg-brand-950 text-slate-700 dark:text-slate-100 text-[10px] font-black uppercase tracking-[0.2em] inline-flex items-center justify-center disabled:opacity-60 disabled:cursor-not-allowed"
            >
              Continue with Google
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
