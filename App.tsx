
import React, { Suspense } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { StoreProvider } from './context/StoreContext';

const CalculatorPage = React.lazy(() => import('./pages/Calculator').then(module => ({ default: module.CalculatorPage })));
const TripsPage = React.lazy(() => import('./pages/Trips').then(module => ({ default: module.TripsPage })));
const DriversPage = React.lazy(() => import('./pages/Drivers').then(module => ({ default: module.DriversPage })));
const SettingsPage = React.lazy(() => import('./pages/Settings').then(module => ({ default: module.SettingsPage })));
const GMBriefPage = React.lazy(() => import('./pages/GMBrief').then(module => ({ default: module.GMBriefPage })));
const MissionWatchPage = React.lazy(() => import('./pages/MissionWatch').then(module => ({ default: module.MissionWatchPage })));
const CRMPage = React.lazy(() => import('./pages/CRM').then(module => ({ default: module.CRMPage })));

const RouteFallback: React.FC = () => (
  <div className="h-full min-h-screen flex items-center justify-center text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
    Loading…
  </div>
);

function App() {
  return (
    <StoreProvider>
      <HashRouter>
        <Layout>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/brief" element={<GMBriefPage />} />
              <Route path="/" element={<CalculatorPage />} />
              <Route path="/trips" element={<TripsPage />} />
              <Route path="/drivers" element={<DriversPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/watch" element={<MissionWatchPage />} />
              <Route path="/crm" element={<CRMPage />} />
              <Route path="*" element={<Navigate to="/brief" replace />} />
            </Routes>
          </Suspense>
        </Layout>
      </HashRouter>
    </StoreProvider>
  );
}

export default App;
