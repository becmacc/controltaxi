
import React, { useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { 
  Car, List, Settings as SettingsIcon, Users, Moon, Sun, 
  BrainCircuit, ShieldCheck, Zap, Radar, Bell, X, 
  Clock, CheckCircle, AlertCircle, Phone, MessageCircle
} from 'lucide-react';
import { useStore } from '../context/StoreContext';
import { format, differenceInMinutes, parseISO } from 'date-fns';
import { buildWhatsAppLink, normalizePhoneForWhatsApp } from '../services/whatsapp';

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { theme, toggleTheme, alerts, trips, drivers, snoozeAlert, resolveAlert } = useStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [showWatch, setShowWatch] = useState(false);

  const isIntelligenceMode = location.pathname === '/crm';
  const activeAlerts = alerts
    .filter(a => {
      if (a.triggered) return false;
      if (!a.snoozedUntil) return true;
      const snoozedUntilMs = new Date(a.snoozedUntil).getTime();
      if (!Number.isFinite(snoozedUntilMs)) return true;
      return snoozedUntilMs <= Date.now();
    })
    .sort((a, b) => new Date(a.targetTime).getTime() - new Date(b.targetTime).getTime());

  const handleLogoDoubleClick = () => {
    navigate(isIntelligenceMode ? '/brief' : '/crm');
  };

  const linkClass = ({ isActive }: { isActive: boolean }) => 
    `flex flex-col items-center justify-center w-full py-2.5 text-[9px] font-black uppercase tracking-tighter transition-all ${
      isActive 
        ? 'text-brand-900 bg-gold-50 border-t-2 border-gold-600 dark:bg-brand-900/40 dark:text-gold-400 dark:border-gold-500' 
        : 'text-gray-500 hover:text-brand-700 hover:bg-gray-50 dark:text-slate-400 dark:hover:bg-brand-900/50'
    }`;

  const sidebarLinkClass = ({ isActive }: { isActive: boolean }) => 
    `flex items-center lg:space-x-3 p-3 lg:px-4 lg:py-3 rounded-xl transition-all justify-center lg:justify-start ${
      isActive 
        ? 'bg-brand-900 text-gold-400 shadow-md dark:bg-gold-600 dark:text-brand-950' 
        : 'text-gray-600 hover:bg-white hover:shadow-sm dark:text-slate-300 dark:hover:bg-brand-800 dark:hover:shadow-lg'
    }`;

  return (
    <div className={`app-shell flex flex-col h-dvh transition-colors duration-500 overflow-hidden bg-slate-50 dark:bg-brand-950 text-slate-900 dark:text-slate-100`}>
      {/* Header */}
      <header className={`app-header border-b px-4 py-3 flex items-center justify-between sticky top-0 z-40 shadow-lg h-14 flex-shrink-0 transition-all duration-500 ${isIntelligenceMode ? 'bg-white dark:bg-brand-950 border-slate-200 dark:border-white/5' : 'bg-brand-900 dark:bg-brand-900 border-brand-800'}`}>
        <div className="flex items-center space-x-3">
          <div 
            onDoubleClick={handleLogoDoubleClick}
            className={`p-1.5 rounded shadow-sm cursor-pointer hover:scale-110 active:scale-95 transition-all select-none ${isIntelligenceMode ? 'bg-brand-900 text-gold-400 dark:bg-white dark:text-black dark:ring-4 dark:ring-white/10' : 'bg-gold-600 text-brand-900'}`}
            title="Double-click for Operations"
          >
            {isIntelligenceMode ? <ShieldCheck size={20} /> : <Car size={20} />}
          </div>
          <h1 className={`text-xl font-black tracking-tight transition-colors ${isIntelligenceMode ? 'text-brand-900 dark:text-white' : 'text-white'}`}>
            <span className={isIntelligenceMode ? 'text-gold-600 dark:text-white/60' : 'text-gold-400'}>{isIntelligenceMode ? 'Core' : 'Control'}</span>
          </h1>
        </div>
        
        <div className="flex items-center space-x-3">
          {/* Mission Watch Trigger */}
          <button 
            onClick={() => setShowWatch(!showWatch)}
            className={`relative p-2 rounded-full transition-all ${activeAlerts.length > 0 ? 'text-gold-400 bg-brand-800' : 'text-slate-500'}`}
          >
            <Radar size={18} className={activeAlerts.length > 0 ? 'animate-spin' : ''} style={{ animationDuration: '4s' }} />
            {activeAlerts.length > 0 && (
              <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[8px] font-black w-4 h-4 rounded-full flex items-center justify-center border-2 border-brand-900">
                {activeAlerts.length}
              </span>
            )}
          </button>

          {isIntelligenceMode ? (
            <div className="flex items-center space-x-4">
               <div className={`hidden sm:flex items-center space-x-2 text-[10px] font-black px-3 py-1 rounded-full border transition-all animate-pulse ${theme === 'dark' ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20' : 'text-brand-900 bg-brand-50 border-brand-100'}`}>
                 <div className={`w-1.5 h-1.5 rounded-full ${theme === 'dark' ? 'bg-emerald-500' : 'bg-brand-900'}`} />
                 <span>LIVE TELEMETRY</span>
               </div>
               <button 
                 onClick={toggleTheme}
                 className="p-1.5 rounded-full hover:bg-slate-100 dark:hover:bg-brand-800 text-slate-400 dark:text-gold-400 transition-colors"
               >
                 {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
               </button>
            </div>
          ) : (
            <>
              <button 
                onClick={toggleTheme}
                className="p-1.5 rounded-full hover:bg-brand-800 text-gold-400 transition-colors focus:outline-none ring-1 ring-brand-700/50"
              >
                {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
              </button>
              <div className="text-[10px] font-black text-gold-600 tracking-[0.2em] bg-brand-800/50 px-3 py-1 rounded-full border border-brand-700 hidden sm:block uppercase backdrop-blur-sm">INTERNAL</div>
            </>
          )}
        </div>
      </header>

      {/* Mission Watch Sidebar */}
      {showWatch && (
        <div className="fixed top-14 right-0 bottom-0 w-full sm:w-80 bg-white dark:bg-brand-900 border-l border-slate-200 dark:border-brand-800 shadow-2xl z-50 flex flex-col animate-in slide-in-from-right duration-300">
           <div className="p-6 border-b border-slate-100 dark:border-white/5 flex justify-between items-center bg-slate-50 dark:bg-brand-950">
              <div>
                <h3 className="text-xs font-black uppercase tracking-[0.3em] text-brand-900 dark:text-gold-400">Mission Watch</h3>
                <p className="text-[9px] font-bold text-slate-400 uppercase mt-0.5">Telemetry Feed</p>
              </div>
              <button onClick={() => setShowWatch(false)} className="p-2 text-slate-400 hover:text-brand-900 dark:hover:text-white"><X size={20}/></button>
           </div>
           
           <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {activeAlerts.length > 0 ? activeAlerts.map(alert => {
                const diff = differenceInMinutes(parseISO(alert.targetTime), new Date());
                const isUrgent = diff <= 5;
                const isLate = diff < 0;
                const linkedTrip = alert.tripId ? trips.find(trip => trip.id === alert.tripId) : null;
                const linkedDriver = alert.driverId
                  ? drivers.find(driver => driver.id === alert.driverId)
                  : (linkedTrip?.driverId ? drivers.find(driver => driver.id === linkedTrip.driverId) : null);
                const customerPhone = normalizePhoneForWhatsApp(linkedTrip?.customerPhone || '');
                const customerWhatsAppHref = customerPhone ? buildWhatsAppLink(customerPhone) : null;
                const driverPhone = normalizePhoneForWhatsApp(linkedDriver?.phone || '');
                const driverWhatsAppHref = driverPhone ? buildWhatsAppLink(driverPhone) : null;

                return (
                  <div key={alert.id} className={`p-4 rounded-2xl border transition-all ${isUrgent ? 'bg-red-50 dark:bg-red-900/10 border-red-100 dark:border-red-900/30' : 'bg-slate-50 dark:bg-brand-950 border-slate-100 dark:border-white/5'}`}>
                    <div className="flex justify-between items-start mb-2">
                       <span className={`text-[8px] font-black px-1.5 py-0.5 rounded uppercase tracking-widest ${isLate ? 'bg-red-500 text-white' : 'bg-brand-900 text-gold-400'}`}>
                         {alert.type}
                       </span>
                       <div className="flex items-center text-slate-400">
                         <Clock size={10} className="mr-1" />
                         <span className={`text-[10px] font-black ${isLate ? 'text-red-500' : isUrgent ? 'text-amber-500' : 'text-slate-400'}`}>
                            {isLate ? 'LATE' : `${diff}m`}
                         </span>
                       </div>
                    </div>
                    <h4 className="text-xs font-black uppercase tracking-tight text-brand-900 dark:text-white mb-1 line-clamp-1">{alert.customerName}</h4>
                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">{alert.label}</p>
                    {customerWhatsAppHref && (
                      <div className="mt-2 flex items-center gap-2">
                        {customerWhatsAppHref && (
                          <a href={customerWhatsAppHref} target="_blank" rel="noopener noreferrer" className="h-6 px-2 rounded-md border border-emerald-300 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[8px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300 inline-flex items-center">
                            <MessageCircle size={10} className="mr-1" />Customer WA
                          </a>
                        )}
                      </div>
                    )}
                    {alert.snoozedUntil && new Date(alert.snoozedUntil).getTime() > Date.now() && (
                      <p className="mt-1 text-[8px] font-black uppercase tracking-widest text-amber-600 dark:text-amber-300">
                        Snoozed until {format(parseISO(alert.snoozedUntil), 'MMM d, HH:mm')}
                      </p>
                    )}
                    {linkedDriver && (
                      <div className="mt-2 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-900 px-3 py-2">
                        <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Driver Preview</p>
                        <p className="text-[10px] font-black uppercase tracking-tight text-brand-900 dark:text-slate-100 mt-0.5">
                          {linkedDriver.name} · {linkedDriver.plateNumber}
                        </p>
                        <p className="text-[8px] font-bold uppercase tracking-widest text-slate-400 mt-0.5">
                          {linkedDriver.carModel}
                        </p>
                        <div className="flex items-center gap-2 mt-2">
                          {driverWhatsAppHref && (
                            <a href={driverWhatsAppHref} target="_blank" rel="noopener noreferrer" className="h-6 px-2 rounded-md border border-emerald-300 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[8px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300 inline-flex items-center">
                              <MessageCircle size={10} className="mr-1" />WA
                            </a>
                          )}
                        </div>
                      </div>
                    )}
                    <div className="mt-3 pt-3 border-t border-slate-200 dark:border-white/5 flex items-center justify-between gap-2">
                       <button onClick={() => alert.tripId && navigate(`/trips?id=${alert.tripId}`)} disabled={!alert.tripId} className="text-[8px] font-black uppercase text-blue-500 hover:underline disabled:opacity-40 disabled:cursor-not-allowed">View Vector</button>
                       <div className="flex items-center gap-1.5">
                         <button
                           onClick={() => snoozeAlert(alert.id, 10)}
                           className="h-7 px-2 rounded-md border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 text-[7px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-300"
                         >
                           Snooze
                         </button>
                         <button
                           onClick={() => resolveAlert(alert.id)}
                           className="h-7 px-2 rounded-md border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[7px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300"
                         >
                           Resolve
                         </button>
                       </div>
                    </div>
                  </div>
                );
              }) : (
                <div className="h-full flex flex-col items-center justify-center opacity-20 text-center py-20">
                  <Zap size={48} className="mb-4" />
                  <p className="text-[10px] font-black uppercase tracking-widest">No Active Watch</p>
                </div>
              )}
           </div>
        </div>
      )}

      {/* Main Content Wrapper */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* Sidebar - Hidden in Intelligence Mode */}
        {!isIntelligenceMode && (
          <aside className="app-sidebar hidden md:flex flex-col w-20 lg:w-64 bg-slate-100 dark:bg-brand-900/50 border-r border-slate-200 dark:border-brand-800 p-3 lg:p-4 space-y-2 overflow-y-auto flex-shrink-0 z-20 transition-all duration-300">
              <div className="mb-4 px-2 hidden lg:block">
                  <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">CMD Center</p>
              </div>
              <NavLink to="/brief" className={sidebarLinkClass}>
                <BrainCircuit size={20} />
                <span className="font-bold hidden lg:inline">GM Brief</span>
              </NavLink>
              <NavLink to="/" className={sidebarLinkClass}>
                <Car size={20} />
                <span className="font-bold hidden lg:inline">Calculator</span>
              </NavLink>
              <NavLink to="/trips" className={sidebarLinkClass}>
                <List size={20} />
                <span className="font-bold hidden lg:inline">Missions</span>
              </NavLink>
              <NavLink to="/drivers" className={sidebarLinkClass}>
                <Users size={20} />
                <span className="font-bold hidden lg:inline">Fleet</span>
              </NavLink>
              <div className="mt-auto pt-4 border-t border-slate-200 dark:border-brand-800">
                  <NavLink to="/settings" className={sidebarLinkClass}>
                    <SettingsIcon size={20} />
                    <span className="font-bold hidden lg:inline">Config</span>
                  </NavLink>
              </div>
          </aside>
        )}

        {/* Page Content */}
        <main className={`app-main flex-1 overflow-auto relative transition-all duration-500 ${isIntelligenceMode ? 'pb-0' : 'pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0'}`}>
            {children}
        </main>
      </div>

      {/* Bottom Navigation - Hidden in Intelligence Mode */}
      {!isIntelligenceMode && (
        <nav className="app-bottom-nav fixed bottom-0 left-0 right-0 h-16 bg-white dark:bg-brand-900 border-t border-slate-200 dark:border-brand-800 flex justify-around md:hidden z-50 pb-safe transition-colors duration-300">
          <NavLink to="/brief" className={({ isActive }) => `${linkClass({ isActive })} app-bottom-link`}>
            <BrainCircuit size={18} className="mb-1" />
            <span className="app-bottom-label">Intel</span>
          </NavLink>
          <NavLink to="/" className={({ isActive }) => `${linkClass({ isActive })} app-bottom-link`}>
            <Car size={18} className="mb-1" />
            <span className="app-bottom-label">Quote</span>
          </NavLink>
          <NavLink to="/trips" className={({ isActive }) => `${linkClass({ isActive })} app-bottom-link`}>
            <List size={18} className="mb-1" />
            <span className="app-bottom-label">Logs</span>
          </NavLink>
          <NavLink to="/drivers" className={({ isActive }) => `${linkClass({ isActive })} app-bottom-link`}>
            <Users size={18} className="mb-1" />
            <span className="app-bottom-label">Fleet</span>
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `${linkClass({ isActive })} app-bottom-link`}>
            <SettingsIcon size={18} className="mb-1" />
            <span className="app-bottom-label">Config</span>
          </NavLink>
        </nav>
      )}
    </div>
  );
};
