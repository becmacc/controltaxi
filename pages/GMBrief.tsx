
import React, { useMemo, useState, useEffect, useRef } from 'react';
import { useStore } from '../context/StoreContext';
import { TripStatus, Trip, Driver, Settings, TripPaymentMode, TripSettlementStatus } from '../types';
import { loadGoogleMapsScript } from '../services/googleMapsLoader';
import { parseGoogleMapsLink } from '../services/locationParser';
import { buildWhatsAppLink } from '../services/whatsapp';
import {
  DEFAULT_OWNER_DRIVER_COMPANY_SHARE_PERCENT,
  DEFAULT_COMPANY_CAR_DRIVER_GAS_COMPANY_SHARE_PERCENT,
  DEFAULT_OTHER_DRIVER_COMPANY_SHARE_PERCENT,
} from '../constants';
import { 
  Sparkles, Globe, LocateFixed, Focus, Timer,
  Activity, Zap, Sun, Moon, Sunrise, Sunset, Copy, Check, MessageCircle, Briefcase, Receipt, Wallet, AlertTriangle
} from 'lucide-react';
import { format, isToday, parseISO, startOfDay, addHours, isSameHour } from 'date-fns';
import { Button } from '../components/ui/Button';

declare var google: any;

const clampSharePercent = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, value));
};

const getCompanyShareForDriver = (driver: Driver, settings: Settings): { rate: number; label: string } => {
  const ownerDriverPercent = clampSharePercent(settings.ownerDriverCompanySharePercent, DEFAULT_OWNER_DRIVER_COMPANY_SHARE_PERCENT);
  const companyCarDriverGasPercent = clampSharePercent(settings.companyCarDriverGasCompanySharePercent, DEFAULT_COMPANY_CAR_DRIVER_GAS_COMPANY_SHARE_PERCENT);
  const otherPercent = clampSharePercent(settings.otherDriverCompanySharePercent, DEFAULT_OTHER_DRIVER_COMPANY_SHARE_PERCENT);

  const overrideRaw = typeof driver.companyShareOverridePercent === 'number' && Number.isFinite(driver.companyShareOverridePercent)
    ? Math.max(0, Math.min(100, driver.companyShareOverridePercent))
    : null;

  if (overrideRaw !== null) {
    return { rate: overrideRaw / 100, label: 'MANUAL OVERRIDE' };
  }

  const ownerPaysOps =
    driver.vehicleOwnership === 'OWNER_DRIVER' &&
    driver.fuelCostResponsibility === 'DRIVER' &&
    driver.maintenanceResponsibility === 'DRIVER';

  if (ownerPaysOps) {
    return { rate: ownerDriverPercent / 100, label: 'OWNER + GAS + MAINT' };
  }

  if (driver.vehicleOwnership === 'COMPANY_FLEET' && driver.fuelCostResponsibility === 'DRIVER') {
    return { rate: companyCarDriverGasPercent / 100, label: 'COMPANY CAR + DRIVER GAS' };
  }

  return { rate: otherPercent / 100, label: 'OTHER CONFIG RULE' };
};

const getTripPaymentMode = (trip: Trip): TripPaymentMode => (trip.paymentMode === 'CREDIT' ? 'CREDIT' : 'CASH');
const getTripSettlementStatus = (trip: Trip): TripSettlementStatus => (trip.settlementStatus || 'PENDING');

const AccountingPulse: React.FC<{
  grossRevenue: number;
  companyOwed: number;
  netAfterCompany: number;
  openBacklogUsd: number;
  openBacklogCount: number;
  overdueOpenCount: number;
  weeklyOpenUsd: number;
  monthlyOpenUsd: number;
  collectedTodayUsd: number;
  cashSettledTodayUsd: number;
  openCreditTripTodayUsd: number;
  receiptedTripTodayUsd: number;
}> = ({
  grossRevenue,
  companyOwed,
  netAfterCompany,
  openBacklogUsd,
  openBacklogCount,
  overdueOpenCount,
  weeklyOpenUsd,
  monthlyOpenUsd,
  collectedTodayUsd,
  cashSettledTodayUsd,
  openCreditTripTodayUsd,
  receiptedTripTodayUsd,
}) => {
  const cycleTotal = Math.max(weeklyOpenUsd + monthlyOpenUsd, 1);
  const weeklyShare = Math.round((weeklyOpenUsd / cycleTotal) * 100);
  const monthlyShare = Math.round((monthlyOpenUsd / cycleTotal) * 100);

  return (
    <div className="bg-white dark:bg-brand-900 rounded-[2.5rem] p-6 md:p-8 border border-slate-200 dark:border-white/5 shadow-xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[10px] font-black uppercase tracking-[0.35em] text-slate-400">Accounting Visualizer</h3>
          <p className="text-sm font-black text-brand-900 dark:text-white uppercase tracking-tight">Yield · Credit · Backlog</p>
        </div>
        <div className="inline-flex items-center h-8 px-3 rounded-lg border border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 text-[8px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300">
          Live
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 inline-flex items-center gap-1"><Wallet size={10} /> Gross</p>
          <p className="text-xl font-black text-emerald-600 mt-1">${Math.round(grossRevenue)}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 inline-flex items-center gap-1"><Briefcase size={10} /> Company Owed</p>
          <p className="text-xl font-black text-blue-600 mt-1">${Math.round(companyOwed)}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 inline-flex items-center gap-1"><AlertTriangle size={10} /> Open Backlog</p>
          <p className="text-xl font-black text-amber-600 mt-1">${Math.round(openBacklogUsd)}</p>
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-500 mt-1">{openBacklogCount} open · {overdueOpenCount} overdue</p>
        </div>
        <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 inline-flex items-center gap-1"><Receipt size={10} /> Collected Today</p>
          <p className="text-xl font-black text-indigo-600 mt-1">${Math.round(collectedTodayUsd)}</p>
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-500 mt-1">Net after owed ${Math.round(netAfterCompany)}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Cash Settled (Trips)</p>
          <p className="text-xl font-black text-emerald-600 mt-1">${Math.round(cashSettledTodayUsd)}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Open Credit (Trips)</p>
          <p className="text-xl font-black text-amber-600 mt-1">${Math.round(openCreditTripTodayUsd)}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Receipted (Trips)</p>
          <p className="text-xl font-black text-indigo-600 mt-1">${Math.round(receiptedTripTodayUsd)}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4 space-y-3">
        <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Cycle Mix (Open Credit)</p>
        <div className="h-2 rounded-full bg-slate-200 dark:bg-brand-800 overflow-hidden flex">
          <div className="h-full bg-blue-500" style={{ width: `${weeklyShare}%` }} />
          <div className="h-full bg-purple-500" style={{ width: `${monthlyShare}%` }} />
        </div>
        <div className="flex items-center justify-between text-[8px] font-black uppercase tracking-widest">
          <span className="text-blue-600 dark:text-blue-300">Weekly ${Math.round(weeklyOpenUsd)} ({weeklyShare}%)</span>
          <span className="text-purple-600 dark:text-purple-300">Monthly ${Math.round(monthlyOpenUsd)} ({monthlyShare}%)</span>
        </div>
      </div>
    </div>
  );
};

const TemporalPulse: React.FC<{ trips: Trip[] }> = ({ trips }) => {
  const [hoveredHour, setHoveredHour] = useState<number | null>(null);
  const currentHour = new Date().getHours();

  const telemetryTrips = useMemo(() => {
    const now = new Date();
    const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return trips.filter(t => {
      const date = t.tripDate ? parseISO(t.tripDate) : parseISO(t.createdAt);
      return Number.isFinite(date.getTime()) && date >= windowStart && date <= now;
    });
  }, [trips]);

  const hourlyData = useMemo(() => {
    const hours = new Array(24).fill(0);
    telemetryTrips.forEach(t => {
      const date = t.tripDate ? parseISO(t.tripDate) : parseISO(t.createdAt);
      const hour = date.getHours();
      hours[hour]++;
    });
    const max = Math.max(...hours, 1);
    return hours.map((count, hr) => ({
      hour: hr,
      count,
      percentage: (count / max) * 100
    }));
  }, [telemetryTrips]);

  const peakHour = useMemo(() => {
    return [...hourlyData].sort((a, b) => b.count - a.count)[0];
  }, [hourlyData]);

  const telemetrySignals = useMemo(() => {
    const activeHours = hourlyData.filter(entry => entry.count > 0).length;
    const totalMissions = telemetryTrips.length;
    const peakShare = totalMissions > 0 ? peakHour.count / totalMissions : 0;

    const stability = totalMissions === 0
      ? 'Idle'
      : peakShare > 0.45
        ? 'Spike-Prone'
        : activeHours < 4
          ? 'Sparse'
          : 'Balanced';

    return {
      activeHours,
      totalMissions,
      stability,
      peakLabel: format(addHours(startOfDay(new Date()), peakHour.hour), 'ha'),
    };
  }, [hourlyData, telemetryTrips, peakHour]);

  const trafficTelemetry = useMemo(() => {
    const withTraffic = trips.filter(t => Number.isFinite(t.trafficIndex) || Number.isFinite(t.surplusMin));
    if (withTraffic.length === 0) {
      return { avgIndex: 0, avgDelay: 0, coverage: 0 };
    }

    const avgIndex = Math.round(withTraffic.reduce((acc, trip) => acc + (Number.isFinite(trip.trafficIndex) ? Number(trip.trafficIndex) : 0), 0) / withTraffic.length);
    const avgDelay = Math.round(withTraffic.reduce((acc, trip) => acc + (Number.isFinite(trip.surplusMin) ? Number(trip.surplusMin) : 0), 0) / withTraffic.length);
    const coverage = Math.round((withTraffic.length / Math.max(1, trips.length)) * 100);
    return { avgIndex, avgDelay, coverage };
  }, [trips]);

  const getTimeIcon = (hour: number) => {
    if (hour >= 5 && hour < 11) return <Sunrise size={10} className="text-orange-400" />;
    if (hour >= 11 && hour < 17) return <Sun size={10} className="text-gold-500" />;
    if (hour >= 17 && hour < 21) return <Sunset size={10} className="text-rose-400" />;
    return <Moon size={10} className="text-blue-400" />;
  };

  return (
    <div className="bg-white dark:bg-brand-900 rounded-[2.5rem] p-6 md:p-8 border border-slate-200 dark:border-white/5 shadow-xl space-y-8 overflow-x-hidden overflow-y-visible">
      {/* Header Info */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex items-center space-x-4">
          <div className="p-3 bg-brand-950 text-gold-500 rounded-2xl border border-white/5 shadow-inner">
            <Timer size={20} />
          </div>
          <div>
            <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400">Intensity Matrix</h3>
            <p className="text-sm font-black text-brand-900 dark:text-white uppercase tracking-tight">24-Hour Mission Distribution</p>
          </div>
        </div>
        
        <div className="flex items-center space-x-4 bg-slate-50 dark:bg-brand-950/50 p-2 rounded-2xl border border-slate-100 dark:border-white/5">
          <div className="px-3 py-1 text-right">
            <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest block">Peak Mission Volume</span>
            <span className="text-sm font-black text-gold-600">{format(addHours(startOfDay(new Date()), peakHour.hour), 'ha')}</span>
          </div>
          <div className="h-8 w-px bg-slate-200 dark:bg-brand-800" />
          <div className="px-3 py-1">
             <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest block">Live Status</span>
             <div className="flex items-center space-x-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
               <span className="text-[10px] font-black uppercase text-emerald-500">{telemetrySignals.totalMissions > 0 ? 'Telemetry Online' : 'Telemetry Idle'}</span>
             </div>
             <span className="text-[8px] font-black text-slate-500 dark:text-slate-300 uppercase tracking-widest block mt-1">TI {trafficTelemetry.avgIndex} · Delay {trafficTelemetry.avgDelay}m · {trafficTelemetry.coverage}% coverage</span>
          </div>
        </div>
      </div>

      {/* Visual Chart Area */}
      <div className="relative pt-3 pb-2 overflow-x-hidden">
        {/* Background Grid Lines */}
        <div className="absolute inset-0 flex flex-col justify-between pointer-events-none border-b border-slate-100 dark:border-white/5 h-40">
           <div className="w-full border-t border-slate-50 dark:border-white/5 opacity-50" />
           <div className="w-full border-t border-slate-50 dark:border-white/5 opacity-50" />
           <div className="w-full border-t border-slate-50 dark:border-white/5 opacity-50" />
        </div>

        <div className="flex items-end justify-between h-40 gap-1 sm:gap-1.5 group/bars w-full">
          {hourlyData.map((data) => {
            const isCurrent = data.hour === currentHour;
            const isPeak = data.hour === peakHour.hour;
            const isHovered = hoveredHour === data.hour;
            const showTooltip = hoveredHour !== null ? isHovered : isCurrent;
            const tooltipPositionClass = data.hour <= 1
              ? 'left-0 translate-x-0'
              : data.hour >= 22
                ? 'right-0 translate-x-0'
                : 'left-1/2 -translate-x-1/2';

            return (
              <div 
                key={data.hour} 
                className="flex-1 min-w-0 flex flex-col items-center group relative h-full justify-end cursor-pointer"
                onMouseEnter={() => setHoveredHour(data.hour)}
                onMouseLeave={() => setHoveredHour(null)}
              >
                {/* Active Tooltip / Indicator */}
                {showTooltip && (
                  <div className={`absolute top-0 bg-brand-950 text-white p-2 rounded-xl shadow-2xl z-50 border border-white/10 animate-in fade-in zoom-in-95 duration-200 ${tooltipPositionClass}`}>
                    <div className="flex flex-col items-center min-w-[60px]">
                      <span className="text-[8px] font-black text-gold-500 uppercase tracking-widest mb-0.5">
                        {format(addHours(startOfDay(new Date()), data.hour), 'h:mm a')}
                      </span>
                      <span className="text-xs font-black">{data.count} <span className="text-[8px] text-slate-400">MISSION{data.count !== 1 ? 'S' : ''}</span></span>
                    </div>
                  </div>
                )}

                {/* The Bar */}
                <div 
                  className={`w-full rounded-t-lg transition-all duration-500 ease-out relative overflow-hidden ${
                    isPeak 
                      ? 'bg-gradient-to-t from-gold-700 to-gold-400 shadow-[0_0_15px_rgba(212,160,23,0.3)]' 
                      : isCurrent
                        ? 'bg-gradient-to-t from-emerald-700 to-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.2)]'
                        : 'bg-brand-100 dark:bg-brand-800/50 group-hover:bg-brand-200 dark:group-hover:bg-brand-700'
                  }`}
                  style={{ height: `${Math.max(data.percentage, 4)}%` }}
                >
                  {/* Subtle Scanline Effect on Bars */}
                  <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:100%_4px] pointer-events-none" />
                </div>

                {/* X-Axis Label */}
                <div className={`mt-3 flex flex-col items-center space-y-1 transition-opacity duration-300 ${data.hour % 3 === 0 || isHovered || isCurrent ? 'opacity-100' : 'opacity-20'}`}>
                   {getTimeIcon(data.hour)}
                   <span className="text-[7px] font-black text-slate-400 uppercase tracking-tighter">
                    {format(addHours(startOfDay(new Date()), data.hour), 'ha')}
                   </span>
                </div>
                
                {/* Live Dot */}
                {isCurrent && (
                  <div className="absolute -bottom-6 w-1 h-1 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,1)]" />
                )}
              </div>
            );
          })}
        </div>
      </div>
      
      {/* Footer Meta */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-6 border-t border-slate-100 dark:border-white/5">
         <div className="flex items-center space-x-3">
            <div className="p-1.5 bg-emerald-50 dark:bg-emerald-500/10 rounded-lg"><Activity size={12} className="text-emerald-500" /></div>
          <span className="text-[9px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-[0.2em]">Operational Stability: {telemetrySignals.stability}</span>
         </div>
         <div className="flex items-center space-x-3 sm:justify-end">
            <div className="p-1.5 bg-gold-50 dark:bg-gold-500/10 rounded-lg"><Zap size={12} className="text-gold-500" /></div>
          <span className="text-[9px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-[0.2em]">High Impact Hour: {telemetrySignals.peakLabel} · {telemetrySignals.totalMissions} Missions (24h)</span>
         </div>
      </div>
    </div>
  );
};

const FleetHeatmap: React.FC<{ trips: Trip[], apiKey: string, theme: string, mapIdLight?: string, mapIdDark?: string }> = ({ trips, apiKey, theme, mapIdLight, mapIdDark }) => {
  const mapRef = useRef<HTMLDivElement>(null);
  const [mapsLoaded, setMapsLoaded] = useState(false);
  const mapInstance = useRef<any>(null);
  const heatmapLayer = useRef<any>(null);

  const parseLatLngFromText = (text?: string): { lat: number; lng: number } | null => {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const match = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!match) return null;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  };

  const resolveTripPoint = (trip: Trip, type: 'pickup' | 'destination'): { lat: number; lng: number } | null => {
    if (type === 'pickup') {
      if (Number.isFinite(trip.pickupLat) && Number.isFinite(trip.pickupLng)) {
        return { lat: Number(trip.pickupLat), lng: Number(trip.pickupLng) };
      }
      const fromLink = parseGoogleMapsLink(trip.pickupOriginalLink || '');
      if (fromLink) return { lat: fromLink.lat, lng: fromLink.lng };
      return parseLatLngFromText(trip.pickupText);
    }

    if (Number.isFinite(trip.destLat) && Number.isFinite(trip.destLng)) {
      return { lat: Number(trip.destLat), lng: Number(trip.destLng) };
    }
    const fromLink = parseGoogleMapsLink(trip.destinationOriginalLink || '');
    if (fromLink) return { lat: fromLink.lat, lng: fromLink.lng };
    return parseLatLngFromText(trip.destinationText);
  };

  const resolveStopPoint = (stop?: Trip['stops'][number]): { lat: number; lng: number } | null => {
    if (!stop) return null;
    if (Number.isFinite(stop.lat) && Number.isFinite(stop.lng)) {
      return { lat: Number(stop.lat), lng: Number(stop.lng) };
    }
    const fromLink = parseGoogleMapsLink(stop.originalLink || '');
    if (fromLink) return { lat: fromLink.lat, lng: fromLink.lng };
    return parseLatLngFromText(stop.text);
  };
  
  useEffect(() => {
    if (apiKey) {
      loadGoogleMapsScript(apiKey)
        .then(() => setMapsLoaded(true))
        .catch(err => console.error("Maps load error in Brief:", err));
    }
  }, [apiKey]);

  const recenterMap = () => {
    if (!mapInstance.current || !mapsLoaded || trips.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    let hasPoints = false;

    trips.forEach(t => {
      const pickupPoint = resolveTripPoint(t, 'pickup');
      const destinationPoint = resolveTripPoint(t, 'destination');
      const stopPoints = (t.stops || []).map(stop => resolveStopPoint(stop)).filter((point): point is { lat: number; lng: number } => Boolean(point));

      [pickupPoint, destinationPoint, ...stopPoints].forEach(point => {
        if (!point) return;
        bounds.extend(new google.maps.LatLng(point.lat, point.lng));
        hasPoints = true;
      });
    });

    if (hasPoints) mapInstance.current.fitBounds(bounds);
  };

  useEffect(() => {
    if (mapsLoaded && mapRef.current && !mapInstance.current) {
      const selectedMapId = (theme === 'dark' ? mapIdDark : mapIdLight) || mapIdLight;
      const mapOptions: any = {
        center: { lat: 33.8938, lng: 35.5018 },
        zoom: 12,
        disableDefaultUI: true
      };
      if (selectedMapId) {
        mapOptions.mapId = selectedMapId;
      }

      mapInstance.current = new google.maps.Map(mapRef.current, {
        ...mapOptions
      });
    }
  }, [mapsLoaded, theme, mapIdLight, mapIdDark]);

  useEffect(() => {
    if (mapsLoaded && mapInstance.current) {
      const points = trips.flatMap(t => {
        const weightedPoints: Array<{ location: any; weight: number }> = [];
        const pickupPoint = resolveTripPoint(t, 'pickup');
        if (pickupPoint) {
          weightedPoints.push({ location: new google.maps.LatLng(pickupPoint.lat, pickupPoint.lng), weight: 1.2 });
        }

        const destinationPoint = resolveTripPoint(t, 'destination');
        if (destinationPoint) {
          weightedPoints.push({ location: new google.maps.LatLng(destinationPoint.lat, destinationPoint.lng), weight: 1.0 });
        }

        (t.stops || []).forEach(stop => {
          const stopPoint = resolveStopPoint(stop);
          if (stopPoint) {
            weightedPoints.push({ location: new google.maps.LatLng(stopPoint.lat, stopPoint.lng), weight: 0.9 });
          }
        });

        return weightedPoints;
      });

      if (heatmapLayer.current) heatmapLayer.current.setMap(null);
      heatmapLayer.current = new google.maps.visualization.HeatmapLayer({
        data: points, map: mapInstance.current, radius: 40, opacity: 0.7
      });
    }
  }, [mapsLoaded, trips]);

  useEffect(() => {
    return () => {
      if (heatmapLayer.current) {
        heatmapLayer.current.setMap(null);
      }
    };
  }, []);

  return (
    <div className="relative w-full h-[400px] rounded-[2.5rem] overflow-hidden border border-slate-200 dark:border-brand-800 shadow-2xl group/map">
      <div ref={mapRef} className="w-full h-full" />
      <div className="absolute top-6 left-6 flex space-x-2 pointer-events-none">
        <div className="bg-brand-900/95 backdrop-blur-xl p-4 rounded-2xl border border-white/10 shadow-2xl pointer-events-auto">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-gold-600 rounded-lg"><LocateFixed className="text-brand-950" size={16} /></div>
            <div>
              <p className="text-[10px] font-black text-gold-500 uppercase tracking-widest leading-none">Spatial Density</p>
              <div className="flex items-center mt-1.5 space-x-2">
                <span className="text-lg font-black text-white">{trips.length}</span>
                <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Active Vectors</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="absolute top-6 right-6 pointer-events-auto">
        <button onClick={recenterMap} className="p-3 bg-brand-900/95 backdrop-blur-xl rounded-xl border border-white/10 text-gold-500 shadow-2xl hover:bg-gold-600 hover:text-brand-900 transition-all active:scale-90"><Focus size={18} /></button>
      </div>
    </div>
  );
};

export const GMBriefPage: React.FC = () => {
  const { trips, drivers, creditLedger, receipts, settings, theme } = useStore();
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [aiInsightBullets, setAiInsightBullets] = useState<string[] | null>(null);
  const [aiProgress, setAiProgress] = useState(0);
  const [insightActionStatus, setInsightActionStatus] = useState('');
  const [copiedInsight, setCopiedInsight] = useState(false);

  const stats = useMemo(() => {
    const todayTrips = trips.filter(t => isToday(parseISO(t.tripDate || t.createdAt)));
    const revenueToday = todayTrips.filter(t => t.status !== TripStatus.CANCELLED).reduce((acc, t) => acc + t.fareUsd, 0);
    const busyDrivers = drivers.filter(d => d.currentStatus === 'BUSY').length;
    const loadFactor = drivers.length > 0 ? (busyDrivers / drivers.length) * 100 : 0;
    return { revenueToday, loadFactor: Math.round(loadFactor), todayTripsList: todayTrips };
  }, [trips, drivers]);

  const synthesisMetrics = useMemo(() => {
    const todayTrips = stats.todayTripsList;
    const nonCancelled = todayTrips.filter(t => t.status !== TripStatus.CANCELLED);
    const completed = todayTrips.filter(t => t.status === TripStatus.COMPLETED);
    const confirmed = todayTrips.filter(t => t.status === TripStatus.CONFIRMED);
    const cancelled = todayTrips.filter(t => t.status === TripStatus.CANCELLED);
    const unassignedConfirmed = confirmed.filter(t => !t.driverId).length;
    const completionRate = nonCancelled.length > 0 ? Math.round((completed.length / nonCancelled.length) * 100) : 0;
    const cancelRate = todayTrips.length > 0 ? Math.round((cancelled.length / todayTrips.length) * 100) : 0;

    const hourlyBuckets = new Array(24).fill(0);
    todayTrips.forEach(trip => {
      const stamp = trip.tripDate || trip.createdAt;
      const parsed = parseISO(stamp);
      if (!Number.isNaN(parsed.getTime())) {
        hourlyBuckets[parsed.getHours()] += 1;
      }
    });
    const peakHourCount = Math.max(...hourlyBuckets, 0);
    const peakHourIndex = hourlyBuckets.findIndex(count => count === peakHourCount);
    const peakHourLabel = peakHourIndex >= 0
      ? format(addHours(startOfDay(new Date()), peakHourIndex), 'ha')
      : 'N/A';

    const trafficTrips = todayTrips.filter(t => Number.isFinite(t.surplusMin) || Number.isFinite(t.trafficIndex));
    const avgDelay = trafficTrips.length > 0
      ? Math.round(trafficTrips.reduce((sum, t) => sum + (Number.isFinite(t.surplusMin) ? Number(t.surplusMin) : 0), 0) / trafficTrips.length)
      : 0;
    const avgTraffic = trafficTrips.length > 0
      ? Math.round(trafficTrips.reduce((sum, t) => sum + (Number.isFinite(t.trafficIndex) ? Number(t.trafficIndex) : 0), 0) / trafficTrips.length)
      : 0;

    const driverPerformance = drivers.map(driver => {
      const completedByDriver = completed.filter(trip => trip.driverId === driver.id);
      const tripsCount = completedByDriver.length;
      const revenue = completedByDriver.reduce((sum, trip) => sum + trip.fareUsd, 0);
      return { name: driver.name, trips: tripsCount, revenue };
    }).sort((a, b) => b.revenue - a.revenue);

    const topDriver = driverPerformance[0];

    return {
      totalTrips: todayTrips.length,
      completedTrips: completed.length,
      confirmedTrips: confirmed.length,
      unassignedConfirmed,
      completionRate,
      cancelRate,
      peakHourLabel,
      peakHourCount,
      avgDelay,
      avgTraffic,
      topDriver,
      activeDrivers: drivers.filter(driver => driver.status === 'ACTIVE').length,
      busyDrivers: drivers.filter(driver => driver.currentStatus === 'BUSY').length,
    };
  }, [stats.todayTripsList, drivers]);

  const accountingMetrics = useMemo(() => {
    const todayCompleted = stats.todayTripsList.filter(t => t.status === TripStatus.COMPLETED);
    const grossCompletedRevenue = todayCompleted.reduce((sum, trip) => sum + trip.fareUsd, 0);

    const revenueByDriver = new Map<string, number>();
    todayCompleted.forEach(trip => {
      if (!trip.driverId) return;
      revenueByDriver.set(trip.driverId, (revenueByDriver.get(trip.driverId) || 0) + trip.fareUsd);
    });

    const companyOwedToday = drivers.reduce((sum, driver) => {
      const driverRevenue = revenueByDriver.get(driver.id) || 0;
      return sum + (driverRevenue * getCompanyShareForDriver(driver, settings).rate);
    }, 0);

    const openEntries = creditLedger.filter(entry => entry.status === 'OPEN');
    const openBacklogUsd = openEntries.reduce((sum, entry) => sum + entry.amountUsd, 0);
    const weeklyOpenUsd = openEntries.filter(entry => entry.cycle === 'WEEKLY').reduce((sum, entry) => sum + entry.amountUsd, 0);
    const monthlyOpenUsd = openEntries.filter(entry => entry.cycle === 'MONTHLY').reduce((sum, entry) => sum + entry.amountUsd, 0);
    const overdueOpenCount = openEntries.filter(entry => {
      if (!entry.dueDate) return false;
      const due = parseISO(entry.dueDate);
      return Number.isFinite(due.getTime()) && due < new Date();
    }).length;

    const collectedTodayUsd = receipts
      .filter(receipt => isToday(parseISO(receipt.issuedAt)))
      .reduce((sum, receipt) => sum + receipt.amountUsd, 0);

    const cashSettledTodayUsd = todayCompleted
      .filter(trip => getTripPaymentMode(trip) === 'CASH' && getTripSettlementStatus(trip) !== 'PENDING')
      .reduce((sum, trip) => sum + trip.fareUsd, 0);
    const openCreditTripTodayUsd = todayCompleted
      .filter(trip => getTripPaymentMode(trip) === 'CREDIT' && getTripSettlementStatus(trip) === 'PENDING')
      .reduce((sum, trip) => sum + trip.fareUsd, 0);
    const receiptedTripTodayUsd = todayCompleted
      .filter(trip => getTripSettlementStatus(trip) === 'RECEIPTED')
      .reduce((sum, trip) => sum + trip.fareUsd, 0);

    const topBacklog = openEntries.reduce<Record<string, number>>((acc, entry) => {
      const key = entry.partyName || 'Unknown';
      acc[key] = (acc[key] || 0) + entry.amountUsd;
      return acc;
    }, {});
    const topBacklogParty = Object.entries(topBacklog).sort((a, b) => b[1] - a[1])[0];

    return {
      grossCompletedRevenue,
      companyOwedToday,
      netAfterCompany: grossCompletedRevenue - companyOwedToday,
      openBacklogUsd,
      openBacklogCount: openEntries.length,
      overdueOpenCount,
      weeklyOpenUsd,
      monthlyOpenUsd,
      collectedTodayUsd,
      cashSettledTodayUsd,
      openCreditTripTodayUsd,
      receiptedTripTodayUsd,
      topBacklogPartyName: topBacklogParty?.[0] || '',
      topBacklogPartyAmount: topBacklogParty?.[1] || 0,
    };
  }, [stats.todayTripsList, drivers, settings, creditLedger, receipts]);

  const generateAiSummary = async () => {
    setIsGeneratingAi(true);
    setAiInsightBullets(null);
    setInsightActionStatus('');
    setCopiedInsight(false);
    setAiProgress(10);
    const progressTimer = setInterval(() => setAiProgress(prev => (prev < 90 ? prev + 5 : prev)), 150);

    try {
      await new Promise(resolve => setTimeout(resolve, 700));
      const demandSignal = stats.loadFactor >= 75
        ? 'High load pressure'
        : stats.loadFactor >= 45
          ? 'Balanced load'
          : 'Low load';

      const trafficSignal = synthesisMetrics.avgTraffic >= 70
        ? 'heavy corridor friction'
        : synthesisMetrics.avgTraffic >= 40
          ? 'moderate corridor pressure'
          : 'fluid corridor conditions';

      const assignmentSignal = synthesisMetrics.unassignedConfirmed > 0
        ? `${synthesisMetrics.unassignedConfirmed} confirmed mission${synthesisMetrics.unassignedConfirmed > 1 ? 's are' : ' is'} still unassigned`
        : 'all confirmed missions are assigned';

      const outputSignal = synthesisMetrics.topDriver
        ? `${synthesisMetrics.topDriver.name} leads with ${synthesisMetrics.topDriver.trips} completions / $${Math.round(synthesisMetrics.topDriver.revenue)}`
        : 'no driver output leader yet';

      const accountingSignal = `owed $${Math.round(accountingMetrics.companyOwedToday)} on completed revenue; net after owed $${Math.round(accountingMetrics.netAfterCompany)}`;
      const creditSignal = accountingMetrics.openBacklogCount > 0
        ? `open backlog $${Math.round(accountingMetrics.openBacklogUsd)} across ${accountingMetrics.openBacklogCount} entries (${accountingMetrics.overdueOpenCount} overdue)`
        : 'no open credit backlog';
      const settlementSignal = `cash settled $${Math.round(accountingMetrics.cashSettledTodayUsd)} · receipted $${Math.round(accountingMetrics.receiptedTripTodayUsd)} · trip credit pending $${Math.round(accountingMetrics.openCreditTripTodayUsd)}`;
      const debtorSignal = accountingMetrics.topBacklogPartyAmount > 0
        ? `largest open party ${accountingMetrics.topBacklogPartyName} ($${Math.round(accountingMetrics.topBacklogPartyAmount)})`
        : 'no dominant debtor profile';

      const bullets = [
        `LOAD — ${demandSignal}: ${synthesisMetrics.busyDrivers}/${synthesisMetrics.activeDrivers || drivers.length || 0} active units are busy (${stats.loadFactor}%).`,
        `FLOW — ${synthesisMetrics.totalTrips} missions, ${synthesisMetrics.completedTrips} completed (${synthesisMetrics.completionRate}%), ${synthesisMetrics.cancelRate}% canceled, revenue $${Math.round(stats.revenueToday)}.`,
        `TRAFFIC — Peak ${synthesisMetrics.peakHourLabel} (${synthesisMetrics.peakHourCount} mission${synthesisMetrics.peakHourCount === 1 ? '' : 's'}); ${trafficSignal} (TI ${synthesisMetrics.avgTraffic}, delay ${synthesisMetrics.avgDelay}m).`,
        `ACCOUNTING — ${accountingSignal}; collected today $${Math.round(accountingMetrics.collectedTodayUsd)}; ${settlementSignal}.`,
        `CREDIT — ${creditSignal}; ${debtorSignal}.`,
        `ACTION — ${assignmentSignal}; ${outputSignal}.`,
      ];

      setAiProgress(100);
      setAiInsightBullets(bullets);
    } catch {
      setAiInsightBullets(['Link parity lost. Check telemetry.']);
    } finally {
      clearInterval(progressTimer);
      setIsGeneratingAi(false);
    }
  };

  const insightAsText = useMemo(() => {
    if (!aiInsightBullets || aiInsightBullets.length === 0) return '';
    return `GM Brief Synthesis\n${aiInsightBullets.map(line => `• ${line}`).join('\n')}`;
  }, [aiInsightBullets]);

  const handleCopyInsight = async () => {
    if (!insightAsText) return;
    try {
      await navigator.clipboard.writeText(insightAsText);
      setCopiedInsight(true);
      setInsightActionStatus('Copied.');
      setTimeout(() => setCopiedInsight(false), 1800);
      setTimeout(() => setInsightActionStatus(''), 2500);
    } catch {
      setInsightActionStatus('Clipboard permission blocked.');
      setTimeout(() => setInsightActionStatus(''), 2500);
    }
  };

  const handleSendInsightToOperator = () => {
    if (!insightAsText) return;
    const link = buildWhatsAppLink(settings.operatorWhatsApp, insightAsText);
    if (!link) {
      setInsightActionStatus('Set a valid Operator WhatsApp in Settings.');
      setTimeout(() => setInsightActionStatus(''), 2600);
      return;
    }
    window.open(link, '_blank', 'noopener,noreferrer');
    setInsightActionStatus('WhatsApp draft ready.');
    setTimeout(() => setInsightActionStatus(''), 2200);
  };

  return (
    <div className="app-page-shell gmb-shell p-4 md:p-8 max-w-7xl mx-auto space-y-8 animate-fade-in pb-24 lg:pb-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center space-x-2 mb-1">
            <div className="w-2 h-2 rounded-full bg-gold-500 animate-pulse" />
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.4em]">Strategic Control</span>
          </div>
          <h2 className="text-3xl font-black text-brand-900 dark:text-slate-100 uppercase tracking-tight flex items-center">
            <Globe className="mr-3 text-gold-500 w-8 h-8" size={32} /> Command Brief
          </h2>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Geographic Layer */}
        <div className="lg:col-span-8 space-y-8">
          <FleetHeatmap
            trips={stats.todayTripsList}
            apiKey={settings.googleMapsApiKey}
            theme={theme}
            mapIdLight={settings.googleMapsMapId}
            mapIdDark={settings.googleMapsMapIdDark}
          />
          <TemporalPulse trips={trips} />
          <AccountingPulse
            grossRevenue={accountingMetrics.grossCompletedRevenue}
            companyOwed={accountingMetrics.companyOwedToday}
            netAfterCompany={accountingMetrics.netAfterCompany}
            openBacklogUsd={accountingMetrics.openBacklogUsd}
            openBacklogCount={accountingMetrics.openBacklogCount}
            overdueOpenCount={accountingMetrics.overdueOpenCount}
            weeklyOpenUsd={accountingMetrics.weeklyOpenUsd}
            monthlyOpenUsd={accountingMetrics.monthlyOpenUsd}
            collectedTodayUsd={accountingMetrics.collectedTodayUsd}
                      cashSettledTodayUsd={accountingMetrics.cashSettledTodayUsd}
                      openCreditTripTodayUsd={accountingMetrics.openCreditTripTodayUsd}
                      receiptedTripTodayUsd={accountingMetrics.receiptedTripTodayUsd}
          />
        </div>

        {/* Intelligence Layer */}
        <div className="lg:col-span-4 space-y-8">
          <div className="bg-brand-900 rounded-[2.5rem] p-8 text-white shadow-2xl border border-brand-800 flex flex-col h-full min-h-[400px]">
            <div className="inline-flex items-center px-4 py-1.5 bg-gold-600 rounded-full text-[9px] font-black uppercase tracking-widest text-brand-950 shadow-lg shadow-gold-600/20 w-fit mb-8"><Sparkles size={14} className="mr-2" />System Synthesis</div>
            
            <div className="flex-1 flex flex-col justify-center">
              {isGeneratingAi ? (
                <div className="space-y-4">
                  <p className="text-xl font-black uppercase tracking-tighter animate-pulse">Computing Yield...</p>
                  <div className="h-1.5 w-full bg-brand-950 rounded-full overflow-hidden border border-white/5">
                    <div className="h-full bg-gold-500 transition-all duration-300" style={{ width: `${aiProgress}%` }} />
                  </div>
                </div>
              ) : aiInsightBullets ? (
                <div className="space-y-4">
                  <ul className="space-y-3">
                    {aiInsightBullets.map((line, index) => (
                      <li key={`insight-${index}`} className="text-sm font-bold leading-tight text-slate-50 flex items-start">
                        <span className="text-gold-500 mr-2 mt-0.5">•</span>
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="grid grid-cols-2 gap-2">
                    <Button type="button" variant="outline" onClick={handleCopyInsight} className="h-9 text-[9px] border-white/20 bg-white/5 text-white hover:bg-white/10">
                      {copiedInsight ? <Check size={12} className="mr-1.5" /> : <Copy size={12} className="mr-1.5" />}
                      {copiedInsight ? 'Done' : 'Copy'}
                    </Button>
                    <Button type="button" variant="gold" onClick={handleSendInsightToOperator} className="h-9 text-[9px]">
                      <MessageCircle size={12} className="mr-1.5" />
                      Send WA
                    </Button>
                  </div>
                  {insightActionStatus && (
                    <p role="status" aria-live="polite" className="text-[9px] font-black uppercase tracking-widest text-slate-300">
                      {insightActionStatus}
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <h3 className="text-2xl font-black tracking-tighter">Mission Intel</h3>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between p-4 bg-brand-950 rounded-2xl border border-white/5">
                       <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Fleet Load</span>
                       <span className="text-xl font-black text-gold-500">{stats.loadFactor}%</span>
                    </div>
                    <div className="flex items-center justify-between p-4 bg-brand-950 rounded-2xl border border-white/5">
                       <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Gross Yield</span>
                       <span className="text-xl font-black text-emerald-500">${stats.revenueToday}</span>
                    </div>
                      <div className="flex items-center justify-between p-4 bg-brand-950 rounded-2xl border border-white/5">
                        <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Company Owed</span>
                        <span className="text-xl font-black text-blue-400">${Math.round(accountingMetrics.companyOwedToday)}</span>
                      </div>
                      <div className="flex items-center justify-between p-4 bg-brand-950 rounded-2xl border border-white/5">
                        <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Open Backlog</span>
                        <span className="text-xl font-black text-amber-400">${Math.round(accountingMetrics.openBacklogUsd)}</span>
                      </div>
                      <div className="flex items-center justify-between p-4 bg-brand-950 rounded-2xl border border-white/5">
                        <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Collected Today</span>
                        <span className="text-xl font-black text-indigo-400">${Math.round(accountingMetrics.collectedTodayUsd)}</span>
                      </div>
                      <div className="flex items-center justify-between p-4 bg-brand-950 rounded-2xl border border-white/5">
                        <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Cash Settled</span>
                        <span className="text-xl font-black text-emerald-400">${Math.round(accountingMetrics.cashSettledTodayUsd)}</span>
                      </div>
                      <div className="flex items-center justify-between p-4 bg-brand-950 rounded-2xl border border-white/5">
                        <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Trip Credit Pending</span>
                        <span className="text-xl font-black text-amber-400">${Math.round(accountingMetrics.openCreditTripTodayUsd)}</span>
                      </div>
                  </div>
                </div>
              )}
            </div>
            
            <Button variant="gold" onClick={generateAiSummary} isLoading={isGeneratingAi} className="h-14 w-full shadow-2xl mt-8">Generate Synthesis</Button>
          </div>
        </div>
      </div>
    </div>
  );
};
