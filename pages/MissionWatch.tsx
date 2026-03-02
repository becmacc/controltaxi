import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '../context/StoreContext';
import { format, differenceInMinutes, parseISO } from 'date-fns';
import { Clock, MessageCircle, Zap, ExternalLink, X } from 'lucide-react';
import { buildWhatsAppLink, normalizePhoneForWhatsApp } from '../services/whatsapp';

export const MissionWatchPage: React.FC = () => {
  const { alerts, trips, drivers, snoozeAlert, resolveAlert } = useStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [clockTick, setClockTick] = useState(Date.now());
  const isDetachedWatchRoute = new URLSearchParams(location.search).get('detached') === '1';

  useEffect(() => {
    const interval = window.setInterval(() => {
      setClockTick(Date.now());
    }, 30000);

    return () => {
      clearInterval(interval);
    };
  }, []);

  const getAlertTimestamp = (value: string) => {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
  };

  const activeAlerts = useMemo(() => (
    alerts
      .filter(a => {
        if (a.triggered) return false;
        if (!a.snoozedUntil) return true;
        const snoozedUntilMs = new Date(a.snoozedUntil).getTime();
        if (!Number.isFinite(snoozedUntilMs)) return true;
        return snoozedUntilMs <= clockTick;
      })
      .sort((a, b) => getAlertTimestamp(a.targetTime) - getAlertTimestamp(b.targetTime))
  ), [alerts, clockTick]);

  const tripsById = useMemo(() => new Map(trips.map(trip => [trip.id, trip])), [trips]);
  const driversById = useMemo(() => new Map(drivers.map(driver => [driver.id, driver])), [drivers]);

  const MISSION_WATCH_UI_CHANNEL = 'control-mission-watch-ui';
  const MISSION_WATCH_UI_STORAGE_KEY = 'control_mission_watch_ui_event';

  useEffect(() => {
    const handleUiMessage = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const type = String((payload as { type?: unknown }).type || '');
      if (type === 'INLINE_OPENED') {
        if (isDetachedWatchRoute) {
          window.close();
        }
      }
    };

    const announcePopupOpened = () => {
      const payload = { type: 'POPUP_OPENED', at: Date.now() };

      if (typeof BroadcastChannel !== 'undefined') {
        try {
          const channel = new BroadcastChannel(MISSION_WATCH_UI_CHANNEL);
          channel.postMessage(payload);
          channel.close();
        } catch {
        }
      }

      try {
        localStorage.setItem(MISSION_WATCH_UI_STORAGE_KEY, JSON.stringify(payload));
        localStorage.removeItem(MISSION_WATCH_UI_STORAGE_KEY);
      } catch {
      }
    };

    announcePopupOpened();

    const channel = typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(MISSION_WATCH_UI_CHANNEL)
      : null;

    if (channel) {
      channel.onmessage = event => {
        handleUiMessage(event.data);
      };
    }

    const handleStorageMessage = (event: StorageEvent) => {
      if (event.key !== MISSION_WATCH_UI_STORAGE_KEY || !event.newValue) return;
      try {
        handleUiMessage(JSON.parse(event.newValue));
      } catch {
      }
    };

    window.addEventListener('storage', handleStorageMessage);
    return () => {
      if (channel) channel.close();
      window.removeEventListener('storage', handleStorageMessage);
    };
  }, [isDetachedWatchRoute]);

  const handleCloseWatch = () => {
    window.close();
    window.setTimeout(() => {
      if (!window.closed) {
        navigate('/brief');
      }
    }, 80);
  };

  return (
    <div className="h-full min-h-screen bg-slate-50 dark:bg-brand-950 p-4 md:p-6">
      <div className="h-full rounded-2xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 shadow-xl flex flex-col overflow-hidden">
        <div className="p-5 border-b border-slate-100 dark:border-white/5 flex justify-between items-center bg-slate-50 dark:bg-brand-950">
          <div>
            <h2 className="text-xs font-black uppercase tracking-[0.3em] text-brand-900 dark:text-gold-400">Mission Watch</h2>
            <p className="text-[9px] font-bold text-slate-400 uppercase mt-0.5">Telemetry Feed · Window Mode</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate('/brief')}
              className="h-8 px-2.5 rounded-md border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-[8px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300 inline-flex items-center gap-1"
              title="Open GM Brief"
            >
              <ExternalLink size={12} />
              GM
            </button>
            <button
              type="button"
              onClick={handleCloseWatch}
              className="p-2 text-slate-400 hover:text-brand-900 dark:hover:text-white"
              title="Close window"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {activeAlerts.length > 0 ? activeAlerts.map(alert => {
            const targetDate = parseISO(alert.targetTime);
            const hasValidTargetDate = Number.isFinite(targetDate.getTime());
            const diff = hasValidTargetDate ? differenceInMinutes(targetDate, new Date(clockTick)) : 0;
            const isUrgent = diff <= 5;
            const isLate = diff < 0;
            const linkedTrip = typeof alert.tripId === 'number' ? (tripsById.get(alert.tripId) || null) : null;
            const linkedDriver = alert.driverId
              ? (driversById.get(alert.driverId) || null)
              : (linkedTrip?.driverId ? (driversById.get(linkedTrip.driverId) || null) : null);
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
                      {hasValidTargetDate ? (isLate ? `LATE ${Math.abs(diff)}m` : `${diff}m`) : '--'}
                    </span>
                  </div>
                </div>

                <h4 className="text-xs font-black uppercase tracking-tight text-brand-900 dark:text-white mb-1 line-clamp-1">{alert.customerName}</h4>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">{alert.label}</p>

                {(customerWhatsAppHref || driverWhatsAppHref) && (
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    {customerWhatsAppHref && (
                      <a href={customerWhatsAppHref} target="_blank" rel="noopener noreferrer" className="h-6 px-2 rounded-md border border-emerald-300 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[8px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300 inline-flex items-center">
                        <MessageCircle size={10} className="mr-1" />Customer WA
                      </a>
                    )}
                    {driverWhatsAppHref && (
                      <a href={driverWhatsAppHref} target="_blank" rel="noopener noreferrer" className="h-6 px-2 rounded-md border border-blue-300 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 text-[8px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300 inline-flex items-center">
                        <MessageCircle size={10} className="mr-1" />Driver WA
                      </a>
                    )}
                  </div>
                )}

                {alert.snoozedUntil && new Date(alert.snoozedUntil).getTime() > Date.now() && (
                  <p className="mt-1 text-[8px] font-black uppercase tracking-widest text-amber-600 dark:text-amber-300">
                    Snoozed until {format(parseISO(alert.snoozedUntil), 'MMM d, HH:mm')}
                  </p>
                )}

                <div className="mt-3 pt-3 border-t border-slate-200 dark:border-white/5 flex items-center justify-between gap-2">
                  <button
                    onClick={() => alert.tripId && navigate(`/trips?id=${alert.tripId}`)}
                    disabled={!alert.tripId}
                    className="text-[8px] font-black uppercase text-blue-500 hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    View Vector
                  </button>
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
            <div className="h-full flex flex-col items-center justify-center opacity-30 text-center py-20">
              <Zap size={48} className="mb-4" />
              <p className="text-[10px] font-black uppercase tracking-widest">No Active Watch</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
