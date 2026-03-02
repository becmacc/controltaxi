import React from 'react';
import { Phone, Activity, DollarSign, Map, Gauge, Clock3, XCircle } from 'lucide-react';
import { Driver } from '../types';
import { buildWhatsAppLink, normalizePhoneForWhatsApp } from '../services/whatsapp';
import { UnitSnapshotMetrics } from '../services/unitSnapshot';

interface UnitSnapshotCardProps {
  driver: Driver;
  metrics: UnitSnapshotMetrics;
  className?: string;
}

const ownershipLabelMap = {
  COMPANY_FLEET: 'Company Fleet',
  OWNER_DRIVER: 'Owner Driver',
  RENTAL: 'Rental',
} as const;

const responsibilityLabelMap = {
  COMPANY: 'Company',
  DRIVER: 'Driver',
  SHARED: 'Shared',
} as const;

const availabilityLabelMap = {
  AVAILABLE: 'Active',
  BUSY: 'Occupied',
  OFF_DUTY: 'Standby',
} as const;

const availabilityClassMap = {
  AVAILABLE: 'border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10',
  BUSY: 'border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-900/40 dark:text-amber-300 dark:bg-amber-900/10',
  OFF_DUTY: 'border-slate-300 text-slate-600 bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:bg-slate-900/20',
} as const;

export const UnitSnapshotCard: React.FC<UnitSnapshotCardProps> = ({ driver, metrics, className = '' }) => {
  const phoneKey = normalizePhoneForWhatsApp(driver.phone);
  const callHref = phoneKey ? `tel:+${phoneKey}` : '';
  const whatsappHref = buildWhatsAppLink(phoneKey || '') || '';
  const availabilityClass = availabilityClassMap[driver.currentStatus || 'OFF_DUTY'];

  return (
    <div className={`rounded-2xl border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950/50 p-3 md:p-4 space-y-3 ${className}`.trim()}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Unit Snapshot</p>
          <p className="text-[11px] font-black uppercase tracking-tight text-brand-900 dark:text-slate-100">{driver.name}</p>
          <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-300 mt-0.5">{driver.carModel} · {driver.plateNumber}</p>
        </div>
        <span className={`inline-flex items-center h-5 px-2 rounded-md border text-[7px] font-black uppercase tracking-widest ${availabilityClass}`}>
          {availabilityLabelMap[driver.currentStatus || 'OFF_DUTY']}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {callHref && (
          <a
            href={callHref}
            className="h-7 px-2 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-900 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 inline-flex items-center"
          >
            <Phone size={11} className="mr-1" />Call
          </a>
        )}
        {whatsappHref && (
          <a
            href={whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            className="h-7 px-2 rounded-lg border border-emerald-300 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[8px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300 inline-flex items-center"
          >
            <Phone size={11} className="mr-1" />WA
          </a>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-900 p-2">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 inline-flex items-center gap-1"><Activity size={10} />Trips</p>
          <p className="text-[11px] font-black text-brand-900 dark:text-slate-100">{metrics.completedTrips}</p>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-900 p-2">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 inline-flex items-center gap-1"><DollarSign size={10} />Revenue</p>
          <p className="text-[11px] font-black text-brand-900 dark:text-slate-100">${metrics.totalRevenue.toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-900 p-2">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 inline-flex items-center gap-1"><Map size={10} />Distance</p>
          <p className="text-[11px] font-black text-brand-900 dark:text-slate-100">{Math.round(metrics.totalDistance).toLocaleString()} km</p>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-900 p-2">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 inline-flex items-center gap-1"><Gauge size={10} />Profit</p>
          <p className={`text-[11px] font-black ${metrics.profitabilityIndex >= 0 ? 'text-gold-600 dark:text-gold-400' : 'text-red-600 dark:text-red-400'}`}>
            ${metrics.profitabilityIndex.toLocaleString()}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-900 p-2">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 inline-flex items-center gap-1"><Clock3 size={10} />Active</p>
          <p className="text-[11px] font-black text-brand-900 dark:text-slate-100">{metrics.activeTrips}</p>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-900 p-2">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 inline-flex items-center gap-1"><XCircle size={10} />Cancelled</p>
          <p className="text-[11px] font-black text-brand-900 dark:text-slate-100">{metrics.cancelledTrips}</p>
        </div>
      </div>

      <div className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-slate-200 dark:border-brand-800 bg-slate-50/80 dark:bg-brand-950/70 px-1.5 py-1 flex-nowrap overflow-x-auto snap-x snap-mandatory scroll-px-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>span]:shrink-0 [&>span]:snap-start">
        <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-slate-300 text-slate-600 bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:bg-slate-900/20">
          {ownershipLabelMap[driver.vehicleOwnership || 'COMPANY_FLEET']}
        </span>
        <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-900/40 dark:text-amber-300 dark:bg-amber-900/10">
          Fuel {responsibilityLabelMap[driver.fuelCostResponsibility || 'COMPANY']}
        </span>
        <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10">
          Maint {responsibilityLabelMap[driver.maintenanceResponsibility || 'COMPANY']}
        </span>
      </div>

      <p className="text-[8px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-300">
        {driver.status === 'ACTIVE' ? 'Unit active in roster' : 'Unit inactive in roster'}
        {metrics.lastCompletedAt ? ` · Last completed ${new Date(metrics.lastCompletedAt).toLocaleDateString()}` : ''}
      </p>
    </div>
  );
};
