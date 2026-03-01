
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
  DISPATCH_NOW_MIN_MINUTES,
  DISPATCH_NOW_MAX_MINUTES,
} from '../constants';
import { 
  Sparkles, Globe, LocateFixed, Focus, Timer,
  Activity, Zap, Sun, Moon, Sunrise, Sunset, Copy, Check, MessageCircle, Briefcase, Receipt, Wallet, AlertTriangle, CheckCircle, AlertOctagon, FileText, Download
} from 'lucide-react';
import { format, isToday, parseISO, startOfDay, addHours, addMinutes, isSameHour, addDays } from 'date-fns';
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

const getFuelCostWeight = (responsibility?: Driver['fuelCostResponsibility']): number => {
  if (responsibility === 'DRIVER') return 0;
  if (responsibility === 'SHARED') return 0.5;
  return 1;
};

interface FleetYieldDriverRow {
  driverId: string;
  driverName: string;
  plateNumber: string;
  completedTrips: number;
  km: number;
  revenueUsd: number;
  revenuePerKm: number;
  fuelExpenseUsd: number;
  fuelResponsibilityPct: number;
  companyShareUsd: number;
  netYieldUsd: number;
  expensePerKm: number;
  yieldPerKm: number;
  fuelSource: 'ACTUAL' | 'ESTIMATED';
  fuelVarianceUsd: number;
  shareRuleLabel: string;
  distanceCoveragePct: number;
}

interface FleetYieldSummary {
  totalDrivers: number;
  driversWithActualFuelLogs: number;
  totalCompletedTrips: number;
  totalKm: number;
  totalRevenueUsd: number;
  totalFuelExpenseUsd: number;
  avgFuelResponsibilityPct: number;
  totalCompanyShareUsd: number;
  totalNetYieldUsd: number;
  totalDistanceCoveragePct: number;
}

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
  const cashCoverage = grossRevenue > 0 ? Math.round((collectedTodayUsd / grossRevenue) * 100) : 0;
  const backlogLoad = grossRevenue > 0 ? Math.round((openBacklogUsd / grossRevenue) * 100) : (openBacklogUsd > 0 ? 100 : 0);
  const solvencySignal = Math.max(0, Math.min(100, Math.round(100 - backlogLoad + Math.min(cashCoverage, 35))));

  const solvencyTone = solvencySignal >= 75
    ? { label: 'Strong', text: 'text-emerald-600 dark:text-emerald-300', bg: 'bg-emerald-50 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-900/40', bar: 'bg-emerald-500' }
    : solvencySignal >= 45
      ? { label: 'Balanced', text: 'text-amber-600 dark:text-amber-300', bg: 'bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-900/40', bar: 'bg-amber-500' }
      : { label: 'Stressed', text: 'text-red-600 dark:text-red-300', bg: 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-900/40', bar: 'bg-red-500' };

  return (
    <div id="gm-accounting-visualizer" className="bg-white dark:bg-brand-900 rounded-[2.5rem] p-6 md:p-8 border border-slate-200 dark:border-white/5 shadow-xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[10px] font-black uppercase tracking-[0.35em] text-slate-400">Accounting Visualizer</h3>
          <p className="text-sm font-black text-brand-900 dark:text-white uppercase tracking-tight">Yield · Credit · Backlog</p>
        </div>
        <div className="inline-flex items-center h-8 px-3 rounded-lg border border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 text-[8px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300">
          Live
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className={`rounded-2xl border p-4 ${solvencyTone.bg}`}>
          <p className={`text-[8px] font-black uppercase tracking-widest inline-flex items-center gap-1 ${solvencyTone.text}`}><Wallet size={10} /> Solvency Pulse</p>
          <p className={`text-xl font-black mt-1 ${solvencyTone.text}`}>{solvencySignal}%</p>
          <p className={`text-[8px] font-black uppercase tracking-widest mt-1 ${solvencyTone.text}`}>{solvencyTone.label}</p>
          <div className="h-1.5 rounded-full bg-white/70 dark:bg-brand-950/70 mt-2 overflow-hidden">
            <div className={`h-full ${solvencyTone.bar}`} style={{ width: `${solvencySignal}%` }} />
          </div>
        </div>

        <div className="rounded-2xl border border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 p-4">
          <p className="text-[8px] font-black uppercase tracking-widest inline-flex items-center gap-1 text-blue-700 dark:text-blue-300"><CheckCircle size={10} /> Cash Coverage</p>
          <p className="text-xl font-black text-blue-700 dark:text-blue-300 mt-1">{cashCoverage}%</p>
          <p className="text-[8px] font-black uppercase tracking-widest text-blue-600/80 dark:text-blue-200/80 mt-1">Collected vs Completed</p>
          <div className="h-1.5 rounded-full bg-white/70 dark:bg-brand-950/70 mt-2 overflow-hidden">
            <div className="h-full bg-blue-500" style={{ width: `${Math.max(0, Math.min(100, cashCoverage))}%` }} />
          </div>
        </div>

        <div className="rounded-2xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 p-4">
          <p className="text-[8px] font-black uppercase tracking-widest inline-flex items-center gap-1 text-amber-700 dark:text-amber-300"><AlertTriangle size={10} /> Backlog Load</p>
          <p className="text-xl font-black text-amber-700 dark:text-amber-300 mt-1">{backlogLoad}%</p>
          <p className="text-[8px] font-black uppercase tracking-widest text-amber-600/80 dark:text-amber-200/80 mt-1">Open credit pressure</p>
          <div className="h-1.5 rounded-full bg-white/70 dark:bg-brand-950/70 mt-2 overflow-hidden">
            <div className="h-full bg-amber-500" style={{ width: `${Math.max(0, Math.min(100, backlogLoad))}%` }} />
          </div>
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
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 inline-flex items-center gap-1"><CheckCircle size={10} /> Cash Settled (Trips)</p>
          <p className="text-xl font-black text-emerald-600 mt-1">${Math.round(cashSettledTodayUsd)}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 inline-flex items-center gap-1"><AlertOctagon size={10} /> Open Credit (Trips)</p>
          <p className="text-xl font-black text-amber-600 mt-1">${Math.round(openCreditTripTodayUsd)}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 inline-flex items-center gap-1"><FileText size={10} /> Receipted (Trips)</p>
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

const FleetYieldPulse: React.FC<{ rows: FleetYieldDriverRow[]; summary: FleetYieldSummary }> = ({ rows, summary }) => {
  const [driverSearch, setDriverSearch] = useState('');
  const [showDriverSuggestions, setShowDriverSuggestions] = useState(false);
  const actualFuelCoverage = summary.totalDrivers > 0
    ? Math.round((summary.driversWithActualFuelLogs / summary.totalDrivers) * 100)
    : 0;

  const driverSuggestions = useMemo(() => {
    const query = driverSearch.trim().toLowerCase();
    const pool = rows.map(row => ({
      id: row.driverId,
      driverName: row.driverName,
      plateNumber: row.plateNumber,
      searchable: `${row.driverName} ${row.plateNumber}`.toLowerCase(),
    }));

    if (!query) return pool.slice(0, 6);
    return pool.filter(entry => entry.searchable.includes(query)).slice(0, 8);
  }, [rows, driverSearch]);

  const filteredRows = useMemo(() => {
    const query = driverSearch.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter(row =>
      row.driverName.toLowerCase().includes(query) ||
      row.plateNumber.toLowerCase().includes(query)
    );
  }, [rows, driverSearch]);

  const escapeCsvCell = (value: string | number): string => {
    const raw = String(value ?? '');
    if (!/[",\n]/.test(raw)) return raw;
    return `"${raw.replace(/"/g, '""')}"`;
  };

  const exportFleetYieldCsv = () => {
    if (filteredRows.length === 0) return;

    const generatedAt = new Date();
    const headers = [
      'Driver',
      'Plate',
      'Completed Trips',
      'KM',
      'Revenue USD',
      'Revenue per KM USD',
      'Fuel Expense USD',
      'Company Fuel Responsibility %',
      'Company Share USD',
      'Net Yield USD',
      'Expense per KM USD',
      'Yield per KM USD',
      'Fuel Source',
      'Fuel Variance vs Estimate USD',
      'Share Rule',
      'Distance Coverage %',
    ];

    const rowLines = filteredRows.map(row => [
      row.driverName,
      row.plateNumber,
      row.completedTrips,
      row.km.toFixed(2),
      row.revenueUsd.toFixed(2),
      row.revenuePerKm.toFixed(4),
      row.fuelExpenseUsd.toFixed(2),
      row.fuelResponsibilityPct,
      row.companyShareUsd.toFixed(2),
      row.netYieldUsd.toFixed(2),
      row.expensePerKm.toFixed(4),
      row.yieldPerKm.toFixed(4),
      row.fuelSource,
      row.fuelVarianceUsd.toFixed(2),
      row.shareRuleLabel,
      row.distanceCoveragePct,
    ].map(escapeCsvCell).join(','));

    const summaryLine = [
      'TOTAL',
      '-',
      summary.totalCompletedTrips,
      summary.totalKm.toFixed(2),
      summary.totalRevenueUsd.toFixed(2),
      summary.totalKm > 0 ? (summary.totalRevenueUsd / summary.totalKm).toFixed(4) : '0.0000',
      summary.totalFuelExpenseUsd.toFixed(2),
      summary.avgFuelResponsibilityPct,
      summary.totalCompanyShareUsd.toFixed(2),
      summary.totalNetYieldUsd.toFixed(2),
      summary.totalKm > 0 ? (summary.totalFuelExpenseUsd / summary.totalKm).toFixed(4) : '0.0000',
      summary.totalKm > 0 ? (summary.totalNetYieldUsd / summary.totalKm).toFixed(4) : '0.0000',
      'MIXED',
      '-',
      '-',
      summary.totalDistanceCoveragePct,
    ].map(escapeCsvCell).join(',');

    const csvContent = [
      `Generated At,${escapeCsvCell(format(generatedAt, 'yyyy-MM-dd HH:mm:ss'))}`,
      `Actual Fuel Logs Coverage,${escapeCsvCell(`${actualFuelCoverage}%`)}`,
      headers.map(escapeCsvCell).join(','),
      ...rowLines,
      summaryLine,
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `fleet-yield-${format(generatedAt, 'yyyyMMdd-HHmm')}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const confidenceTone = actualFuelCoverage >= 70
    ? { label: 'Verified', tone: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-50 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-900/40' }
    : actualFuelCoverage >= 35
      ? { label: 'Mixed', tone: 'text-amber-700 dark:text-amber-300', bg: 'bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-900/40' }
      : { label: 'Estimated', tone: 'text-red-700 dark:text-red-300', bg: 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-900/40' };

  return (
    <div id="gm-fleet-yield-visualizer" className="bg-white dark:bg-brand-900 rounded-[2.5rem] p-6 md:p-8 border border-slate-200 dark:border-white/5 shadow-xl space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[10px] font-black uppercase tracking-[0.35em] text-slate-400">Fleet Yield Visualizer</h3>
          <p className="text-sm font-black text-brand-900 dark:text-white uppercase tracking-tight">KM vs Expense by Driver</p>
        </div>
        <div className="flex items-center gap-2">
          <div className={`inline-flex items-center h-8 px-3 rounded-lg border text-[8px] font-black uppercase tracking-widest ${confidenceTone.bg} ${confidenceTone.tone}`}>
            {confidenceTone.label}
          </div>
          <Button onClick={exportFleetYieldCsv} disabled={filteredRows.length === 0} className="h-8 px-3 text-[8px]">
            Export CSV
          </Button>
        </div>
      </div>

      <div className="relative rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-3">
        <input
          type="text"
          value={driverSearch}
          onChange={event => {
            setDriverSearch(event.target.value);
            setShowDriverSuggestions(true);
          }}
          onFocus={() => setShowDriverSuggestions(true)}
          onBlur={() => {
            window.setTimeout(() => setShowDriverSuggestions(false), 120);
          }}
          placeholder="Find driver or plate..."
          className="w-full h-9 rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 px-3 text-[10px] font-black uppercase tracking-widest text-brand-900 dark:text-white outline-none focus:ring-2 focus:ring-gold-500"
        />
        {showDriverSuggestions && driverSuggestions.length > 0 && (
          <div className="absolute left-3 right-3 top-[calc(100%+0.35rem)] z-20 rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 shadow-xl overflow-hidden">
            {driverSuggestions.map(suggestion => (
              <button
                key={`fy-suggestion-${suggestion.id}`}
                type="button"
                onMouseDown={event => event.preventDefault()}
                onClick={() => {
                  setDriverSearch(`${suggestion.driverName} ${suggestion.plateNumber}`);
                  setShowDriverSuggestions(false);
                }}
                className="w-full px-3 py-2 text-left border-b last:border-b-0 border-slate-100 dark:border-brand-800 hover:bg-slate-50 dark:hover:bg-brand-950 transition-colors"
              >
                <p className="text-[10px] font-black text-brand-900 dark:text-white uppercase tracking-wide">{suggestion.driverName}</p>
                <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest">{suggestion.plateNumber}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Fleet KM</p>
          <p className="text-xl font-black text-brand-900 dark:text-white mt-1">{Math.round(summary.totalKm).toLocaleString()}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Company Fuel Expense</p>
          <p className="text-xl font-black text-amber-600 mt-1">${Math.round(summary.totalFuelExpenseUsd)}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Company Share</p>
          <p className="text-xl font-black text-blue-600 mt-1">${Math.round(summary.totalCompanyShareUsd)}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Net Yield</p>
          <p className="text-xl font-black text-emerald-600 mt-1">${Math.round(summary.totalNetYieldUsd)}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[8px] font-black uppercase tracking-widest text-slate-500">
          <span>Trips {summary.totalCompletedTrips}</span>
          <span>Distance Coverage {summary.totalDistanceCoveragePct}%</span>
          <span>Avg Company Fuel Scope {summary.avgFuelResponsibilityPct}%</span>
          <span>Actual Fuel Logs {actualFuelCoverage}%</span>
          <span>Estimated KM/L = 10</span>
        </div>
      </div>

      <div className="space-y-2 max-h-[320px] overflow-auto pr-1">
        {filteredRows.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4 text-[9px] font-black uppercase tracking-widest text-slate-500">
            {rows.length === 0 ? 'No completed missions for this window.' : 'No drivers match this search.'}
          </div>
        ) : filteredRows.map(row => (
          <div key={row.driverId} className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-black text-brand-900 dark:text-white uppercase tracking-wide">{row.driverName}</p>
                <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest">{row.plateNumber} · {row.shareRuleLabel}</p>
              </div>
              <span className={`h-6 px-2 rounded-lg border text-[7px] font-black uppercase tracking-widest inline-flex items-center ${row.fuelSource === 'ACTUAL' ? 'border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10' : 'border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-900/40 dark:text-amber-300 dark:bg-amber-900/10'}`}>
                {row.fuelSource}
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[8px] font-black uppercase tracking-widest text-slate-500">
              <span>Trips {row.completedTrips}</span>
              <span>KM {Math.round(row.km)}</span>
              <span>Rev/KM ${row.revenuePerKm.toFixed(2)}</span>
              <span>Exp/KM ${row.expensePerKm.toFixed(2)}</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[8px] font-black uppercase tracking-widest">
              <span className="text-rose-600 dark:text-rose-300">Fuel Scope {row.fuelResponsibilityPct}%</span>
              <span className="text-blue-600 dark:text-blue-300">Share ${Math.round(row.companyShareUsd)}</span>
              <span className="text-amber-600 dark:text-amber-300">Fuel ${Math.round(row.fuelExpenseUsd)}</span>
              <span className="text-emerald-600 dark:text-emerald-300">Yield ${Math.round(row.netYieldUsd)}</span>
            </div>
            <div className="text-[8px] font-black uppercase tracking-widest text-indigo-600 dark:text-indigo-300">Yield/KM ${row.yieldPerKm.toFixed(2)}</div>
            <div className="text-[7px] font-black uppercase tracking-widest text-slate-400">
              Distance coverage {row.distanceCoveragePct}% · Company-accountable fuel variance vs estimate ${Math.round(row.fuelVarianceUsd)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const TemporalPulse: React.FC<{ trips: Trip[]; isFullscreen?: boolean }> = ({ trips, isFullscreen = false }) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [windowMode, setWindowMode] = useState<'6h' | '24h' | '7d'>('24h');
  const [clockTick, setClockTick] = useState(() => Date.now());
  const [dataUpdatedAt, setDataUpdatedAt] = useState(() => Date.now());
  const [viewNow, setViewNow] = useState(() => Date.now());
  const nowDate = useMemo(() => new Date(clockTick), [clockTick]);
  const currentHour = nowDate.getHours();

  useEffect(() => {
    const interval = window.setInterval(() => {
      const nextTick = Date.now();
      setClockTick(nextTick);
      setDataUpdatedAt(nextTick);
    }, 30000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setViewNow(Date.now());
    }, 5000);
    return () => window.clearInterval(interval);
  }, []);

  const telemetryTrips = useMemo(() => {
    const now = new Date(clockTick);
    const lookbackMs = windowMode === '6h'
      ? 6 * 60 * 60 * 1000
      : windowMode === '24h'
        ? 24 * 60 * 60 * 1000
        : 7 * 24 * 60 * 60 * 1000;
    const windowStart = new Date(now.getTime() - lookbackMs);

    return trips.filter(t => {
      const date = t.tripDate ? parseISO(t.tripDate) : parseISO(t.createdAt);
      return Number.isFinite(date.getTime()) && date >= windowStart && date <= now;
    });
  }, [trips, windowMode, clockTick]);

  const bucketData = useMemo(() => {
    const now = new Date(clockTick);

    if (windowMode === '7d') {
      const buckets = Array.from({ length: 7 }, (_, index) => {
        const start = startOfDay(addDays(now, -6 + index));
        const end = addDays(start, 1);
        return {
          key: index,
          count: 0,
          start,
          end,
          label: format(start, 'EEE'),
          tooltipLabel: format(start, 'EEE, MMM d'),
          isCurrent: isToday(start),
        };
      });

      telemetryTrips.forEach(t => {
        const stamp = t.tripDate ? parseISO(t.tripDate) : parseISO(t.createdAt);
        const matchedIndex = buckets.findIndex(bucket => stamp >= bucket.start && stamp < bucket.end);
        if (matchedIndex >= 0) {
          buckets[matchedIndex].count += 1;
        }
      });

      const maxCount = Math.max(...buckets.map(entry => entry.count), 1);
      return {
        maxCount,
        entries: buckets.map(entry => ({
          ...entry,
          percentage: (entry.count / maxCount) * 100,
        })),
      };
    }

    const bucketCount = windowMode === '6h' ? 6 : 24;
    const buckets = Array.from({ length: bucketCount }, (_, index) => {
      const start = addHours(now, -(bucketCount - 1 - index));
      const slotStart = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), 0, 0, 0);
      const slotEnd = addHours(slotStart, 1);
      return {
        key: index,
        count: 0,
        start: slotStart,
        end: slotEnd,
        label: format(slotStart, 'ha'),
        tooltipLabel: format(slotStart, 'EEE h:mm a'),
        isCurrent: isSameHour(slotStart, now),
      };
    });

    telemetryTrips.forEach(t => {
      const stamp = t.tripDate ? parseISO(t.tripDate) : parseISO(t.createdAt);
      const matchedIndex = buckets.findIndex(bucket => stamp >= bucket.start && stamp < bucket.end);
      if (matchedIndex >= 0) {
        buckets[matchedIndex].count += 1;
      }
    });

    const maxCount = Math.max(...buckets.map(entry => entry.count), 1);
    return {
      maxCount,
      entries: buckets.map(entry => ({
        ...entry,
        percentage: (entry.count / maxCount) * 100,
      })),
    };
  }, [telemetryTrips, windowMode, clockTick]);

  const peakBucket = useMemo(() => {
    return [...bucketData.entries].sort((a, b) => b.count - a.count)[0] || null;
  }, [bucketData.entries]);

  const telemetrySignals = useMemo(() => {
    const activeBuckets = bucketData.entries.filter(entry => entry.count > 0).length;
    const totalMissions = telemetryTrips.length;
    const peakShare = totalMissions > 0 && peakBucket ? peakBucket.count / totalMissions : 0;

    const stability = totalMissions === 0
      ? 'Idle'
      : peakShare > 0.45
        ? 'Spike-Prone'
        : activeBuckets < Math.max(3, Math.round(bucketData.entries.length * 0.25))
          ? 'Sparse'
          : 'Balanced';

    const peakLabel = peakBucket
      ? (windowMode === '7d' ? peakBucket.tooltipLabel : peakBucket.label)
      : 'N/A';

    return {
      activeBuckets,
      totalMissions,
      stability,
      peakLabel,
    };
  }, [bucketData.entries, telemetryTrips, peakBucket, windowMode]);

  const nowWindowMissions = useMemo(() => {
    const now = new Date();
    const windowStart = addMinutes(now, DISPATCH_NOW_MIN_MINUTES);
    const windowEnd = addMinutes(now, DISPATCH_NOW_MAX_MINUTES);

    return trips.filter(trip => {
      if (trip.status === TripStatus.CANCELLED || trip.status === TripStatus.COMPLETED) return false;
      const scheduled = trip.tripDate ? parseISO(trip.tripDate) : parseISO(trip.createdAt);
      if (!Number.isFinite(scheduled.getTime())) return false;
      return scheduled >= windowStart && scheduled <= windowEnd;
    }).length;
  }, [trips]);

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

  const getTimeIcon = (date: Date) => {
    const hour = date.getHours();
    if (hour >= 5 && hour < 11) return <Sunrise size={10} className="text-orange-400" />;
    if (hour >= 11 && hour < 17) return <Sun size={10} className="text-gold-500" />;
    if (hour >= 17 && hour < 21) return <Sunset size={10} className="text-rose-400" />;
    return <Moon size={10} className="text-blue-400" />;
  };

  const coverageLabel = trafficTelemetry.coverage === 0
    ? 'No Data'
    : trafficTelemetry.coverage < 35
      ? 'Low'
      : trafficTelemetry.coverage < 70
        ? 'Medium'
        : 'High';

  const lastUpdatedLabel = useMemo(() => {
    const deltaSeconds = Math.max(0, Math.round((viewNow - dataUpdatedAt) / 1000));
    if (deltaSeconds < 15) return 'Updated just now';
    if (deltaSeconds < 60) return `Updated ${deltaSeconds}s ago`;
    return `Updated ${Math.round(deltaSeconds / 60)}m ago`;
  }, [dataUpdatedAt, viewNow]);

  const focusedIndex = selectedIndex ?? hoveredIndex;

  useEffect(() => {
    setSelectedIndex(null);
    setHoveredIndex(null);
  }, [windowMode]);

  return (
    <div className="bg-white dark:bg-brand-900 rounded-[2.5rem] p-6 md:p-8 border border-slate-200 dark:border-white/5 shadow-xl space-y-8 overflow-x-hidden overflow-y-visible">
      {/* Header Info */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex items-center space-x-4">
          <div className="p-3 bg-brand-950 text-gold-500 rounded-2xl border border-white/5 shadow-inner">
            <Timer size={20} />
          </div>
          <div>
            <h3 className="text-[11px] font-black uppercase tracking-[0.3em] text-slate-400">Intensity Matrix</h3>
            <p className="text-base font-black text-brand-900 dark:text-white uppercase tracking-wide">Rolling Temporal Distribution</p>
            <p className="text-[10px] font-black text-slate-500 dark:text-slate-300 uppercase tracking-[0.2em] mt-1">{windowMode} Window · {lastUpdatedLabel}</p>
          </div>
        </div>
        
        <div className="flex items-center space-x-4 bg-slate-50 dark:bg-brand-950/50 p-2 rounded-2xl border border-slate-100 dark:border-white/5">
          <div className="px-3 py-1 text-right">
            <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest block">Peak Mission Volume</span>
            <span className="text-sm font-black text-gold-600">{telemetrySignals.peakLabel}</span>
            <span className="text-[9px] font-black text-slate-500 dark:text-slate-300 uppercase tracking-[0.15em] block mt-0.5">{peakBucket ? `${peakBucket.count} missions` : '0 missions'}</span>
          </div>
          <div className="h-8 w-px bg-slate-200 dark:bg-brand-800" />
          <div className="px-3 py-1">
             <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest block">Live Status</span>
             <div className="flex items-center space-x-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
               <span className="text-[10px] font-black uppercase text-emerald-500">{telemetrySignals.totalMissions > 0 ? 'Telemetry Online' : 'Telemetry Idle'}</span>
             </div>
             <span className="text-[8px] font-black text-slate-500 dark:text-slate-300 uppercase tracking-widest block mt-1">TI {trafficTelemetry.avgIndex} · Delay {trafficTelemetry.avgDelay}m · Coverage {coverageLabel} ({trafficTelemetry.coverage}%)</span>
             <span className="text-[8px] font-black text-slate-500 dark:text-slate-300 uppercase tracking-widest block mt-1">Now Window {DISPATCH_NOW_MIN_MINUTES}-{DISPATCH_NOW_MAX_MINUTES}m · {nowWindowMissions} missions</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {(['6h', '24h', '7d'] as const).map(mode => {
          const active = windowMode === mode;
          return (
            <button
              key={mode}
              type="button"
              onClick={() => setWindowMode(mode)}
              className={`h-8 px-3 rounded-xl border text-[9px] font-black uppercase tracking-[0.2em] transition-all whitespace-nowrap ${
                active
                  ? 'border-gold-400 bg-gold-500/10 text-gold-600 dark:text-gold-300'
                  : 'border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-300 hover:border-gold-300/50 hover:text-gold-500'
              }`}
              aria-pressed={active}
            >
              {mode}
            </button>
          );
        })}
      </div>

      {/* Visual Chart Area */}
      <div className="relative pt-3 pb-2 overflow-x-hidden">
        {/* Background Grid Lines */}
        <div className="absolute inset-0 flex flex-col justify-between pointer-events-none border-b border-slate-100 dark:border-white/5 h-40">
           <div className="w-full border-t border-slate-50 dark:border-white/5 opacity-50" />
           <div className="w-full border-t border-slate-50 dark:border-white/5 opacity-50" />
           <div className="w-full border-t border-slate-50 dark:border-white/5 opacity-50" />
        </div>

        <div className="absolute right-0 top-0 pointer-events-none flex flex-col items-end gap-9 text-[8px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 pr-1">
          <span>{bucketData.maxCount}</span>
          <span>{Math.round(bucketData.maxCount / 2)}</span>
          <span>0</span>
        </div>

        <div className="flex items-end justify-between h-40 gap-0.5 sm:gap-1.5 group/bars w-full pr-7">
          {bucketData.entries.map((data, index) => {
            const isCurrent = data.isCurrent;
            const isPeak = Boolean(peakBucket) && data.key === peakBucket.key;
            const isHovered = hoveredIndex === index;
            const isSelected = selectedIndex === index;
            const showTooltip = focusedIndex !== null ? focusedIndex === index : isCurrent;
            const tooltipPositionClass = index <= 1
              ? 'left-0 translate-x-0'
              : index >= bucketData.entries.length - 2
                ? 'right-0 translate-x-0'
                : 'left-1/2 -translate-x-1/2';

            return (
              <button
                key={`${data.key}-${data.label}`}
                type="button"
                className="flex-1 min-w-0 flex flex-col items-center group relative h-full justify-end cursor-pointer focus-visible:outline-none"
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() => setHoveredIndex(null)}
                onFocus={() => setHoveredIndex(index)}
                onBlur={() => setHoveredIndex(null)}
                onClick={() => setSelectedIndex(prev => (prev === index ? null : index))}
                aria-label={`${data.tooltipLabel} ${data.count} missions`}
                aria-pressed={isSelected}
              >
                {/* Active Tooltip / Indicator */}
                {showTooltip && (
                  <div className={`absolute top-0 bg-brand-950 text-white p-2 rounded-xl shadow-2xl z-50 border border-white/10 animate-in fade-in zoom-in-95 duration-200 ${tooltipPositionClass}`}>
                    <div className="flex flex-col items-center min-w-[60px]">
                      <span className="text-[8px] font-black text-gold-500 uppercase tracking-widest mb-0.5">
                        {data.tooltipLabel}
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
                        : isSelected
                          ? 'bg-gradient-to-t from-blue-700 to-blue-400 shadow-[0_0_10px_rgba(96,165,250,0.25)]'
                          : 'bg-brand-100 dark:bg-brand-800/50 group-hover:bg-brand-200 dark:group-hover:bg-brand-700'
                  }`}
                  style={{ height: `${Math.max(data.percentage, 4)}%` }}
                >
                  {/* Subtle Scanline Effect on Bars */}
                  <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:100%_4px] pointer-events-none" />
                </div>

                {/* X-Axis Label */}
                <div className={`mt-3 flex flex-col items-center space-y-1 transition-opacity duration-300 ${isFullscreen || bucketData.entries.length <= 7 || index % 3 === 0 || isHovered || isCurrent || isSelected ? 'opacity-100' : 'opacity-30'}`}>
                   {getTimeIcon(data.start)}
                   <span className="text-[7px] sm:text-[8px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                    {windowMode === '7d' ? (
                      <>
                        <span className="sm:hidden">{format(data.start, 'EEEEE')}</span>
                        <span className="hidden sm:inline">{data.label}</span>
                      </>
                    ) : data.label}
                   </span>
                </div>
                
                {/* Live Dot */}
                {isCurrent && (
                  <div className="absolute -bottom-6 w-1 h-1 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,1)]" />
                )}
              </button>
            );
          })}
        </div>
      </div>
      
      {/* Footer Meta */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-6 border-t border-slate-100 dark:border-white/5">
         <div className="flex items-center space-x-3">
            <div className="p-1.5 bg-emerald-50 dark:bg-emerald-500/10 rounded-lg"><Activity size={12} className="text-emerald-500" /></div>
          <span className="text-[10px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-[0.18em]">Operational Stability: {telemetrySignals.stability}</span>
         </div>
         <div className="flex items-center space-x-3 sm:justify-end">
            <div className="p-1.5 bg-gold-50 dark:bg-gold-500/10 rounded-lg"><Zap size={12} className="text-gold-500" /></div>
          <span className="text-[10px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-[0.18em]">Peak Bucket: {telemetrySignals.peakLabel} · {telemetrySignals.totalMissions} Missions ({windowMode})</span>
         </div>
      </div>
    </div>
  );
};

const FleetHeatmap: React.FC<{ trips: Trip[], apiKey: string, theme: string, mapIdLight?: string, mapIdDark?: string }> = ({ trips, apiKey, theme, mapIdLight, mapIdDark }) => {
  const mapRef = useRef<HTMLDivElement>(null);
  const [mapsLoaded, setMapsLoaded] = useState(false);
  const [timePulse, setTimePulse] = useState(() => Date.now());
  const [forecastRouteVersion, setForecastRouteVersion] = useState(0);
  const [layerCounts, setLayerCounts] = useState({
    pickup: 0,
    transit: 0,
    destination: 0,
    stopWaypoints: 0,
    forecastQuoted: 0,
    forecastActive: 0,
  });
  const mapInstance = useRef<any>(null);
  const densityLayers = useRef<any[]>([]);
  const stopWaypointLayers = useRef<any[]>([]);
  const routeForecastLayers = useRef<any[]>([]);
  const forecastRoadCache = useRef<Map<string, Array<{ lat: number; lng: number }>>>(new Map());
  const forecastRoadInFlight = useRef<Set<string>>(new Set());
  const forecastRoadDisabled = useRef(false);

  type MapPoint = { lat: number; lng: number };
  type OperationalPhase = 'pickup' | 'transit' | 'destination';

  const PHASE_COLORS: Record<OperationalPhase, string> = {
    pickup: '#f59e0b',
    transit: '#c026d3',
    destination: '#2563eb',
  };
  const STOP_WAYPOINT_COLOR = '#14b8a6';
  const FORECAST_QUOTED_COLOR = '#f59e0b';
  const FORECAST_ACTIVE_COLOR = '#c026d3';

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

  const resolveTripPoint = (trip: Trip, type: 'pickup' | 'destination'): MapPoint | null => {
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

  const resolveStopPoint = (stop?: Trip['stops'][number]): MapPoint | null => {
    if (!stop) return null;
    if (Number.isFinite(stop.lat) && Number.isFinite(stop.lng)) {
      return { lat: Number(stop.lat), lng: Number(stop.lng) };
    }
    const fromLink = parseGoogleMapsLink(stop.originalLink || '');
    if (fromLink) return { lat: fromLink.lat, lng: fromLink.lng };
    return parseLatLngFromText(stop.text);
  };

  const resolveRoutePoints = (trip: Trip): MapPoint[] => {
    const pickupPoint = resolveTripPoint(trip, 'pickup');
    const destinationPoint = resolveTripPoint(trip, 'destination');
    const stopPoints = (trip.stops || [])
      .map(stop => resolveStopPoint(stop))
      .filter((point): point is MapPoint => Boolean(point));

    return [pickupPoint, ...stopPoints, destinationPoint].filter((point): point is MapPoint => Boolean(point));
  };

  const buildForecastCacheKey = (trip: Trip, routePoints: MapPoint[]): string => {
    const compactPoints = routePoints
      .map(point => `${point.lat.toFixed(4)}|${point.lng.toFixed(4)}`)
      .join('>');
    return `${trip.id}:${trip.status}:${compactPoints}`;
  };

  const getNearestPathIndex = (path: Array<{ lat: number; lng: number }>, point: MapPoint): number => {
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;

    path.forEach((entry, index) => {
      const latDelta = entry.lat - point.lat;
      const lngDelta = entry.lng - point.lng;
      const distance = latDelta * latDelta + lngDelta * lngDelta;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });

    return nearestIndex;
  };

  const decodePolylinePath = (encoded: string): Array<{ lat: number; lng: number }> => {
    const points: Array<{ lat: number; lng: number }> = [];
    let index = 0;
    let lat = 0;
    let lng = 0;

    while (index < encoded.length) {
      let result = 0;
      let shift = 0;
      let byte = 0;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
      lat += dlat;

      result = 0;
      shift = 0;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
      lng += dlng;

      points.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }

    return points;
  };

  const requestRoadForecastPath = async (trip: Trip, routePoints: MapPoint[], cacheKey: string) => {
    if (forecastRoadDisabled.current || routePoints.length < 2 || !apiKey) return;
    if (forecastRoadCache.current.has(cacheKey) || forecastRoadInFlight.current.has(cacheKey)) return;

    const origin = routePoints[0];
    const destination = routePoints[routePoints.length - 1];
    const waypointPoints = routePoints.slice(1, -1);

    forecastRoadInFlight.current.add(cacheKey);

    try {
      const intermediates = waypointPoints.map(point => ({
        location: {
          latLng: {
            latitude: point.lat,
            longitude: point.lng,
          },
        },
      }));

      const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'routes.polyline.encodedPolyline',
        },
        body: JSON.stringify({
          origin: {
            location: {
              latLng: {
                latitude: origin.lat,
                longitude: origin.lng,
              },
            },
          },
          destination: {
            location: {
              latLng: {
                latitude: destination.lat,
                longitude: destination.lng,
              },
            },
          },
          ...(intermediates.length > 0 ? { intermediates } : {}),
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_AWARE',
          languageCode: 'en-US',
          units: 'METRIC',
        }),
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          forecastRoadDisabled.current = true;
        }
        return;
      }

      const payload = await response.json();
      const encoded = payload?.routes?.[0]?.polyline?.encodedPolyline;
      if (typeof encoded !== 'string' || encoded.length < 2) return;

      const roadPath = decodePolylinePath(encoded);
      if (roadPath.length < 2) return;

      forecastRoadCache.current.set(cacheKey, roadPath);
      setForecastRouteVersion(prev => prev + 1);
    } catch {
      // Keep straight-line fallback silently.
    } finally {
      forecastRoadInFlight.current.delete(cacheKey);
    }
  };

  const interpolatePoint = (from: MapPoint, to: MapPoint, ratio: number): MapPoint => ({
    lat: from.lat + (to.lat - from.lat) * ratio,
    lng: from.lng + (to.lng - from.lng) * ratio,
  });

  const distanceKmBetween = (from: MapPoint, to: MapPoint): number => {
    const toRadians = (value: number) => (value * Math.PI) / 180;
    const earthRadiusKm = 6371;
    const latDelta = toRadians(to.lat - from.lat);
    const lngDelta = toRadians(to.lng - from.lng);
    const fromLatRad = toRadians(from.lat);
    const toLatRad = toRadians(to.lat);

    const a =
      Math.sin(latDelta / 2) * Math.sin(latDelta / 2) +
      Math.sin(lngDelta / 2) * Math.sin(lngDelta / 2) * Math.cos(fromLatRad) * Math.cos(toLatRad);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusKm * c;
  };

  const getOperationalWeight = (trip: Trip): number => {
    if (trip.status === TripStatus.CONFIRMED) return 1.25;
    if (trip.status === TripStatus.COMPLETED) return 0.95;
    if (trip.status === TripStatus.QUOTED) return 1.0;
    return 0.8;
  };

  const resolveOperationalPoint = (trip: Trip): { point: MapPoint; phase: OperationalPhase; weight: number; nextRouteIndex: number; routePoints: MapPoint[] } | null => {
    const pickupPoint = resolveTripPoint(trip, 'pickup');
    const routePoints = resolveRoutePoints(trip);
    if (routePoints.length === 0) return null;
    const weight = getOperationalWeight(trip);

    if (trip.status === TripStatus.CANCELLED || trip.status === TripStatus.QUOTED) {
      return { point: pickupPoint || routePoints[0], phase: 'pickup', weight, nextRouteIndex: routePoints.length > 1 ? 1 : 0, routePoints };
    }

    if (trip.status === TripStatus.COMPLETED) {
      return { point: routePoints[routePoints.length - 1], phase: 'destination', weight, nextRouteIndex: routePoints.length - 1, routePoints };
    }

    const startMs = trip.tripDate ? new Date(trip.tripDate).getTime() : Number.NaN;
    const durationMin = Number.isFinite(trip.durationInTrafficMin) && trip.durationInTrafficMin > 0
      ? Number(trip.durationInTrafficMin)
      : (Number.isFinite(trip.durationMin) && trip.durationMin > 0 ? Number(trip.durationMin) : 30);

    if (!Number.isFinite(startMs) || routePoints.length === 1) {
      return { point: pickupPoint || routePoints[0], phase: 'pickup', weight, nextRouteIndex: routePoints.length > 1 ? 1 : 0, routePoints };
    }

    const endMs = startMs + durationMin * 60 * 1000;
    const nowMs = timePulse;

    if (nowMs <= startMs) return { point: pickupPoint || routePoints[0], phase: 'pickup', weight, nextRouteIndex: routePoints.length > 1 ? 1 : 0, routePoints };
    if (nowMs >= endMs) return { point: routePoints[routePoints.length - 1], phase: 'destination', weight, nextRouteIndex: routePoints.length - 1, routePoints };

    const progress = Math.max(0, Math.min(1, (nowMs - startMs) / Math.max(1, endMs - startMs)));
    const segmentCount = routePoints.length - 1;
    if (segmentCount <= 0) {
      return { point: routePoints[0], phase: 'pickup', weight, nextRouteIndex: 0, routePoints };
    }

    const segmentDistances = routePoints.slice(0, -1).map((point, index) => distanceKmBetween(point, routePoints[index + 1]));
    const fallbackTotalDistance = Math.max(0.001, segmentDistances.reduce((sum, km) => sum + km, 0));
    const plannedDistanceKm = Number.isFinite(trip.distanceKm) && Number(trip.distanceKm) > 0
      ? Number(trip.distanceKm)
      : fallbackTotalDistance;
    const distanceTargetKm = Math.max(0, Math.min(plannedDistanceKm, plannedDistanceKm * progress));

    let traversedKm = 0;
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
      const from = routePoints[segmentIndex];
      const to = routePoints[segmentIndex + 1];
      const segmentKm = Math.max(0.001, segmentDistances[segmentIndex] || 0.001);
      const nextTraversedKm = traversedKm + segmentKm;

      if (distanceTargetKm <= nextTraversedKm || segmentIndex === segmentCount - 1) {
        const localRatio = Math.max(0, Math.min(1, (distanceTargetKm - traversedKm) / segmentKm));
        const phase: OperationalPhase = segmentIndex + 1 === routePoints.length - 1 ? 'destination' : 'transit';
        return { point: interpolatePoint(from, to, localRatio), phase, weight, nextRouteIndex: Math.min(routePoints.length - 1, segmentIndex + 1), routePoints };
      }

      traversedKm = nextTraversedKm;
    }

    return { point: routePoints[routePoints.length - 1], phase: 'destination', weight, nextRouteIndex: routePoints.length - 1, routePoints };
  };

  useEffect(() => {
    const interval = window.setInterval(() => {
      setTimePulse(Date.now());
    }, 30000);

    return () => {
      window.clearInterval(interval);
    };
  }, []);
  
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
      const operationalPoint = resolveOperationalPoint(t);
      if (operationalPoint) {
        bounds.extend(new google.maps.LatLng(operationalPoint.point.lat, operationalPoint.point.lng));
        hasPoints = true;
      }

      (t.stops || []).forEach(stop => {
        const stopPoint = resolveStopPoint(stop);
        if (!stopPoint) return;
        bounds.extend(new google.maps.LatLng(stopPoint.lat, stopPoint.lng));
        hasPoints = true;
      });
    });

    if (hasPoints) mapInstance.current.fitBounds(bounds);
  };

  const clearDensityLayers = () => {
    densityLayers.current.forEach(layer => layer?.setMap?.(null));
    densityLayers.current = [];
  };

  const clearStopWaypointLayers = () => {
    stopWaypointLayers.current.forEach(layer => layer?.setMap?.(null));
    stopWaypointLayers.current = [];
  };

  const clearRouteForecastLayers = () => {
    routeForecastLayers.current.forEach(layer => layer?.setMap?.(null));
    routeForecastLayers.current = [];
  };

  useEffect(() => {
    if (mapsLoaded && mapRef.current && !mapInstance.current) {
      const selectedMapId = (theme === 'dark' ? mapIdDark : mapIdLight) || mapIdLight;
      const mapOptions: any = {
        center: { lat: 33.8938, lng: 35.5018 },
        zoom: 12,
        disableDefaultUI: true,
        zoomControl: true,
        gestureHandling: 'none',
        scrollwheel: false,
        disableDoubleClickZoom: true,
        keyboardShortcuts: false
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
    if (!mapsLoaded || forecastRoadDisabled.current) return;

    const activeTrips = trips.filter(trip => trip.status !== TripStatus.CANCELLED && trip.status !== TripStatus.COMPLETED);
    activeTrips.forEach(trip => {
      const routePoints = resolveRoutePoints(trip);
      if (routePoints.length < 2) return;
      const cacheKey = buildForecastCacheKey(trip, routePoints);
      requestRoadForecastPath(trip, routePoints, cacheKey);
    });
  }, [mapsLoaded, trips]);

  useEffect(() => {
    if (mapsLoaded && mapInstance.current) {
      const phaseCounts = { pickup: 0, transit: 0, destination: 0 };
      const points = trips
        .map(t => {
          const operationalPoint = resolveOperationalPoint(t);
          if (!operationalPoint) return null;
          phaseCounts[operationalPoint.phase] += 1;
          return {
            lat: operationalPoint.point.lat,
            lng: operationalPoint.point.lng,
            weight: operationalPoint.weight,
            phase: operationalPoint.phase,
          };
        })
        .filter((point): point is { lat: number; lng: number; weight: number; phase: OperationalPhase } => Boolean(point));

      clearDensityLayers();
      if (points.length > 0) {
        const buckets = new Map<string, {
          lat: number;
          lng: number;
          weight: number;
          count: number;
          pickupWeight: number;
          transitWeight: number;
          destinationWeight: number;
        }>();
        const precision = 0.01;
        points.forEach(point => {
          const latBucket = Math.round(point.lat / precision) * precision;
          const lngBucket = Math.round(point.lng / precision) * precision;
          const key = `${latBucket.toFixed(2)}|${lngBucket.toFixed(2)}`;
          const existing = buckets.get(key);
          if (existing) {
            existing.weight += point.weight;
            existing.count += 1;
            if (point.phase === 'pickup') existing.pickupWeight += point.weight;
            if (point.phase === 'transit') existing.transitWeight += point.weight;
            if (point.phase === 'destination') existing.destinationWeight += point.weight;
            return;
          }
          buckets.set(key, {
            lat: latBucket,
            lng: lngBucket,
            weight: point.weight,
            count: 1,
            pickupWeight: point.phase === 'pickup' ? point.weight : 0,
            transitWeight: point.phase === 'transit' ? point.weight : 0,
            destinationWeight: point.phase === 'destination' ? point.weight : 0,
          });
        });

        const maxWeight = Math.max(...Array.from(buckets.values()).map(entry => entry.weight), 1);

        const nextLayers = Array.from(buckets.values()).map(entry => {
          const intensity = Math.max(0.15, Math.min(1, entry.weight / maxWeight));
          const radiusMeters = 130 + intensity * 520 + entry.count * 34;
          const dominantPhase: OperationalPhase =
            entry.pickupWeight >= entry.transitWeight && entry.pickupWeight >= entry.destinationWeight
              ? 'pickup'
              : entry.transitWeight >= entry.destinationWeight
                ? 'transit'
                : 'destination';
          const fillColor = PHASE_COLORS[dominantPhase];
          return new google.maps.Circle({
            map: mapInstance.current,
            center: { lat: entry.lat, lng: entry.lng },
            radius: radiusMeters,
            fillColor,
            fillOpacity: 0.2 + intensity * 0.3,
            strokeColor: fillColor,
            strokeOpacity: 0.72,
            strokeWeight: 1.6,
            clickable: false,
            zIndex: 2,
          });
        });

        densityLayers.current = nextLayers;
      }

      clearStopWaypointLayers();
      const stopBuckets = new Map<string, { lat: number; lng: number; count: number }>();
      const stopPrecision = 0.008;

      trips.forEach(trip => {
        (trip.stops || []).forEach(stop => {
          const stopPoint = resolveStopPoint(stop);
          if (!stopPoint) return;
          const latBucket = Math.round(stopPoint.lat / stopPrecision) * stopPrecision;
          const lngBucket = Math.round(stopPoint.lng / stopPrecision) * stopPrecision;
          const key = `${latBucket.toFixed(3)}|${lngBucket.toFixed(3)}`;
          const existing = stopBuckets.get(key);
          if (existing) {
            existing.count += 1;
            return;
          }
          stopBuckets.set(key, { lat: latBucket, lng: lngBucket, count: 1 });
        });
      });

      stopWaypointLayers.current = Array.from(stopBuckets.values()).map(entry => new google.maps.Circle({
        map: mapInstance.current,
        center: { lat: entry.lat, lng: entry.lng },
        radius: 105 + entry.count * 45,
        fillColor: STOP_WAYPOINT_COLOR,
        fillOpacity: 0.14,
        strokeColor: STOP_WAYPOINT_COLOR,
        strokeOpacity: 0.96,
        strokeWeight: 2,
        clickable: false,
        zIndex: 3,
      }));

      clearRouteForecastLayers();
      let forecastQuotedCount = 0;
      let forecastActiveCount = 0;
      routeForecastLayers.current = trips
        .filter(trip => trip.status !== TripStatus.CANCELLED && trip.status !== TripStatus.COMPLETED)
        .map(trip => {
          const operational = resolveOperationalPoint(trip);
          if (!operational) return null;

          const cacheKey = buildForecastCacheKey(trip, operational.routePoints);
          const cachedRoadPath = forecastRoadCache.current.get(cacheKey);

          let path: Array<{ lat: number; lng: number }>;
          if (cachedRoadPath && cachedRoadPath.length >= 2) {
            const startIndex = getNearestPathIndex(cachedRoadPath, operational.point);
            const tail = cachedRoadPath.slice(startIndex);
            path = [{ lat: operational.point.lat, lng: operational.point.lng }, ...tail]
              .filter((point, index, array) => {
                if (index === 0) return true;
                const prev = array[index - 1];
                return Math.abs(point.lat - prev.lat) > 0.00001 || Math.abs(point.lng - prev.lng) > 0.00001;
              });
          } else {
            const remainingWaypoints = operational.routePoints.slice(operational.nextRouteIndex);
            path = [operational.point, ...remainingWaypoints]
              .filter((point, index, array) => {
                if (index === 0) return true;
                const prev = array[index - 1];
                return Math.abs(point.lat - prev.lat) > 0.00001 || Math.abs(point.lng - prev.lng) > 0.00001;
              })
              .map(point => ({ lat: point.lat, lng: point.lng }));
          }

          if (path.length < 2) return null;

          const isQuoted = trip.status === TripStatus.QUOTED;
          if (isQuoted) forecastQuotedCount += 1;
          else forecastActiveCount += 1;

          const strokeColor = isQuoted ? FORECAST_QUOTED_COLOR : FORECAST_ACTIVE_COLOR;
          return new google.maps.Polyline({
            map: mapInstance.current,
            path,
            geodesic: true,
            strokeColor,
            strokeOpacity: 0.82,
            strokeWeight: 2.6,
            clickable: false,
            zIndex: 4,
          });
        })
        .filter((layer): layer is any => Boolean(layer));

      setLayerCounts({
        pickup: phaseCounts.pickup,
        transit: phaseCounts.transit,
        destination: phaseCounts.destination,
        stopWaypoints: stopBuckets.size,
        forecastQuoted: forecastQuotedCount,
        forecastActive: forecastActiveCount,
      });
    }
  }, [mapsLoaded, trips, timePulse, forecastRouteVersion]);

  useEffect(() => {
    return () => {
      clearDensityLayers();
      clearStopWaypointLayers();
      clearRouteForecastLayers();
      forecastRoadInFlight.current.clear();
      forecastRoadCache.current.clear();
      forecastRoadDisabled.current = false;
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
                <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Operational Positions</span>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[7px] font-black uppercase tracking-widest text-slate-200">
                {layerCounts.pickup > 0 && (
                  <span className="inline-flex items-center gap-1.5 h-5 px-2 rounded-full border border-amber-300/40 bg-amber-500/10"><span className="h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.65)]" />Pickup {layerCounts.pickup}</span>
                )}
                {layerCounts.transit > 0 && (
                  <span className="inline-flex items-center gap-1.5 h-5 px-2 rounded-full border border-fuchsia-300/40 bg-fuchsia-500/10"><span className="h-2 w-2 rounded-full bg-fuchsia-400 shadow-[0_0_8px_rgba(232,121,249,0.65)]" />In Transit {layerCounts.transit}</span>
                )}
                {layerCounts.destination > 0 && (
                  <span className="inline-flex items-center gap-1.5 h-5 px-2 rounded-full border border-blue-300/40 bg-blue-500/10"><span className="h-2 w-2 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.65)]" />Destination {layerCounts.destination}</span>
                )}
                {layerCounts.stopWaypoints > 0 && (
                  <span className="inline-flex items-center gap-1.5 h-5 px-2 rounded-full border border-teal-300/50 bg-teal-500/10"><span className="h-2 w-2 rounded-full border border-teal-300 bg-transparent" />Stop Waypoints {layerCounts.stopWaypoints}</span>
                )}
                {layerCounts.forecastActive > 0 && (
                  <span className="inline-flex items-center gap-1.5 h-5 px-2 rounded-full border border-fuchsia-300/40 bg-fuchsia-500/10"><span className="h-0.5 w-3 rounded-full bg-fuchsia-300" />Forecast Active {layerCounts.forecastActive}</span>
                )}
                {layerCounts.forecastQuoted > 0 && (
                  <span className="inline-flex items-center gap-1.5 h-5 px-2 rounded-full border border-amber-300/40 bg-amber-500/10"><span className="h-0.5 w-3 rounded-full bg-amber-300" />Forecast Quoted {layerCounts.forecastQuoted}</span>
                )}
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
  type GmPanel = 'HEATMAP' | 'TEMPORAL' | 'FLEET_YIELD' | 'ACCOUNTING' | 'SYNTHESIS';
  type GmBundle = 'SPACE_TIME' | 'ACCOUNT_AUDIT' | 'SYNTHESIS';
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [aiInsightBullets, setAiInsightBullets] = useState<string[] | null>(null);
  const [aiProgress, setAiProgress] = useState(0);
  const [insightActionStatus, setInsightActionStatus] = useState('');
  const [copiedInsight, setCopiedInsight] = useState(false);
  const [exportStatus, setExportStatus] = useState('');
  const [activeBundle, setActiveBundle] = useState<GmBundle>('SPACE_TIME');
  const [hoveredGmPanel, setHoveredGmPanel] = useState<GmPanel | null>(null);
  const [lastInteractedGmPanel, setLastInteractedGmPanel] = useState<GmPanel | null>(null);
  const [fullscreenGmPanel, setFullscreenGmPanel] = useState<GmPanel | null>(null);
  const hoveredGmPanelRef = useRef<GmPanel | null>(null);
  const fullscreenGmPanelRef = useRef<GmPanel | null>(null);

  useEffect(() => {
    hoveredGmPanelRef.current = hoveredGmPanel;
  }, [hoveredGmPanel]);

  useEffect(() => {
    fullscreenGmPanelRef.current = fullscreenGmPanel;
  }, [fullscreenGmPanel]);

  const gmBundles = useMemo(() => ([
    { key: 'SPACE_TIME' as const, label: 'Space & Time', icon: <Globe size={11} className="mr-1.5" /> },
    { key: 'ACCOUNT_AUDIT' as const, label: 'Accounting & Audit', icon: <Wallet size={11} className="mr-1.5" /> },
    { key: 'SYNTHESIS' as const, label: 'System Synthesis', icon: <Sparkles size={11} className="mr-1.5" /> },
  ]), []);

  const activeBundleIndex = useMemo(() => {
    const index = gmBundles.findIndex(bundle => bundle.key === activeBundle);
    return index >= 0 ? index : 0;
  }, [activeBundle, gmBundles]);

  const moveBundle = (direction: 'prev' | 'next') => {
    const delta = direction === 'next' ? 1 : -1;
    const nextIndex = Math.max(0, Math.min(gmBundles.length - 1, activeBundleIndex + delta));
    setActiveBundle(gmBundles[nextIndex].key);
  };

  const getDefaultBundlePanel = (bundle: GmBundle): GmPanel => {
    if (bundle === 'SPACE_TIME') return 'HEATMAP';
    if (bundle === 'ACCOUNT_AUDIT') return 'FLEET_YIELD';
    return 'SYNTHESIS';
  };

  const getViewportPreferredPanel = (bundle: GmBundle): GmPanel | null => {
    const panelIds: Array<{ panel: GmPanel; id: string }> = bundle === 'SPACE_TIME'
      ? [
          { panel: 'HEATMAP', id: 'gm-stage-map' },
          { panel: 'TEMPORAL', id: 'gm-stage-temporal' },
        ]
      : bundle === 'ACCOUNT_AUDIT'
        ? [
            { panel: 'FLEET_YIELD', id: 'gm-stage-fleet-yield' },
            { panel: 'ACCOUNTING', id: 'gm-stage-accounting' },
          ]
        : [{ panel: 'SYNTHESIS', id: 'gm-stage-synthesis' }];

    const viewportTop = 0;
    const viewportBottom = window.innerHeight || 0;
    const viewportCenter = viewportBottom / 2;

    const scored = panelIds
      .map(entry => {
        const element = document.getElementById(entry.id);
        if (!element) return null;

        const rect = element.getBoundingClientRect();
        const visibleTop = Math.max(viewportTop, rect.top);
        const visibleBottom = Math.min(viewportBottom, rect.bottom);
        const visibleHeight = Math.max(0, visibleBottom - visibleTop);
        const distanceFromCenter = Math.abs(((rect.top + rect.bottom) / 2) - viewportCenter);

        return {
          panel: entry.panel,
          visibleHeight,
          distanceFromCenter,
        };
      })
      .filter((item): item is { panel: GmPanel; visibleHeight: number; distanceFromCenter: number } => Boolean(item) && item.visibleHeight > 0)
      .sort((a, b) => {
        if (b.visibleHeight !== a.visibleHeight) return b.visibleHeight - a.visibleHeight;
        return a.distanceFromCenter - b.distanceFromCenter;
      });

    return scored[0]?.panel ?? null;
  };

  const resolveFullscreenTarget = (): GmPanel => {
    const viewportPreferred = getViewportPreferredPanel(activeBundle);
    if (viewportPreferred) return viewportPreferred;

    const hovered = hoveredGmPanelRef.current;
    if (hovered) return hovered;

    if (lastInteractedGmPanel) {
      if (activeBundle === 'SPACE_TIME' && (lastInteractedGmPanel === 'HEATMAP' || lastInteractedGmPanel === 'TEMPORAL')) return lastInteractedGmPanel;
      if (activeBundle === 'ACCOUNT_AUDIT' && (lastInteractedGmPanel === 'FLEET_YIELD' || lastInteractedGmPanel === 'ACCOUNTING')) return lastInteractedGmPanel;
      if (activeBundle === 'SYNTHESIS' && lastInteractedGmPanel === 'SYNTHESIS') return lastInteractedGmPanel;
    }

    return getDefaultBundlePanel(activeBundle);
  };

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target.closest('[contenteditable="true"]'));
    };

    const handleBundleArrowKeys = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (fullscreenGmPanel) return;

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        moveBundle('prev');
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        moveBundle('next');
      }
    };

    window.addEventListener('keydown', handleBundleArrowKeys);
    return () => window.removeEventListener('keydown', handleBundleArrowKeys);
  }, [moveBundle, fullscreenGmPanel]);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target.closest('[contenteditable="true"]'));
    };

    const handleGmFullscreenHotkeys = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.repeat) return;

      if (event.key === 'Escape') {
        if (fullscreenGmPanelRef.current) {
          event.preventDefault();
          setFullscreenGmPanel(null);
        }
        return;
      }

      if (event.key.toLowerCase() === 'f' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (fullscreenGmPanelRef.current) {
          event.preventDefault();
          setFullscreenGmPanel(null);
          return;
        }

        event.preventDefault();
        setFullscreenGmPanel(resolveFullscreenTarget());
      }
    };

    window.addEventListener('keydown', handleGmFullscreenHotkeys);
    return () => window.removeEventListener('keydown', handleGmFullscreenHotkeys);
  }, [lastInteractedGmPanel, activeBundle]);

  useEffect(() => {
    if (fullscreenGmPanel) {
      document.body.classList.add('gm-brief-fullview');
    } else {
      document.body.classList.remove('gm-brief-fullview');
    }

    return () => {
      document.body.classList.remove('gm-brief-fullview');
    };
  }, [fullscreenGmPanel]);

  useEffect(() => {
    if (fullscreenGmPanel) {
      setHoveredGmPanel(null);
    }
  }, [fullscreenGmPanel]);

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

  const fleetYieldMetrics = useMemo(() => {
    const completedTrips = stats.todayTripsList.filter(trip => trip.status === TripStatus.COMPLETED && Boolean(trip.driverId));
    const fuelPriceUsdPerLiter = Number.isFinite(settings.fuelPriceUsdPerLiter)
      ? Math.max(0, Number(settings.fuelPriceUsdPerLiter))
      : 0.9;
    const ESTIMATED_KM_PER_LITER = 10;

    const getFuelLogUsd = (log: Driver['fuelLogs'][number]) => {
      if (Number.isFinite(log?.amountUsd)) {
        return Math.max(0, Number(log.amountUsd));
      }

      const amountLbp = Number(log?.amountLbp);
      const amountOriginal = Number(log?.amountOriginal);
      const fxRate = Number(log?.fxRateSnapshot);
      const fallbackRate = Number.isFinite(settings.exchangeRate) && settings.exchangeRate > 0 ? settings.exchangeRate : 90000;

      if (Number.isFinite(amountLbp) && amountLbp > 0) {
        return amountLbp / fallbackRate;
      }

      if (log?.currency === 'LBP' && Number.isFinite(amountOriginal) && amountOriginal > 0) {
        const appliedRate = Number.isFinite(fxRate) && fxRate > 0 ? fxRate : fallbackRate;
        return amountOriginal / appliedRate;
      }

      return 0;
    };

    const estimateFuelUsdFromDistance = (distanceKm: number) => {
      const safeDistanceKm = Number.isFinite(distanceKm) ? Math.max(0, distanceKm) : 0;
      const litersUsed = safeDistanceKm / ESTIMATED_KM_PER_LITER;
      return litersUsed * fuelPriceUsdPerLiter;
    };

    const rows: FleetYieldDriverRow[] = drivers
      .map(driver => {
        const dTrips = completedTrips.filter(trip => trip.driverId === driver.id);
        if (dTrips.length === 0) return null;

        const tripsWithDistance = dTrips.filter(trip => Number.isFinite(trip.distanceKm) && trip.distanceKm > 0);
        const km = tripsWithDistance.reduce((sum, trip) => sum + Number(trip.distanceKm), 0);
        const revenueUsd = dTrips.reduce((sum, trip) => sum + Number(trip.fareUsd || 0), 0);
        const companyShare = getCompanyShareForDriver(driver, settings);
        const companyShareUsd = revenueUsd * companyShare.rate;

        const logsToday = (Array.isArray(driver.fuelLogs) ? driver.fuelLogs : []).filter(log => {
          const ts = parseISO(log.timestamp);
          return Number.isFinite(ts.getTime()) && isToday(ts);
        });

        const actualFuelUsd = logsToday.reduce((sum, log) => sum + getFuelLogUsd(log), 0);
        const estimatedFuelUsd = estimateFuelUsdFromDistance(km);
        const fuelBaseUsd = logsToday.length > 0 ? actualFuelUsd : estimatedFuelUsd;
        const fuelResponsibilityWeight = getFuelCostWeight(driver.fuelCostResponsibility);
        const fuelResponsibilityPct = Math.round(fuelResponsibilityWeight * 100);
        const fuelExpenseUsd = fuelBaseUsd * fuelResponsibilityWeight;
        const fuelVarianceUsd = logsToday.length > 0 ? (actualFuelUsd - estimatedFuelUsd) * fuelResponsibilityWeight : 0;
        const netYieldUsd = revenueUsd - companyShareUsd - fuelExpenseUsd;

        const safeKm = Math.max(0.001, km);
        const distanceCoveragePct = Math.round((tripsWithDistance.length / Math.max(1, dTrips.length)) * 100);

        return {
          driverId: driver.id,
          driverName: driver.name,
          plateNumber: driver.plateNumber,
          completedTrips: dTrips.length,
          km,
          revenueUsd,
          revenuePerKm: revenueUsd / safeKm,
          fuelExpenseUsd,
          fuelResponsibilityPct,
          companyShareUsd,
          netYieldUsd,
          expensePerKm: fuelExpenseUsd / safeKm,
          yieldPerKm: netYieldUsd / safeKm,
          fuelSource: logsToday.length > 0 ? 'ACTUAL' : 'ESTIMATED',
          fuelVarianceUsd,
          shareRuleLabel: companyShare.label,
          distanceCoveragePct,
        };
      })
      .filter((row): row is FleetYieldDriverRow => Boolean(row))
      .sort((a, b) => b.netYieldUsd - a.netYieldUsd);

    const totalCompletedTrips = rows.reduce((sum, row) => sum + row.completedTrips, 0);
    const totalDistanceCoveredTrips = rows.reduce((sum, row) => sum + Math.round((row.distanceCoveragePct / 100) * row.completedTrips), 0);

    const summary: FleetYieldSummary = {
      totalDrivers: rows.length,
      driversWithActualFuelLogs: rows.filter(row => row.fuelSource === 'ACTUAL').length,
      totalCompletedTrips,
      totalKm: rows.reduce((sum, row) => sum + row.km, 0),
      totalRevenueUsd: rows.reduce((sum, row) => sum + row.revenueUsd, 0),
      totalFuelExpenseUsd: rows.reduce((sum, row) => sum + row.fuelExpenseUsd, 0),
      avgFuelResponsibilityPct: rows.length > 0 ? Math.round(rows.reduce((sum, row) => sum + row.fuelResponsibilityPct, 0) / rows.length) : 0,
      totalCompanyShareUsd: rows.reduce((sum, row) => sum + row.companyShareUsd, 0),
      totalNetYieldUsd: rows.reduce((sum, row) => sum + row.netYieldUsd, 0),
      totalDistanceCoveragePct: totalCompletedTrips > 0 ? Math.round((totalDistanceCoveredTrips / totalCompletedTrips) * 100) : 0,
    };

    return { rows, summary };
  }, [stats.todayTripsList, drivers, settings]);

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
      const fleetYieldSignal = `fleet ${Math.round(fleetYieldMetrics.summary.totalKm)} km · company-fuel $${Math.round(fleetYieldMetrics.summary.totalFuelExpenseUsd)} @ ${fleetYieldMetrics.summary.avgFuelResponsibilityPct}% scope · yield $${Math.round(fleetYieldMetrics.summary.totalNetYieldUsd)} (distance coverage ${fleetYieldMetrics.summary.totalDistanceCoveragePct}%)`;
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
        `ACCOUNTING — ${accountingSignal}; collected today $${Math.round(accountingMetrics.collectedTodayUsd)}; ${settlementSignal}; ${fleetYieldSignal}.`,
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

  const handleExportOperationalPack = () => {
    const escapeCsvCell = (value: unknown): string => {
      const raw = String(value ?? '');
      if (!/[",\n]/.test(raw)) return raw;
      return `"${raw.replace(/"/g, '""')}"`;
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    const financeHeaders = ['entry_id', 'type', 'party_type', 'party_id', 'party_name', 'cycle', 'amount_usd', 'status', 'created_at', 'paid_at', 'receipt_id', 'notes'];
    const financeRows = creditLedger.map(entry => [
      entry.id,
      'CREDIT_LEDGER',
      entry.partyType,
      entry.partyId || '',
      entry.partyName,
      entry.cycle,
      Number(entry.amountUsd || 0).toFixed(2),
      entry.status,
      entry.createdAt,
      entry.paidAt || '',
      entry.receiptId || '',
      entry.notes || '',
    ].map(escapeCsvCell).join(','));

    const receiptRows = receipts.map(receipt => [
      receipt.id,
      'RECEIPT',
      receipt.partyType,
      receipt.partyId || '',
      receipt.partyName,
      receipt.cycle,
      Number(receipt.amountUsd || 0).toFixed(2),
      'PAID',
      receipt.issuedAt,
      receipt.issuedAt,
      receipt.id,
      receipt.notes || '',
    ].map(escapeCsvCell).join(','));

    const financeCsv = [financeHeaders.map(escapeCsvCell).join(','), ...financeRows, ...receiptRows].join('\n');
    const financeBlob = new Blob([financeCsv], { type: 'text/csv;charset=utf-8;' });
    const financeUrl = URL.createObjectURL(financeBlob);
    const financeAnchor = document.createElement('a');
    financeAnchor.href = financeUrl;
    financeAnchor.download = `gm-finance-ledger-${stamp}.csv`;
    financeAnchor.click();
    URL.revokeObjectURL(financeUrl);

    const yieldHeaders = ['driver_id', 'driver_name', 'plate', 'completed_trips', 'km', 'revenue_usd', 'company_share_usd', 'fuel_expense_usd', 'net_yield_usd', 'yield_per_km', 'fuel_source', 'distance_coverage_pct'];
    const yieldRows = fleetYieldMetrics.rows.map(row => [
      row.driverId,
      row.driverName,
      row.plateNumber,
      row.completedTrips,
      Number(row.km || 0).toFixed(2),
      Number(row.revenueUsd || 0).toFixed(2),
      Number(row.companyShareUsd || 0).toFixed(2),
      Number(row.fuelExpenseUsd || 0).toFixed(2),
      Number(row.netYieldUsd || 0).toFixed(2),
      Number(row.yieldPerKm || 0).toFixed(4),
      row.fuelSource,
      row.distanceCoveragePct,
    ].map(escapeCsvCell).join(','));
    const yieldCsv = [yieldHeaders.map(escapeCsvCell).join(','), ...yieldRows].join('\n');
    const yieldBlob = new Blob([yieldCsv], { type: 'text/csv;charset=utf-8;' });
    const yieldUrl = URL.createObjectURL(yieldBlob);
    const yieldAnchor = document.createElement('a');
    yieldAnchor.href = yieldUrl;
    yieldAnchor.download = `gm-fleet-yield-${stamp}.csv`;
    yieldAnchor.click();
    URL.revokeObjectURL(yieldUrl);

    const tripHeaders = ['trip_id', 'created_at', 'trip_date', 'status', 'driver_id', 'driver_name', 'customer_name', 'payment_mode', 'settlement_status', 'fare_usd', 'distance_km', 'traffic_index', 'surplus_min'];
    const tripRows = stats.todayTripsList.map(trip => {
      const driverName = drivers.find(driver => driver.id === trip.driverId)?.name || '';
      return [
        trip.id,
        trip.createdAt,
        trip.tripDate,
        trip.status,
        trip.driverId || '',
        driverName,
        trip.customerName,
        getTripPaymentMode(trip),
        getTripSettlementStatus(trip),
        Number(trip.fareUsd || 0).toFixed(2),
        Number(trip.distanceKm || 0).toFixed(2),
        Number(trip.trafficIndex || 0).toFixed(0),
        Number(trip.surplusMin || 0).toFixed(0),
      ].map(escapeCsvCell).join(',');
    });
    const tripCsv = [tripHeaders.map(escapeCsvCell).join(','), ...tripRows].join('\n');
    const tripBlob = new Blob([tripCsv], { type: 'text/csv;charset=utf-8;' });
    const tripUrl = URL.createObjectURL(tripBlob);
    const tripAnchor = document.createElement('a');
    tripAnchor.href = tripUrl;
    tripAnchor.download = `gm-ops-trips-${stamp}.csv`;
    tripAnchor.click();
    URL.revokeObjectURL(tripUrl);

    setExportStatus('Ops export ready: finance, fleet yield, and trip telemetry CSVs.');
    window.setTimeout(() => setExportStatus(''), 2800);
  };

  const getInsightVisual = (line: string) => {
    const category = (line.split('—')[0] || '').trim().toUpperCase();
    switch (category) {
      case 'LOAD':
        return {
          category,
          icon: <Activity size={12} className="text-emerald-300" />,
          badgeClass: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
        };
      case 'FLOW':
        return {
          category,
          icon: <Globe size={12} className="text-blue-300" />,
          badgeClass: 'border-blue-500/40 bg-blue-500/10 text-blue-300',
        };
      case 'TRAFFIC':
        return {
          category,
          icon: <Timer size={12} className="text-amber-300" />,
          badgeClass: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
        };
      case 'ACCOUNTING':
        return {
          category,
          icon: <Wallet size={12} className="text-indigo-300" />,
          badgeClass: 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300',
        };
      case 'CREDIT':
        return {
          category,
          icon: <AlertOctagon size={12} className="text-orange-300" />,
          badgeClass: 'border-orange-500/40 bg-orange-500/10 text-orange-300',
        };
      case 'ACTION':
        return {
          category,
          icon: <Sparkles size={12} className="text-gold-300" />,
          badgeClass: 'border-gold-500/40 bg-gold-500/10 text-gold-300',
        };
      default:
        return {
          category: category || 'INSIGHT',
          icon: <FileText size={12} className="text-slate-300" />,
          badgeClass: 'border-white/20 bg-white/5 text-slate-300',
        };
    }
  };

  const missionIntelCards = [
    {
      id: 'load',
      label: 'Fleet Load',
      value: `${stats.loadFactor}%`,
      sub: `${synthesisMetrics.busyDrivers}/${synthesisMetrics.activeDrivers || drivers.length || 0} busy`,
      icon: <Activity size={12} className="text-emerald-300" />,
      tone: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
    },
    {
      id: 'gross',
      label: 'Gross Yield',
      value: `$${Math.round(stats.revenueToday)}`,
      sub: `${synthesisMetrics.totalTrips} missions`,
      icon: <Wallet size={12} className="text-gold-300" />,
      tone: 'text-gold-300 border-gold-500/30 bg-gold-500/10',
    },
    {
      id: 'owed',
      label: 'Company Owed',
      value: `$${Math.round(accountingMetrics.companyOwedToday)}`,
      sub: `Net $${Math.round(accountingMetrics.netAfterCompany)}`,
      icon: <Briefcase size={12} className="text-blue-300" />,
      tone: 'text-blue-300 border-blue-500/30 bg-blue-500/10',
    },
    {
      id: 'backlog',
      label: 'Open Backlog',
      value: `$${Math.round(accountingMetrics.openBacklogUsd)}`,
      sub: `${accountingMetrics.openBacklogCount} open`,
      icon: <AlertTriangle size={12} className="text-amber-300" />,
      tone: 'text-amber-300 border-amber-500/30 bg-amber-500/10',
    },
    {
      id: 'collected',
      label: 'Collected Today',
      value: `$${Math.round(accountingMetrics.collectedTodayUsd)}`,
      sub: 'Receipts issued',
      icon: <Receipt size={12} className="text-indigo-300" />,
      tone: 'text-indigo-300 border-indigo-500/30 bg-indigo-500/10',
    },
    {
      id: 'cashSettled',
      label: 'Cash Settled',
      value: `$${Math.round(accountingMetrics.cashSettledTodayUsd)}`,
      sub: 'Trip settlement',
      icon: <CheckCircle size={12} className="text-emerald-300" />,
      tone: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
    },
    {
      id: 'creditPending',
      label: 'Credit Pending',
      value: `$${Math.round(accountingMetrics.openCreditTripTodayUsd)}`,
      sub: 'Trips pending',
      icon: <AlertOctagon size={12} className="text-orange-300" />,
      tone: 'text-orange-300 border-orange-500/30 bg-orange-500/10',
    },
    {
      id: 'traffic',
      label: 'Traffic Pulse',
      value: `TI ${synthesisMetrics.avgTraffic}`,
      sub: `${synthesisMetrics.avgDelay}m delay · ${synthesisMetrics.peakHourLabel}`,
      icon: <Timer size={12} className="text-fuchsia-300" />,
      tone: 'text-fuchsia-300 border-fuchsia-500/30 bg-fuchsia-500/10',
    },
  ];

  const renderSynthesisCard = (isFullscreen = false) => (
    <div className={`bg-brand-900 rounded-[2.5rem] p-8 text-white shadow-2xl border border-brand-800 flex flex-col ${isFullscreen ? 'h-full min-h-0 overflow-hidden' : 'h-full min-h-[400px] lg:overflow-hidden'}`}>
      <div className="inline-flex items-center px-4 py-1.5 bg-gold-600 rounded-full text-[9px] font-black uppercase tracking-widest text-brand-950 shadow-lg shadow-gold-600/20 w-fit mb-8"><Sparkles size={14} className="mr-2" />System Synthesis</div>

      <div className="flex-1 flex flex-col justify-center lg:justify-start lg:min-h-0 lg:overflow-hidden">
        {isGeneratingAi ? (
          <div className="space-y-4">
            <p className="text-xl font-black uppercase tracking-tighter animate-pulse">Computing Yield...</p>
            <div className="h-1.5 w-full bg-brand-950 rounded-full overflow-hidden border border-white/5">
              <div className="h-full bg-gold-500 transition-all duration-300" style={{ width: `${aiProgress}%` }} />
            </div>
          </div>
        ) : aiInsightBullets ? (
          <div className="space-y-4 lg:min-h-0 lg:flex lg:flex-col">
            <ul className="space-y-3 lg:overflow-y-auto lg:pr-1">
              {aiInsightBullets.map((line, index) => {
                const visual = getInsightVisual(line);
                return (
                  <li key={`insight-${index}`} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm font-bold leading-tight text-slate-50 break-words">
                    <div className="flex items-center gap-2 mb-1.5">
                      {visual.icon}
                      <span className={`inline-flex items-center h-5 px-2 rounded-md border text-[8px] font-black uppercase tracking-widest ${visual.badgeClass}`}>
                        {visual.category}
                      </span>
                    </div>
                    <span className="block break-words whitespace-pre-wrap">{line}</span>
                  </li>
                );
              })}
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {missionIntelCards.map(card => (
                <div key={card.id} className="rounded-2xl border border-white/10 bg-brand-950/90 p-3.5 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`inline-flex items-center h-6 px-2 rounded-lg border text-[8px] font-black uppercase tracking-widest ${card.tone}`}>
                      {card.icon}
                      <span className="ml-1.5">{card.label}</span>
                    </span>
                    <span className="text-lg font-black text-white leading-none">{card.value}</span>
                  </div>
                  <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">{card.sub}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <Button variant="gold" onClick={generateAiSummary} isLoading={isGeneratingAi} className="h-14 w-full shadow-2xl mt-8">Generate Synthesis</Button>
    </div>
  );

  return (
    <div className="app-page-shell gmb-shell p-4 md:p-8 w-full space-y-8 animate-fade-in pb-24 lg:pb-8">
      <div className={`flex flex-col md:flex-row justify-between items-start md:items-center gap-4 ${fullscreenGmPanel ? 'hidden' : ''}`}>
        <div>
          <div className="flex items-center space-x-2 mb-1">
            <div className="w-2 h-2 rounded-full bg-gold-500 animate-pulse" />
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.4em]">Strategic Control</span>
          </div>
          <h2 className="text-3xl font-black text-brand-900 dark:text-slate-100 uppercase tracking-tight flex items-center">
            <Globe className="mr-3 text-gold-500 w-8 h-8" size={32} /> Command Brief
          </h2>
          {exportStatus && (
            <p role="status" aria-live="polite" className="text-[9px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300 mt-2">{exportStatus}</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex items-center rounded-lg border border-slate-200 dark:border-white/10 bg-white/70 dark:bg-brand-900/40 p-1 gap-1">
            {gmBundles.map(bundle => {
              const isActive = activeBundle === bundle.key;
              return (
                <button
                  key={bundle.key}
                  type="button"
                  onClick={() => setActiveBundle(bundle.key)}
                  className={`h-8 px-2.5 rounded-md border text-[8px] font-black uppercase tracking-[0.16em] inline-flex items-center transition-colors ${isActive
                    ? 'border-gold-300/70 bg-gold-50/80 dark:border-gold-800/70 dark:bg-gold-900/20 text-gold-700 dark:text-gold-300'
                    : 'border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-950 text-slate-500 dark:text-slate-300'}`}
                >
                  {bundle.icon}
                  {bundle.label}
                </button>
              );
            })}
          </div>
          <div className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-white/10 bg-white/70 dark:bg-brand-900/40 p-1">
            <button
              type="button"
              onClick={() => moveBundle('prev')}
              disabled={activeBundleIndex === 0}
              className="h-8 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-950 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Previous bundle (←)"
            >
              ← Prev
            </button>
            <button
              type="button"
              onClick={() => moveBundle('next')}
              disabled={activeBundleIndex >= gmBundles.length - 1}
              className="h-8 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-950 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Next bundle (→)"
            >
              Next →
            </button>
          </div>
          <button
            type="button"
            onClick={handleExportOperationalPack}
            accessKey="e"
            title="Export operational pack (Shortcut: ⌥E)"
            className="h-9 px-3 rounded-lg border border-gold-200/70 dark:border-gold-900/40 bg-gold-50/70 dark:bg-gold-900/10 text-[8px] font-black uppercase tracking-[0.2em] text-gold-700 dark:text-gold-300 inline-flex items-center hover:border-gold-300/60 hover:text-gold-600 dark:hover:text-gold-200 transition-colors"
          >
            <Download size={12} className="mr-1.5" />
            Export Ops
            <span className="ml-1.5 h-4 px-1 rounded border border-gold-300/70 dark:border-gold-800/70 text-[7px] font-black tracking-widest text-gold-600 dark:text-gold-300 inline-flex items-center">⌥E</span>
          </button>
        </div>
      </div>

      <div className={`space-y-8 ${fullscreenGmPanel ? 'hidden' : ''}`}>
        {/* Geographic Layer */}
        {activeBundle === 'SPACE_TIME' && (
          <div id="gm-stage-space-time" className="space-y-8 animate-in fade-in slide-in-from-right-2 duration-200">
            <div
              id="gm-stage-map"
              onMouseEnter={() => { setHoveredGmPanel('HEATMAP'); setLastInteractedGmPanel('HEATMAP'); }}
              onFocusCapture={() => setLastInteractedGmPanel('HEATMAP')}
              onMouseLeave={() => setHoveredGmPanel(prev => (prev === 'HEATMAP' ? null : prev))}
            >
              <FleetHeatmap
                trips={stats.todayTripsList}
                apiKey={settings.googleMapsApiKey}
                theme={theme}
                mapIdLight={settings.googleMapsMapId}
                mapIdDark={settings.googleMapsMapIdDark}
              />
            </div>
            <div
              id="gm-stage-temporal"
              onMouseEnter={() => { setHoveredGmPanel('TEMPORAL'); setLastInteractedGmPanel('TEMPORAL'); }}
              onFocusCapture={() => setLastInteractedGmPanel('TEMPORAL')}
              onMouseLeave={() => setHoveredGmPanel(prev => (prev === 'TEMPORAL' ? null : prev))}
            >
              <TemporalPulse trips={trips} />
            </div>
          </div>
        )}

        {activeBundle === 'ACCOUNT_AUDIT' && (
          <div id="gm-stage-account-audit" className="space-y-8 animate-in fade-in slide-in-from-right-2 duration-200">
            <div id="gm-stage-fleet-yield" onMouseEnter={() => { setHoveredGmPanel('FLEET_YIELD'); setLastInteractedGmPanel('FLEET_YIELD'); }} onFocusCapture={() => setLastInteractedGmPanel('FLEET_YIELD')} onMouseLeave={() => setHoveredGmPanel(prev => (prev === 'FLEET_YIELD' ? null : prev))}>
              <FleetYieldPulse rows={fleetYieldMetrics.rows} summary={fleetYieldMetrics.summary} />
            </div>
            <div id="gm-stage-accounting" onMouseEnter={() => { setHoveredGmPanel('ACCOUNTING'); setLastInteractedGmPanel('ACCOUNTING'); }} onFocusCapture={() => setLastInteractedGmPanel('ACCOUNTING')} onMouseLeave={() => setHoveredGmPanel(prev => (prev === 'ACCOUNTING' ? null : prev))}>
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
          </div>
        )}

        {/* Intelligence Layer */}
        {activeBundle === 'SYNTHESIS' && (
        <div id="gm-stage-synthesis" className="space-y-8 animate-in fade-in slide-in-from-right-2 duration-200" onMouseEnter={() => { setHoveredGmPanel('SYNTHESIS'); setLastInteractedGmPanel('SYNTHESIS'); }} onFocusCapture={() => setLastInteractedGmPanel('SYNTHESIS')} onMouseLeave={() => setHoveredGmPanel(prev => (prev === 'SYNTHESIS' ? null : prev))}>
          {renderSynthesisCard()}
        </div>
        )}
      </div>

      {fullscreenGmPanel && (
        <div className="fixed inset-0 z-[10000] bg-slate-50 dark:bg-brand-950 p-0 flex flex-col overflow-hidden">
          <div className="border-0 bg-white dark:bg-brand-900 shadow-2xl flex flex-col min-h-0 h-full overflow-hidden">
            <div className="px-4 md:px-5 py-3 border-b border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 flex items-center justify-between gap-3 shrink-0">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500 dark:text-slate-300">
                  {fullscreenGmPanel === 'HEATMAP'
                    ? 'Spatial Density · Full View'
                    : fullscreenGmPanel === 'TEMPORAL'
                      ? 'Temporal Matrix · Full View'
                      : fullscreenGmPanel === 'FLEET_YIELD'
                        ? 'Fleet Yield · Full View'
                        : fullscreenGmPanel === 'ACCOUNTING'
                          ? 'Accounting Visualizer · Full View'
                          : 'System Synthesis · Full View'}
                </p>
                <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mt-1">F or Esc to exit</p>
              </div>
              <button
                type="button"
                onClick={() => setFullscreenGmPanel(null)}
                className="h-8 px-3 rounded-lg border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300"
              >
                Exit Full View
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-auto p-2 md:p-3">
              {fullscreenGmPanel === 'HEATMAP' ? (
                <div className="h-full min-h-[420px]">
                  <FleetHeatmap
                    trips={stats.todayTripsList}
                    apiKey={settings.googleMapsApiKey}
                    theme={theme}
                    mapIdLight={settings.googleMapsMapId}
                    mapIdDark={settings.googleMapsMapIdDark}
                  />
                </div>
              ) : fullscreenGmPanel === 'TEMPORAL' ? (
                <TemporalPulse trips={trips} isFullscreen />
              ) : fullscreenGmPanel === 'FLEET_YIELD' ? (
                <FleetYieldPulse rows={fleetYieldMetrics.rows} summary={fleetYieldMetrics.summary} />
              ) : fullscreenGmPanel === 'ACCOUNTING' ? (
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
              ) : (
                <div className="h-full min-h-[480px]">
                  {renderSynthesisCard(true)}
                </div>
              )}
            </div>
          </div>
        </div>
        )}

    </div>
  );
};
