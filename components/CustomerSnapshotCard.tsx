import React from 'react';
import { AlertCircle, Download, MessageCircle, Phone, Star, UserCheck } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { CustomerSnapshot } from '../services/customerSnapshot';
import { buildWhatsAppLink, normalizePhoneForWhatsApp } from '../services/whatsapp';
import { exportReceiptPdfFriendly } from '../services/receiptExport';

interface CustomerSnapshotCardProps {
  snapshot: CustomerSnapshot;
  className?: string;
}

const segmentLabel = (segment: string): string => {
  if (segment === 'LOCAL_RESIDENT') return 'LOCAL';
  return segment;
};

const segmentClassName = (segment: string): string => {
  if (segment === 'TOURIST') {
    return 'border-purple-300 text-purple-700 dark:border-purple-900/40 dark:text-purple-300 bg-purple-50 dark:bg-purple-900/10';
  }
  if (segment === 'LOCAL_RESIDENT') {
    return 'border-emerald-300 text-emerald-700 dark:border-emerald-900/40 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/10';
  }
  return 'border-blue-200 text-blue-700 dark:border-blue-900/40 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/10';
};

export const CustomerSnapshotCard: React.FC<CustomerSnapshotCardProps> = ({ snapshot, className = '' }) => {
  const phoneKey = normalizePhoneForWhatsApp(snapshot.phone) || snapshot.normalizedPhone;
  const callHref = phoneKey ? `tel:+${phoneKey}` : '';
  const whatsappHref = buildWhatsAppLink(phoneKey) || '';
  const hasCustomerReceipt = Boolean(snapshot.latestReceipt);
  const hasDriverReceipt = Boolean(snapshot.driverSolvency?.latestReceipt);

  return (
    <div className={`rounded-2xl border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950/50 p-3 md:p-4 space-y-2.5 md:space-y-3 ${className}`.trim()}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Customer Snapshot</p>
          <p className="text-[11px] font-black uppercase tracking-tight text-brand-900 dark:text-slate-100">{snapshot.name}</p>
        </div>
        <div className="flex items-center gap-2">
          {callHref && (
            <a href={callHref} className="h-7 px-2 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-900 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 inline-flex items-center">
              <Phone size={11} className="mr-1" />Call
            </a>
          )}
          {whatsappHref && (
            <a href={whatsappHref} target="_blank" rel="noopener noreferrer" className="h-7 px-2 rounded-lg border border-emerald-300 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[8px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300 inline-flex items-center">
              <MessageCircle size={11} className="mr-1" />WA
            </a>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <span className="text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-gold-500/40 text-gold-700 dark:text-gold-400 bg-gold-500/5">{snapshot.loyaltyTier}</span>
        {snapshot.marketSegments.map(segment => (
          <span key={segment} className={`text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest ${segmentClassName(segment)}`}>{segmentLabel(segment)}</span>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-1.5 md:gap-2">
        <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-900 p-2">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Reliability</p>
          <p className="text-[11px] font-black text-brand-900 dark:text-slate-100">{snapshot.reliabilityScore}%</p>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-900 p-2">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Trips</p>
          <p className="text-[11px] font-black text-brand-900 dark:text-slate-100">{snapshot.completedTrips}/{snapshot.totalTrips}</p>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-900 p-2.5 md:p-3 space-y-2">
        <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Solvency</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div className="rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-2.5 py-2">
            <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Customer</p>
            <p className="text-[10px] font-black uppercase tracking-widest text-amber-600 dark:text-amber-400">Open ${snapshot.openCreditUsd.toFixed(0)}</p>
            <p className="text-[9px] font-bold uppercase tracking-widest text-emerald-600 dark:text-emerald-400">Paid ${snapshot.paidCreditUsd.toFixed(0)} · Rcpt {snapshot.receiptCount}</p>
            {snapshot.overdueOpenCount > 0 && (
              <p className="text-[8px] font-black uppercase tracking-widest text-red-600 dark:text-red-400">Overdue {snapshot.overdueOpenCount}</p>
            )}
          </div>
          {snapshot.driverSolvency && (
            <div className="rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-2.5 py-2">
              <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Driver · {snapshot.driverSolvency.driverName}</p>
              <p className="text-[10px] font-black uppercase tracking-widest text-amber-600 dark:text-amber-400">Open ${snapshot.driverSolvency.openCreditUsd.toFixed(0)}</p>
              <p className="text-[9px] font-bold uppercase tracking-widest text-emerald-600 dark:text-emerald-400">Paid ${snapshot.driverSolvency.paidCreditUsd.toFixed(0)} · Rcpt {snapshot.driverSolvency.receiptCount}</p>
              {snapshot.driverSolvency.overdueOpenCount > 0 && (
                <p className="text-[8px] font-black uppercase tracking-widest text-red-600 dark:text-red-400">Overdue {snapshot.driverSolvency.overdueOpenCount}</p>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasCustomerReceipt && (
            <button
              type="button"
              onClick={() => exportReceiptPdfFriendly(snapshot.latestReceipt!, { companyName: "Andrew's Taxi", partyPhone: snapshot.phone })}
              className="h-7 px-2 rounded-lg border border-indigo-200 dark:border-indigo-900/40 bg-indigo-50 dark:bg-indigo-900/10 text-[8px] font-black uppercase tracking-widest text-indigo-700 dark:text-indigo-300 inline-flex items-center"
            >
              <Download size={11} className="mr-1" /> Customer Receipt
            </button>
          )}
          {hasDriverReceipt && (
            <button
              type="button"
              onClick={() => exportReceiptPdfFriendly(snapshot.driverSolvency!.latestReceipt!, { companyName: "Andrew's Taxi", extraNotes: `Driver: ${snapshot.driverSolvency!.driverName}` })}
              className="h-7 px-2 rounded-lg border border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 text-[8px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300 inline-flex items-center"
            >
              <Download size={11} className="mr-1" /> Driver Receipt
            </button>
          )}
        </div>
      </div>

      <div className="space-y-1 text-[9px] font-bold text-slate-500 dark:text-slate-300">
        {snapshot.preferredDriverName && <p><UserCheck size={10} className="inline mr-1" />Prefers: {snapshot.preferredDriverName}</p>}
        {snapshot.commonDestinations.length > 0 && <p><Star size={10} className="inline mr-1" />Common: {snapshot.commonDestinations.join(' · ')}</p>}
        {snapshot.cancelledTrips > 0 && <p className="text-red-600 dark:text-red-400"><AlertCircle size={10} className="inline mr-1" />Cancelled: {snapshot.cancelledTrips}</p>}
        {(snapshot.homeAddress || snapshot.businessAddress || snapshot.frequentPlacesCount > 0) && (
          <p>Places: {snapshot.homeAddress ? 'Home' : ''}{snapshot.homeAddress && snapshot.businessAddress ? ' / ' : ''}{snapshot.businessAddress ? 'Business' : ''}{snapshot.frequentPlacesCount > 0 ? ` +${snapshot.frequentPlacesCount}` : ''}</p>
        )}
        {snapshot.lastContactAt && <p>Last Contact: {format(parseISO(snapshot.lastContactAt), 'MMM d, h:mm a')}</p>}
      </div>

      {(snapshot.recentTimeline.length > 0 || snapshot.notes) && (
        <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-900 p-2.5 md:p-3">
          <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 mb-1">Memory</p>
          <p className="text-[10px] font-bold text-brand-900 dark:text-slate-200 break-words line-clamp-2">
            {snapshot.recentTimeline[0] || snapshot.notes || 'No notes'}
          </p>
        </div>
      )}
    </div>
  );
};
