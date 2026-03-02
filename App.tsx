
import React, { Suspense } from 'react';
import { HashRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { StoreProvider } from './context/StoreContext';
import { AuthProvider, useAuth } from './context/AuthContext';

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

const AuthGate: React.FC<{ requireCore?: boolean }> = ({ requireCore = false }) => {
  const { status, hasCoreAccess } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <RouteFallback />;
  }

  if (status !== 'authenticated') {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (requireCore && !hasCoreAccess) {
    return <Navigate to="/crm" replace />;
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
                  <Route path="/crm" element={<CRMPage />} />
                </Route>

                <Route element={<AuthGate requireCore />}>
                  <Route element={<AppShell />}>
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
