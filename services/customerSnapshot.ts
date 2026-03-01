import { CreditLedgerEntry, Customer, CustomerMarketSegment, Driver, ReceiptRecord, Trip, TripStatus } from '../types';
import { customerPhoneKey } from './customerProfile';

interface SolvencySnapshot {
  openCreditUsd: number;
  paidCreditUsd: number;
  overdueOpenCount: number;
  receiptCount: number;
  lastReceiptAt?: string;
  latestReceipt?: ReceiptRecord;
}

export interface CustomerSnapshot {
  name: string;
  phone: string;
  normalizedPhone: string;
  loyaltyTier: 'VIP' | 'REGULAR' | 'NEW';
  marketSegments: CustomerMarketSegment[];
  reliabilityScore: number;
  totalTrips: number;
  completedTrips: number;
  cancelledTrips: number;
  preferredDriverName?: string;
  commonDestinations: string[];
  notes?: string;
  recentTimeline: string[];
  lastContactAt?: string;
  homeAddress?: string;
  businessAddress?: string;
  frequentPlacesCount: number;
  openCreditUsd: number;
  paidCreditUsd: number;
  overdueOpenCount: number;
  receiptCount: number;
  lastReceiptAt?: string;
  latestReceipt?: ReceiptRecord;
  driverSolvency?: {
    driverId: string;
    driverName: string;
    openCreditUsd: number;
    paidCreditUsd: number;
    overdueOpenCount: number;
    receiptCount: number;
    lastReceiptAt?: string;
    latestReceipt?: ReceiptRecord;
  };
}

const toTimestamp = (value?: string): number => {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
};

const uniqueSegments = (segments: CustomerMarketSegment[]): CustomerMarketSegment[] => {
  return Array.from(new Set(segments));
};

const lower = (value?: string): string => String(value || '').trim().toLowerCase();

const isOverdue = (dueDate?: string): boolean => {
  if (!dueDate) return false;
  const parsed = new Date(dueDate).getTime();
  return Number.isFinite(parsed) && parsed < Date.now();
};

const buildSolvencySnapshot = (
  entries: CreditLedgerEntry[],
  receipts: ReceiptRecord[]
): SolvencySnapshot => {
  const openCreditUsd = entries
    .filter(entry => entry.status === 'OPEN')
    .reduce((sum, entry) => sum + entry.amountUsd, 0);
  const paidCreditUsd = entries
    .filter(entry => entry.status === 'PAID')
    .reduce((sum, entry) => sum + entry.amountUsd, 0);
  const overdueOpenCount = entries.filter(entry => entry.status === 'OPEN' && isOverdue(entry.dueDate)).length;

  const sortedReceipts = receipts
    .slice()
    .sort((a, b) => toTimestamp(b.issuedAt) - toTimestamp(a.issuedAt));
  const latestReceipt = sortedReceipts[0];

  return {
    openCreditUsd,
    paidCreditUsd,
    overdueOpenCount,
    receiptCount: receipts.length,
    ...(latestReceipt ? { lastReceiptAt: latestReceipt.issuedAt, latestReceipt } : {}),
  };
};

const deriveSegments = (customer: Customer | undefined, normalizedPhone: string): CustomerMarketSegment[] => {
  if (customer?.marketSegments?.length) return uniqueSegments(customer.marketSegments);
  if (!normalizedPhone) return [];
  return normalizedPhone.startsWith('961') ? ['LOCAL_RESIDENT'] : ['EXPAT', 'TOURIST'];
};

const deriveTier = (customer: Customer | undefined, completedTrips: number, totalSpend: number): 'VIP' | 'REGULAR' | 'NEW' => {
  const markerText = `${customer?.name || ''} ${customer?.notes || ''}`;
  const hasVipMarker = /(^|\b)(vip|v\.i\.p)(\b|$)/i.test(markerText);
  if (hasVipMarker || totalSpend > 500 || completedTrips > 15) return 'VIP';
  if (completedTrips > 3) return 'REGULAR';
  return 'NEW';
};

const derivePreferredDriverId = (relatedTrips: Trip[]): string | undefined => {
  const nowMs = Date.now();
  const byDriver = new Map<string, { score: number; completed: number; lastTs: number }>();

  relatedTrips.forEach(trip => {
    if (!trip.driverId) return;

    const tripTs = toTimestamp(trip.tripDate || trip.createdAt);
    const ageDays = tripTs > 0 ? Math.max(0, (nowMs - tripTs) / (1000 * 60 * 60 * 24)) : 365;
    const recencyBoost = Math.max(0.4, 1.6 - Math.min(ageDays, 120) / 100);

    let delta = 0;
    if (trip.status === TripStatus.COMPLETED) {
      delta += 3.5;
      const rating = Number(trip.rating || 0);
      if (Number.isFinite(rating) && rating > 0) {
        delta += (rating - 3) * 0.6;
      }
      const surplusMin = Number(trip.surplusMin || 0);
      if (Number.isFinite(surplusMin)) {
        if (surplusMin <= 5) delta += 0.4;
        if (surplusMin > 15) delta -= 0.35;
      }
    } else if (trip.status === TripStatus.CANCELLED) {
      delta -= 2.2;
    } else if (trip.status === TripStatus.CONFIRMED) {
      delta += 0.6;
    }

    const weightedDelta = delta * recencyBoost;
    const current = byDriver.get(trip.driverId) || { score: 0, completed: 0, lastTs: 0 };

    byDriver.set(trip.driverId, {
      score: current.score + weightedDelta,
      completed: current.completed + (trip.status === TripStatus.COMPLETED ? 1 : 0),
      lastTs: Math.max(current.lastTs, tripTs),
    });
  });

  const ranked = Array.from(byDriver.entries()).sort((a, b) => {
    if (b[1].score !== a[1].score) return b[1].score - a[1].score;
    if (b[1].completed !== a[1].completed) return b[1].completed - a[1].completed;
    return b[1].lastTs - a[1].lastTs;
  });

  const top = ranked[0];
  if (!top) return undefined;
  if (top[1].completed === 0 && top[1].score <= 0) return undefined;
  return top[0];
};

export const buildCustomerSnapshotForTrip = (
  trip: Trip,
  customers: Customer[],
  trips: Trip[],
  drivers: Driver[],
  creditLedger: CreditLedgerEntry[],
  receipts: ReceiptRecord[]
): CustomerSnapshot => {
  return buildCustomerSnapshot(trip.customerName, trip.customerPhone, customers, trips, drivers, creditLedger, receipts, {
    driverContextId: trip.driverId,
  });
};

export const buildCustomerSnapshot = (
  customerName: string,
  customerPhone: string,
  customers: Customer[],
  trips: Trip[],
  drivers: Driver[],
  creditLedger: CreditLedgerEntry[],
  receipts: ReceiptRecord[],
  options?: { driverContextId?: string }
): CustomerSnapshot => {
  const normalizedPhone = customerPhoneKey(customerPhone);
  const customer = customers.find(entry => customerPhoneKey(entry.phone) === normalizedPhone);
  const relatedTrips = trips.filter(entry => customerPhoneKey(entry.customerPhone) === normalizedPhone);

  const completedTrips = relatedTrips.filter(entry => entry.status === TripStatus.COMPLETED);
  const cancelledTrips = relatedTrips.filter(entry => entry.status === TripStatus.CANCELLED);
  const totalTrips = relatedTrips.length;
  const totalSpend = completedTrips.reduce((sum, entry) => sum + entry.fareUsd, 0);
  const reliabilityScore = totalTrips > 0 ? Math.round((completedTrips.length / totalTrips) * 100) : 0;

  const preferredDriverId = derivePreferredDriverId(relatedTrips);
  const preferredDriverName = preferredDriverId
    ? drivers.find(driver => driver.id === preferredDriverId)?.name
    : undefined;

  const customerPartyIds = new Set<string>([
    normalizedPhone,
    customer?.id || '',
  ].map(value => lower(value)).filter(Boolean));
  const normalizedCustomerName = lower(customer?.name || customerName);

  const customerLedgerEntries = creditLedger.filter(entry => {
    if (entry.partyType !== 'CLIENT') return false;
    const partyIdMatch = customerPartyIds.has(lower(entry.partyId));
    if (partyIdMatch) return true;
    if (!entry.partyId) {
      return lower(entry.partyName) === normalizedCustomerName;
    }
    return false;
  });

  const customerEntryIds = new Set(customerLedgerEntries.map(entry => entry.id));
  const customerReceipts = receipts.filter(receipt => {
    if (receipt.partyType !== 'CLIENT') return false;
    if (customerEntryIds.has(receipt.ledgerEntryId)) return true;
    return lower(receipt.partyName) === normalizedCustomerName;
  });
  const customerSolvency = buildSolvencySnapshot(customerLedgerEntries, customerReceipts);

  const contextDriverId = options?.driverContextId || preferredDriverId;
  const contextDriver = contextDriverId ? drivers.find(driver => driver.id === contextDriverId) : undefined;
  let driverSolvency: CustomerSnapshot['driverSolvency'] | undefined;
  if (contextDriver) {
    const driverLedgerEntries = creditLedger.filter(entry => entry.partyType === 'DRIVER' && entry.partyId === contextDriver.id);
    const driverEntryIds = new Set(driverLedgerEntries.map(entry => entry.id));
    const driverReceipts = receipts.filter(receipt => receipt.partyType === 'DRIVER' && (driverEntryIds.has(receipt.ledgerEntryId) || lower(receipt.partyName) === lower(contextDriver.name)));
    const solvency = buildSolvencySnapshot(driverLedgerEntries, driverReceipts);
    driverSolvency = {
      driverId: contextDriver.id,
      driverName: contextDriver.name,
      openCreditUsd: solvency.openCreditUsd,
      paidCreditUsd: solvency.paidCreditUsd,
      overdueOpenCount: solvency.overdueOpenCount,
      receiptCount: solvency.receiptCount,
      ...(solvency.lastReceiptAt ? { lastReceiptAt: solvency.lastReceiptAt } : {}),
      ...(solvency.latestReceipt ? { latestReceipt: solvency.latestReceipt } : {}),
    };
  }

  const destinationFrequency: Record<string, number> = {};
  completedTrips.forEach(entry => {
    const key = (entry.destinationText || '').split(',')[0].trim();
    if (!key) return;
    destinationFrequency[key] = (destinationFrequency[key] || 0) + 1;
  });
  const commonDestinations = Object.entries(destinationFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(item => item[0]);

  const contactTimes = relatedTrips
    .flatMap(entry => [entry.confirmation_sent_at, entry.feedback_request_sent_at, entry.thank_you_sent_at])
    .filter((value): value is string => Boolean(value));
  const lastContactAt = contactTimes.length > 0
    ? contactTimes.sort((a, b) => toTimestamp(b) - toTimestamp(a))[0]
    : undefined;

  const timeline = Array.isArray(customer?.profileTimeline) ? customer!.profileTimeline : [];

  return {
    name: customer?.name || customerName || 'Walk-in Client',
    phone: customer?.phone || customerPhone,
    normalizedPhone,
    loyaltyTier: deriveTier(customer, completedTrips.length, totalSpend),
    marketSegments: deriveSegments(customer, normalizedPhone),
    reliabilityScore,
    totalTrips,
    completedTrips: completedTrips.length,
    cancelledTrips: cancelledTrips.length,
    ...(preferredDriverName ? { preferredDriverName } : {}),
    commonDestinations,
    ...(customer?.notes ? { notes: customer.notes } : {}),
    recentTimeline: timeline
      .slice()
      .sort((a, b) => toTimestamp(b.timestamp) - toTimestamp(a.timestamp))
      .slice(0, 2)
      .map(entry => entry.note),
    ...(lastContactAt ? { lastContactAt } : {}),
    ...(customer?.homeLocation?.address ? { homeAddress: customer.homeLocation.address } : {}),
    ...(customer?.businessLocation?.address ? { businessAddress: customer.businessLocation.address } : {}),
    frequentPlacesCount: Array.isArray(customer?.frequentLocations) ? customer!.frequentLocations.length : 0,
    openCreditUsd: customerSolvency.openCreditUsd,
    paidCreditUsd: customerSolvency.paidCreditUsd,
    overdueOpenCount: customerSolvency.overdueOpenCount,
    receiptCount: customerSolvency.receiptCount,
    ...(customerSolvency.lastReceiptAt ? { lastReceiptAt: customerSolvency.lastReceiptAt } : {}),
    ...(customerSolvency.latestReceipt ? { latestReceipt: customerSolvency.latestReceipt } : {}),
    ...(driverSolvency ? { driverSolvency } : {}),
  };
};
