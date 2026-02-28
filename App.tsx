
import React, { Suspense } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { CalculatorPage } from './pages/Calculator';
import { TripsPage } from './pages/Trips';
import { DriversPage } from './pages/Drivers';
import { SettingsPage } from './pages/Settings';
import { GMBriefPage } from './pages/GMBrief';
import { StoreProvider } from './context/StoreContext';

const CRMPage = React.lazy(() => import('./pages/CRM').then(module => ({ default: module.CRMPage })));

function App() {
  return (
    <StoreProvider>
      <HashRouter>
        <Layout>
          <Routes>
            <Route path="/brief" element={<GMBriefPage />} />
            <Route path="/" element={<CalculatorPage />} />
            <Route path="/trips" element={<TripsPage />} />
            <Route path="/drivers" element={<DriversPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route
              path="/crm"
              element={(
                <Suspense fallback={null}>
                  <CRMPage />
                </Suspense>
              )}
            />
            <Route path="*" element={<Navigate to="/brief" replace />} />
          </Routes>
        </Layout>
      </HashRouter>
    </StoreProvider>
  );
}

export default App;
