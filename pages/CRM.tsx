
import React, { useMemo, useState, useRef, useEffect } from 'react';
import { useStore } from '../context/StoreContext';
import { Trip, TripStatus, Driver, Customer, CustomerEntityType, CustomerGender, CustomerLocation, CustomerMarketSegment, CustomerProfileEvent, DriverFuelLogEntry, DriverCostResponsibility, DriverVehicleOwnership, Settings, CreditLedgerEntry, ReceiptRecord, CreditPartyType, CreditCycle } from '../types';
import { 
  User, Users, Phone, MapPin, Search, Calendar, Star, DollarSign, 
  ShieldCheck, ArrowLeft, History, Award, AlertCircle,
  Hash, Clock, Navigation, Activity, Gauge, Wrench, 
  Droplet, Settings as Gear, Fuel, LayoutGrid, List,
  Car, RefreshCcw, PlusCircle, TrendingUp, Zap,
  Upload, Smartphone, FileJson, CheckCircle,
  X, Info, ChevronLeft, Download, Database, ShieldAlert,
  Archive, FileText, Share2, HardDrive, BarChart3, PieChart,
  ArrowUpRight, ArrowDownRight, Briefcase, ShieldQuestion,
  UserCheck, AlertOctagon, Heart, Map, ArrowUpDown, Loader2, UserX
} from 'lucide-react';
import { format, parseISO, differenceInDays, isToday, subDays } from 'date-fns';
import * as Storage from '../services/storageService';
import { parseContactsImport, ContactImportCandidate } from '../services/contactImport';
import { buildWhatsAppLink, normalizePhoneForWhatsApp } from '../services/whatsapp';
import { buildCustomerFromImportedContact, customerPhoneKey, mergeCustomerCollections } from '../services/customerProfile';
import { parseGoogleMapsLink, parseGpsOrLatLngInput } from '../services/locationParser';
import { createSyncSignature, fetchCloudSyncSignature, getCloudSyncDocId } from '../services/cloudSyncService';
import { DEFAULT_OWNER_DRIVER_COMPANY_SHARE_PERCENT, DEFAULT_COMPANY_CAR_DRIVER_GAS_COMPANY_SHARE_PERCENT, DEFAULT_OTHER_DRIVER_COMPANY_SHARE_PERCENT } from '../constants';

type ViewMode = 'CUSTOMERS' | 'FLEET' | 'FINANCE' | 'VAULT';
type CustomerSort = 'SPEND' | 'RECENCY' | 'FREQUENCY';

interface FleetUnitStats {
  driver: Driver;
  completedTrips: number;
  feedbackCount: number;
  totalOdometer: number;
  missionDistance: number;
  revenue: number;
  gasSpent: number;
  efficiency: number; 
  profitabilityIndex: number; 
  fuelBurnRatio: number; 
  oilChangeStatus: number; 
  checkupStatus: number; 
  fuelLevel: number;
  kmSinceOil: number; 
  kmSinceCheckup: number;
  kmSinceRefuel: number;
  isOilUrgent: boolean;
  isCheckupUrgent: boolean;
  isFuelLow: boolean;
  avgRating: number;
  ratingCount: number;
}

interface EnhancedCustomerProfile {
  id: string;
  name: string;
  phone: string;
  isInternational?: boolean;
  marketSegments?: CustomerMarketSegment[];
  gender?: CustomerGender;
  entityType?: CustomerEntityType;
  profession?: string;
  homeLocation?: CustomerLocation;
  businessLocation?: CustomerLocation;
  frequentLocations?: CustomerLocation[];
  notes?: string;
  profileTimeline?: CustomerProfileEvent[];
  totalTrips: number;
  completedTrips: number;
  cancelledTrips: number;
  totalSpend: number;
  lastTrip: string;
  recencyDays: number;
  loyaltyTier: 'VVIP' | 'VIP' | 'REGULAR' | 'NEW';
  history: Trip[];
  source: string;
  reliabilityScore: number;
  preferredDriverId?: string;
  preferredDriverName?: string;
  commonDestinations: string[];
  requirementTrends: string[];
}

interface FinanceDriverProfile {
  id: string;
  name: string;
  plateNumber: string;
  completedTrips: number;
  grossRevenue: number;
  avgFare: number;
  totalDistance: number;
  netAlpha: number;
  companyOwed: number;
  companyShareRate: number;
  shareRuleLabel: string;
  burnRatio: number;
  efficiency: number;
}

interface FinanceTotals {
  grossRevenue: number;
  netAlpha: number;
  companyOwed: number;
  totalGasSpent: number;
  completedTrips: number;
  avgFare: number;
  burnRatio: number;
}

const ownershipLabelMap: Record<DriverVehicleOwnership, string> = {
  COMPANY_FLEET: 'Company Fleet',
  OWNER_DRIVER: 'Owner Driver',
  RENTAL: 'Rental',
};

const responsibilityLabelMap: Record<DriverCostResponsibility, string> = {
  COMPANY: 'Company',
  DRIVER: 'Driver',
  SHARED: 'Shared',
};

const getFuelCostWeight = (responsibility?: DriverCostResponsibility): number => {
  if (responsibility === 'DRIVER') return 0;
  if (responsibility === 'SHARED') return 0.5;
  return 1;
};

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

interface VaultFeedItem {
  id: string;
  title: string;
  subtitle: string;
  tone: 'LIVE' | 'SAFE' | 'RESTORE' | 'DANGER';
}

interface SearchSuggestion {
  id: string;
  title: string;
  subtitle: string;
  loyaltyTier?: 'VIP' | 'VVIP';
}

interface PendingVaultImport {
  fileName: string;
  payload: unknown;
  inspection: Storage.BackupInspection;
}

interface PendingContactsImport {
  fileName: string;
  totalRows: number;
  rejectedRows: number;
  contacts: ContactImportCandidate[];
  errors: string[];
}

const SkeletonItem = () => (
  <div className="w-full p-5 border-b border-slate-100 dark:border-white/5 animate-pulse">
    <div className="flex justify-between items-start mb-3">
      <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-brand-800" />
      <div className="w-12 h-4 rounded bg-slate-100 dark:bg-brand-800" />
    </div>
    <div className="w-3/4 h-4 rounded bg-slate-100 dark:bg-brand-800 mb-2" />
    <div className="w-1/2 h-3 rounded bg-slate-100 dark:bg-brand-800" />
    <div className="flex justify-between mt-6">
      <div className="w-10 h-4 rounded bg-slate-100 dark:bg-brand-800" />
      <div className="w-10 h-4 rounded bg-slate-100 dark:bg-brand-800" />
    </div>
  </div>
);

const getLoyaltyTierTone = (tier?: 'VIP' | 'VVIP' | 'REGULAR' | 'NEW') => {
  if (tier === 'VIP') {
    return {
      suggestion: 'bg-slate-50/80 dark:bg-violet-900/10',
      card: 'ring-1 ring-slate-300/80 dark:ring-violet-700/40 bg-slate-50/70 dark:bg-violet-900/10',
      badge: 'border-slate-400 text-violet-700 bg-slate-50 dark:border-violet-700/50 dark:text-violet-300 dark:bg-violet-900/20',
      headerText: 'text-violet-700 dark:text-violet-300',
      label: '★ VIP',
    };
  }

  if (tier === 'VVIP') {
    return {
      suggestion: 'bg-amber-50/70 dark:bg-pink-900/10',
      card: 'ring-1 ring-amber-300/80 dark:ring-pink-700/40 bg-amber-50/60 dark:bg-pink-900/10',
      badge: 'border-amber-400 text-pink-700 bg-amber-50 dark:border-pink-700/50 dark:text-pink-300 dark:bg-pink-900/20',
      headerText: 'text-pink-700 dark:text-pink-300',
      label: '★★ VVIP',
    };
  }

  return {
    suggestion: '',
    card: '',
    badge: 'border-slate-300 text-slate-400 dark:border-slate-700',
    headerText: 'text-brand-900 dark:text-white',
    label: tier || 'NEW',
  };
};

export const CRMPage: React.FC = () => {
  const { trips, drivers, customers, creditLedger, receipts, alerts, settings, editDriver, addDriver, addCustomers, removeCustomerByPhone, addCreditLedgerEntry, settleCreditLedgerEntry, removeDriver, refreshData, hardResetCloudSync } = useStore();
  const [activeView, setActiveView] = useState<ViewMode>('CUSTOMERS');
  const [metricsWindow, setMetricsWindow] = useState<'TODAY' | '7D' | '30D' | 'ALL'>('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [customerSort] = useState<CustomerSort>('SPEND');
  const [isProcessing, setIsProcessing] = useState(true);
  const [vaultStatusMessage, setVaultStatusMessage] = useState('');
  const [vaultClearArmed, setVaultClearArmed] = useState(false);
  const [vaultBusyAction, setVaultBusyAction] = useState<'EXPORT' | 'IMPORT' | 'CLEAR' | null>(null);
  const [pendingVaultImport, setPendingVaultImport] = useState<PendingVaultImport | null>(null);
  const [vaultSyncStatus, setVaultSyncStatus] = useState<'IDLE' | 'CHECKING' | 'VERIFIED' | 'NOT_VERIFIED'>('IDLE');
  const [vaultSyncDetail, setVaultSyncDetail] = useState('');
  const [pendingContactsImport, setPendingContactsImport] = useState<PendingContactsImport | null>(null);
  const [coreStatusMessage, setCoreStatusMessage] = useState('');
  const [showSearchSuggestions, setShowSearchSuggestions] = useState(false);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const contactsImportRef = useRef<HTMLInputElement | null>(null);

  const now = new Date();
  const showOverviewMode = !selectedItem && (activeView === 'FINANCE' || activeView === 'VAULT');
  const syncChannel = useMemo(() => getCloudSyncDocId(), [vaultStatusMessage]);
  const contactPickerSupported = typeof navigator !== 'undefined' && typeof (navigator as any).contacts?.select === 'function';
  const savedPlacesSectionId = (phone: string) => `saved-places-${customerPhoneKey(phone)}`;
  const shouldShowMobileDetail = mobileDetailOpen && Boolean(selectedItem);

  const openDetailPanel = (id: string) => {
    setSelectedItem(id);
    setMobileDetailOpen(true);
  };

  const closeMobileDetailPanel = () => {
    setMobileDetailOpen(false);
  };

  const jumpToSavedPlaces = (phone: string) => {
    const targetId = savedPlacesSectionId(phone);
    openDetailPanel(phone);
    window.setTimeout(() => {
      const section = document.getElementById(targetId);
      if (!section) return;
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  };

  const searchPlaceholder =
    activeView === 'FINANCE'
      ? 'Search Yield Units...'
      : activeView === 'VAULT'
        ? 'Search Vault Actions...'
        : 'Intelligence Search...';

  const emptyStateTitle =
    activeView === 'FINANCE'
      ? 'No Financial Matches'
      : activeView === 'VAULT'
        ? 'No Vault Matches'
        : 'No Matches Identified';

  const emptyStateSubtitle =
    activeView === 'FINANCE'
      ? 'Search by driver name or plate number'
      : activeView === 'VAULT'
        ? 'Search by action name or purpose'
        : 'Refine search parameters';

    const metricsWindowLabel = metricsWindow === 'ALL'
      ? 'ALL-TIME'
      : metricsWindow;

    const isTripInMetricsWindow = (trip: Trip): boolean => {
      if (metricsWindow === 'ALL') return true;

      const stamp = trip.tripDate || trip.createdAt;
      const parsedDate = parseISO(stamp);
      if (Number.isNaN(parsedDate.getTime())) return false;
      if (metricsWindow === 'TODAY') return isToday(parsedDate);

      const now = new Date();
      const cutoff = metricsWindow === '7D' ? subDays(now, 6) : subDays(now, 29);
      return parsedDate >= cutoff;
    };

    const isTimestampInMetricsWindow = (timestamp?: string): boolean => {
      if (!timestamp) return false;
      if (metricsWindow === 'ALL') return true;

      const parsedDate = parseISO(timestamp);
      if (Number.isNaN(parsedDate.getTime())) return false;
      if (metricsWindow === 'TODAY') return isToday(parsedDate);

      const now = new Date();
      const cutoff = metricsWindow === '7D' ? subDays(now, 6) : subDays(now, 29);
      return parsedDate >= cutoff;
    };

    const getFuelLogUsd = (log: DriverFuelLogEntry): number => {
      const directUsd = Number(log.amountUsd);
      if (Number.isFinite(directUsd)) return Math.max(0, directUsd);

      const currency = String(log.currency || '').toUpperCase();
      const amountOriginal = Number(log.amountOriginal);
      const amountLbp = Number(log.amountLbp);
      const fxSnapshot = Number(log.fxRateSnapshot);
      const fxRate = Number.isFinite(fxSnapshot) && fxSnapshot > 0
        ? fxSnapshot
        : (Number(settings.exchangeRate) > 0 ? Number(settings.exchangeRate) : 90000);

      if (currency === 'LBP') {
        const lbpValue = Number.isFinite(amountOriginal) ? amountOriginal : (Number.isFinite(amountLbp) ? amountLbp : 0);
        return fxRate > 0 ? Math.max(0, lbpValue / fxRate) : 0;
      }

      return Number.isFinite(amountOriginal) ? Math.max(0, amountOriginal) : 0;
    };

    const estimateFuelUsdFromDistance = (distanceKm: number): number => {
      const safeDistanceKm = Number.isFinite(distanceKm) ? Math.max(0, distanceKm) : 0;
      const safeFuelPrice = Number.isFinite(settings.fuelPriceUsdPerLiter)
        ? Math.max(0, settings.fuelPriceUsdPerLiter)
        : 0;
      const ESTIMATED_KM_PER_LITER = 10;
      const litersUsed = safeDistanceKm / ESTIMATED_KM_PER_LITER;
      return litersUsed * safeFuelPrice;
    };

    const getDriverFuelUsdForWindow = (driver: Driver, windowDistanceKm: number): number => {
      const driverFuelLogs = Array.isArray(driver.fuelLogs) ? driver.fuelLogs : [];
      if (driverFuelLogs.length > 0) {
        const scopedLogs = driverFuelLogs.filter(log => isTimestampInMetricsWindow(log.timestamp));
        if (scopedLogs.length > 0) {
          return scopedLogs.reduce((sum, log) => sum + getFuelLogUsd(log), 0);
        }
      }

      if (metricsWindow === 'ALL' && Number(driver.totalGasSpent) > 0) {
        return Number(driver.totalGasSpent);
      }

      return estimateFuelUsdFromDistance(windowDistanceKm);
    };

  useEffect(() => {
    setIsProcessing(true);
    const timer = setTimeout(() => setIsProcessing(false), 800);
    return () => clearTimeout(timer);
  }, [activeView]);

  useEffect(() => {
    setShowSearchSuggestions(false);
  }, [activeView]);

  useEffect(() => {
    setSearchTerm('');
    setSelectedItem(null);
    setMobileDetailOpen(false);
  }, [activeView]);

  useEffect(() => {
    if (activeView === 'FLEET' || activeView === 'FINANCE') {
      refreshData();
    }
  }, [activeView, refreshData]);

  const customerProfiles = useMemo((): EnhancedCustomerProfile[] => {
    const profiles: Record<string, any> = {};
    const inferGender = (name?: string, notes?: string): CustomerGender => {
      const text = `${name || ''} ${notes || ''}`.toLowerCase();
      const male = /(^|\s)(mr\.?|mister|sir|السيد)(\s|$)/.test(text);
      const female = /(^|\s)(mrs\.?|ms\.?|miss|madam|السيدة|آنسة)(\s|$)/.test(text);
      if (male && !female) return 'MALE';
      if (female && !male) return 'FEMALE';
      return 'UNSPECIFIED';
    };
    const driverPhoneKeys = new Set(
      drivers
        .map(driver => customerPhoneKey(driver.phone))
        .filter(Boolean)
    );
    
    customers.forEach(c => {
      const key = customerPhoneKey(c.phone);
      if (driverPhoneKeys.has(key)) return;
      profiles[key] = {
        id: c.id, name: c.name, phone: key, isInternational: c.isInternational, marketSegments: c.marketSegments, gender: c.gender || inferGender(c.name, c.notes), entityType: c.entityType || 'UNSPECIFIED', profession: c.profession || '', homeLocation: c.homeLocation, businessLocation: c.businessLocation, frequentLocations: c.frequentLocations, notes: c.notes, profileTimeline: c.profileTimeline, totalTrips: 0,
        completedTrips: 0, cancelledTrips: 0, totalSpend: 0,
        lastTrip: c.createdAt, history: [], source: c.source,
        driverFrequency: {} as Record<string, number>,
        destFrequency: {} as Record<string, number>,
        reqFrequency: {} as Record<string, number>
      };
    });

    trips.forEach(trip => {
      const tripKey = customerPhoneKey(trip.customerPhone);
      if (driverPhoneKeys.has(tripKey)) return;
      if (!profiles[tripKey]) {
        profiles[tripKey] = {
          id: 'temp-' + tripKey, name: trip.customerName, phone: tripKey,
          isInternational: !tripKey.startsWith('961'),
          marketSegments: !tripKey.startsWith('961') ? ['EXPAT', 'TOURIST'] : ['LOCAL_RESIDENT'],
          gender: inferGender(trip.customerName, trip.notes),
          entityType: 'UNSPECIFIED',
          profession: '',
          homeLocation: undefined,
          businessLocation: undefined,
          frequentLocations: [],
          totalTrips: 0, completedTrips: 0, cancelledTrips: 0, totalSpend: 0,
          lastTrip: trip.createdAt, history: [], source: 'OPERATIONAL',
          driverFrequency: {} as Record<string, number>,
          destFrequency: {} as Record<string, number>,
          reqFrequency: {} as Record<string, number>
        };
      }
      const p = profiles[tripKey];
      p.totalTrips++;
      p.history.push(trip);
      
      if (trip.status === TripStatus.COMPLETED) {
        p.completedTrips++;
        p.totalSpend += trip.fareUsd;
        if (trip.driverId) p.driverFrequency[trip.driverId] = (p.driverFrequency[trip.driverId] || 0) + 1;
        const destKey = trip.destinationText.split(',')[0];
        p.destFrequency[destKey] = (p.destFrequency[destKey] || 0) + 1;
        trip.specialRequirements?.forEach(reqId => { p.reqFrequency[reqId] = (p.reqFrequency[reqId] || 0) + 1; });
      } else if (trip.status === TripStatus.CANCELLED) {
        p.cancelledTrips++;
      }
      const tDate = trip.tripDate ? parseISO(trip.tripDate) : parseISO(trip.createdAt);
      if (tDate > parseISO(p.lastTrip)) p.lastTrip = tDate.toISOString();
    });

    return Object.values(profiles).map((p: any) => {
      const reliability = p.totalTrips > 0 ? Math.round((p.completedTrips / p.totalTrips) * 100) : 0;
      const recencyDays = differenceInDays(now, parseISO(p.lastTrip));
      const hasVvipMarker = /(^|\b)(vvip|v\.v\.i\.p)(\b|$)/i.test(`${p.name || ''} ${p.notes || ''}`);
      const hasVipMarker = /(^|\b)(vip|v\.i\.p)(\b|$)/i.test(`${p.name || ''} ${p.notes || ''}`);
      let tier: 'VVIP' | 'VIP' | 'REGULAR' | 'NEW' = 'NEW';
      if (hasVvipMarker) tier = 'VVIP';
      else if (hasVipMarker || p.totalSpend > 500 || p.completedTrips > 15) tier = 'VIP';
      else if (p.completedTrips > 3) tier = 'REGULAR';
      const prefDriverId = Object.entries(p.driverFrequency).sort((a: any, b: any) => b[1] - a[1])[0]?.[0];
      const prefDriverName = drivers.find(d => d.id === prefDriverId)?.name;
      const commonDests = Object.entries(p.destFrequency).sort((a: any, b: any) => b[1] - a[1]).slice(0, 2).map(e => e[0]);
      const reqTrends = Object.entries(p.reqFrequency).sort((a: any, b: any) => b[1] - a[1]).slice(0, 3).map(e => e[0]);

      return {
        ...p,
        reliabilityScore: reliability,
        recencyDays,
        loyaltyTier: tier,
        preferredDriverId: prefDriverId,
        preferredDriverName: prefDriverName,
        commonDestinations: commonDests,
        requirementTrends: reqTrends,
        history: p.history.sort((a: Trip, b: Trip) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      };
    }).sort((a, b) => {
      if (customerSort === 'SPEND') return b.totalSpend - a.totalSpend;
      if (customerSort === 'FREQUENCY') return b.completedTrips - a.completedTrips;
      return a.recencyDays - b.recencyDays;
    });
  }, [trips, customers, drivers, customerSort]);

  const fleetHealth = useMemo((): FleetUnitStats[] => {
    return drivers.map(d => {
      const dTrips = trips.filter(t => t.driverId === d.id && t.status === TripStatus.COMPLETED && isTripInMetricsWindow(t));
      const completedTrips = dTrips.length;
      const feedbackCount = dTrips.filter(t => typeof t.feedback === 'string' && t.feedback.trim().length > 0).length;
      const missionDistance = dTrips.reduce((acc, t) => acc + t.distanceKm, 0);
      const totalOdometer = d.baseMileage + missionDistance;
      const kmSinceOil = Math.max(0, totalOdometer - d.lastOilChangeKm);
      const kmSinceCheckup = Math.max(0, totalOdometer - d.lastCheckupKm);
      const refuelReferenceKm = d.lastRefuelKm ?? d.baseMileage;
      const kmSinceRefuel = Math.max(0, totalOdometer - refuelReferenceKm);
      const normalizedFuelRange = d.fuelRangeKm > 0 ? d.fuelRangeKm : 500;

      const oilStatus = Math.max(0, Math.min(100, (1 - kmSinceOil / 5000) * 100));
      const checkupStatus = Math.max(0, Math.min(100, (1 - kmSinceCheckup / 10000) * 100));
      const fuelStatus = Math.max(0, Math.min(100, (1 - kmSinceRefuel / normalizedFuelRange) * 100));

      const tripsWithRating = dTrips.filter(t => t.rating !== undefined);
      const totalRating = tripsWithRating.reduce((acc, t) => acc + (t.rating || 0), 0);
      const avgRating = tripsWithRating.length > 0 ? totalRating / tripsWithRating.length : 0;
      const ratingCount = tripsWithRating.length;

      const revenue = dTrips.reduce((acc, t) => acc + t.fareUsd, 0);
      const fuelSpendForWindow = getDriverFuelUsdForWindow(d, missionDistance);
      const accountableFuelSpend = fuelSpendForWindow * getFuelCostWeight(d.fuelCostResponsibility);
      return {
        driver: d, completedTrips, feedbackCount, totalOdometer, missionDistance, revenue, gasSpent: accountableFuelSpend,
        efficiency: missionDistance > 0 ? (revenue / missionDistance) : 0,
        profitabilityIndex: revenue - accountableFuelSpend,
        fuelBurnRatio: revenue > 0 ? (accountableFuelSpend / revenue) : 0,
        oilChangeStatus: Math.round(oilStatus), 
        checkupStatus: Math.round(checkupStatus),
        fuelLevel: Math.round(fuelStatus),
        kmSinceOil: Math.round(kmSinceOil), 
        kmSinceCheckup: Math.round(kmSinceCheckup),
        kmSinceRefuel: Math.round(kmSinceRefuel),
        isOilUrgent: oilStatus < 15, 
        isCheckupUrgent: checkupStatus < 15,
        isFuelLow: fuelStatus < 15,
        avgRating,
        ratingCount
      };
    });
  }, [trips, drivers, metricsWindow, settings.exchangeRate, settings.fuelPriceUsdPerLiter]);

  const financeRows = useMemo((): FinanceDriverProfile[] => {
    const completedTrips = trips.filter(t => t.status === TripStatus.COMPLETED && isTripInMetricsWindow(t));

    return drivers.map(driver => {
      const dTrips = completedTrips.filter(t => t.driverId === driver.id);
      const grossRevenue = dTrips.reduce((acc, t) => acc + t.fareUsd, 0);
      const totalDistance = dTrips.reduce((acc, t) => acc + t.distanceKm, 0);
      const completedCount = dTrips.length;
      const avgFare = completedCount > 0 ? grossRevenue / completedCount : 0;
      const driverGasShare = getDriverFuelUsdForWindow(driver, totalDistance);
      const accountableGasShare = driverGasShare * getFuelCostWeight(driver.fuelCostResponsibility);
      const netAlpha = grossRevenue - accountableGasShare;
      const companyShare = getCompanyShareForDriver(driver, settings);
      const companyOwed = grossRevenue * companyShare.rate;

      return {
        id: driver.id,
        name: driver.name,
        plateNumber: driver.plateNumber,
        completedTrips: completedCount,
        grossRevenue,
        avgFare,
        totalDistance,
        netAlpha,
        companyOwed,
        companyShareRate: companyShare.rate,
        shareRuleLabel: companyShare.label,
        burnRatio: grossRevenue > 0 ? accountableGasShare / grossRevenue : 0,
        efficiency: totalDistance > 0 ? grossRevenue / totalDistance : 0,
      };
    }).sort((a, b) => b.netAlpha - a.netAlpha);
  }, [trips, drivers, metricsWindow, settings.fuelPriceUsdPerLiter, settings.ownerDriverCompanySharePercent, settings.companyCarDriverGasCompanySharePercent, settings.otherDriverCompanySharePercent]);

  const financeTotals = useMemo((): FinanceTotals => {
    const completedTrips = trips.filter(t => t.status === TripStatus.COMPLETED && isTripInMetricsWindow(t));
    const grossRevenue = completedTrips.reduce((acc, t) => acc + t.fareUsd, 0);
    const companyOwed = drivers.reduce((acc, d) => {
      const driverTrips = completedTrips.filter(t => t.driverId === d.id);
      const driverRevenue = driverTrips.reduce((sum, t) => sum + t.fareUsd, 0);
      return acc + (driverRevenue * getCompanyShareForDriver(d, settings).rate);
    }, 0);
    const totalGasSpent = drivers.reduce((acc, d) => {
      const driverTrips = completedTrips.filter(t => t.driverId === d.id);
      const driverDistance = driverTrips.reduce((sum, t) => sum + t.distanceKm, 0);
      const scopedFuel = getDriverFuelUsdForWindow(d, driverDistance);
      return acc + (scopedFuel * getFuelCostWeight(d.fuelCostResponsibility));
    }, 0);
    const completedCount = completedTrips.length;

    return {
      grossRevenue,
      netAlpha: grossRevenue - totalGasSpent,
      companyOwed,
      totalGasSpent,
      completedTrips: completedCount,
      avgFare: completedCount > 0 ? grossRevenue / completedCount : 0,
      burnRatio: grossRevenue > 0 ? totalGasSpent / grossRevenue : 0,
    };
  }, [trips, drivers, metricsWindow, settings.exchangeRate, settings.fuelPriceUsdPerLiter, settings.ownerDriverCompanySharePercent, settings.companyCarDriverGasCompanySharePercent, settings.otherDriverCompanySharePercent]);

  const vaultItems = useMemo((): VaultFeedItem[] => {
    return [
      {
        id: 'STATUS',
        title: 'System Status',
        subtitle: `${trips.length} trips · ${drivers.length} drivers · ${customers.length} customers`,
        tone: 'LIVE',
      },
      {
        id: 'EXPORT',
        title: 'Export Backup',
        subtitle: 'Download full JSON backup',
        tone: 'SAFE',
      },
      {
        id: 'IMPORT',
        title: 'Import Backup',
        subtitle: 'Restore from backup JSON',
        tone: 'RESTORE',
      },
      {
        id: 'CLEAR',
        title: 'Hard Reset Sync',
        subtitle: 'Clear data and force cloud reset',
        tone: 'DANGER',
      },
    ];
  }, [trips.length, drivers.length, customers.length]);

  const runVaultSyncAudit = async (): Promise<{ ok: boolean; reason?: string }> => {
    const localPayload = Storage.getFullSystemData({ includeSettings: true });
    const localSignature = createSyncSignature(localPayload);
    const remoteSignatureResult = await fetchCloudSyncSignature();

    if (!remoteSignatureResult.ok || !remoteSignatureResult.signature) {
      return { ok: false, reason: remoteSignatureResult.reason || 'Cloud signature is unavailable.' };
    }

    if (remoteSignatureResult.signature !== localSignature) {
      return {
        ok: false,
        reason: 'This device is not fully aligned with cloud state yet. Wait for sync on both devices, then retry.',
      };
    }

    return { ok: true };
  };

  useEffect(() => {
    if (activeView !== 'VAULT') {
      setVaultSyncStatus('IDLE');
      setVaultSyncDetail('');
      return;
    }

    let cancelled = false;

    const evaluate = async () => {
      setVaultSyncStatus('CHECKING');
      const audit = await runVaultSyncAudit();
      if (cancelled) return;

      if (audit.ok) {
        setVaultSyncStatus('VERIFIED');
        setVaultSyncDetail('Vault sync verified across cloud and local state.');
        return;
      }

      setVaultSyncStatus('NOT_VERIFIED');
      setVaultSyncDetail(audit.reason || 'Vault sync verification failed.');
    };

    void evaluate();
    const interval = window.setInterval(() => {
      void evaluate();
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeView, trips.length, drivers.length, customers.length, alerts.length]);

  const handleVaultExport = async () => {
    setVaultBusyAction('EXPORT');
    try {
      const syncAudit = await runVaultSyncAudit();
      if (!syncAudit.ok) {
        setVaultStatusMessage(`Pre-export sync check failed: ${syncAudit.reason || 'unknown reason'}`);
        return;
      }

      const payload = Storage.getFullSystemData({ includeSettings: false });
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `control-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setVaultStatusMessage('Backup exported safely (settings excluded).');
    } catch {
      setVaultStatusMessage('Backup export failed.');
    } finally {
      setVaultBusyAction(null);
    }
  };

  const handleVaultImportClick = () => {
    importFileRef.current?.click();
  };

  const handleVaultImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setVaultBusyAction('IMPORT');
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw);
      const inspection = Storage.inspectFullSystemBackup(parsed);
      if (!inspection.isValid) {
        setPendingVaultImport(null);
        setVaultStatusMessage(inspection.error || 'Backup import failed. Invalid backup structure.');
        return;
      }

      setPendingVaultImport({ fileName: file.name, payload: parsed, inspection });
      setVaultStatusMessage('Backup parsed. Review and confirm import to apply changes.');
    } catch {
      setVaultStatusMessage('Backup import failed. Invalid JSON or data format.');
    } finally {
      event.target.value = '';
      setVaultBusyAction(null);
    }
  };

  const handleVaultConfirmImport = async () => {
    if (!pendingVaultImport) return;

    setVaultBusyAction('IMPORT');
    try {
      const syncAudit = await runVaultSyncAudit();
      if (!syncAudit.ok) {
        setVaultStatusMessage(`Pre-import sync check failed: ${syncAudit.reason || 'unknown reason'}`);
        return;
      }

      const result = Storage.restoreFullSystemData(pendingVaultImport.payload);
      if (!result.ok) {
        setVaultStatusMessage(result.error || 'Backup import failed.');
        return;
      }

      refreshData();
      setPendingVaultImport(null);
      const appliedSections = Object.entries(result.applied)
        .filter(([, applied]) => applied)
        .map(([name]) => name.toUpperCase())
        .join(', ');
      setVaultStatusMessage(`Backup import applied: ${appliedSections || 'NONE'}.`);
    } catch {
      setVaultStatusMessage('Backup import failed during restore.');
    } finally {
      setVaultBusyAction(null);
    }
  };

  const handleVaultCancelImport = () => {
    setPendingVaultImport(null);
    setVaultStatusMessage('Backup import canceled.');
  };

  const handleVaultClear = async () => {
    if (!vaultClearArmed) {
      setVaultClearArmed(true);
      setVaultStatusMessage('Click Hard Reset again to confirm. This clears data and force-resets the current sync channel.');
      return;
    }

    setVaultBusyAction('CLEAR');
    try {
      const result = await hardResetCloudSync();

      setVaultClearArmed(false);
      setPendingVaultImport(null);
      if (!result.ok) {
        setVaultStatusMessage(`Hard reset failed: ${result.reason || 'unknown reason'}`);
        setVaultSyncStatus('NOT_VERIFIED');
        setVaultSyncDetail(result.reason || 'Hard reset failed.');
      } else {
        const nextChannel = result.nextDocId || 'unknown';
        let copied = false;
        if (result.nextDocId) {
          try {
            await navigator.clipboard.writeText(result.nextDocId);
            copied = true;
          } catch {
            copied = false;
          }
        }

        setVaultStatusMessage(
          copied
            ? `Hard reset complete. Active sync channel copied: ${nextChannel}. Reloading in 3s...`
            : `Hard reset complete. Active sync channel: ${nextChannel}. Copy it now. Reloading in 3s...`
        );
        setVaultSyncStatus('CHECKING');
        setVaultSyncDetail(`Switching to ${nextChannel}...`);
        window.setTimeout(() => {
          window.location.reload();
        }, 3000);
      }
    } catch {
      setVaultClearArmed(false);
      setVaultStatusMessage('Hard reset failed.');
    } finally {
      setVaultBusyAction(null);
    }
  };

  const handleVaultClearCancel = () => {
    setVaultClearArmed(false);
    setVaultStatusMessage('Clear operation canceled.');
  };

  const handleCopySyncChannel = async () => {
    try {
      await navigator.clipboard.writeText(syncChannel);
      setVaultStatusMessage(`Sync channel copied: ${syncChannel}`);
    } catch {
      setVaultStatusMessage('Failed to copy sync channel.');
    }
  };

  const filteredItems = useMemo(() => {
    const lower = searchTerm.toLowerCase();
    if (activeView === 'CUSTOMERS') {
      return customerProfiles.filter(p => {
        const basic = p.name.toLowerCase().includes(lower) || p.phone.includes(searchTerm);
        if (basic) return true;
        
        // Match against history
        return p.history.some(t => 
          t.pickupText.toLowerCase().includes(lower) || 
          t.destinationText.toLowerCase().includes(lower) ||
          t.notes.toLowerCase().includes(lower)
        );
      });
    }
    if (activeView === 'FLEET') {
      return fleetHealth.filter(f => 
        f.driver.name.toLowerCase().includes(lower) || 
        f.driver.plateNumber.toLowerCase().includes(lower) ||
        f.driver.carModel.toLowerCase().includes(lower)
      );
    }
    if (activeView === 'FINANCE') {
      return financeRows.filter(row =>
        row.name.toLowerCase().includes(lower) ||
        row.plateNumber.toLowerCase().includes(lower)
      );
    }
    if (activeView === 'VAULT') {
      return vaultItems.filter(item =>
        item.title.toLowerCase().includes(lower) ||
        item.subtitle.toLowerCase().includes(lower)
      );
    }
    return [];
  }, [activeView, customerProfiles, fleetHealth, financeRows, vaultItems, searchTerm]);

  const searchSuggestions = useMemo((): SearchSuggestion[] => {
    if (!searchTerm.trim()) return [];

    if (activeView === 'CUSTOMERS') {
      return (filteredItems as EnhancedCustomerProfile[]).slice(0, 6).map(profile => ({
        id: profile.phone,
        title: profile.name,
        subtitle: profile.phone,
        loyaltyTier: profile.loyaltyTier === 'VIP' || profile.loyaltyTier === 'VVIP' ? profile.loyaltyTier : undefined,
      }));
    }

    if (activeView === 'FLEET') {
      return (filteredItems as FleetUnitStats[]).slice(0, 6).map(profile => ({
        id: profile.driver.id,
        title: profile.driver.name,
        subtitle: `${profile.driver.plateNumber} · ${profile.driver.carModel}`,
      }));
    }

    if (activeView === 'FINANCE') {
      return (filteredItems as FinanceDriverProfile[]).slice(0, 6).map(profile => ({
        id: profile.id,
        title: profile.name,
        subtitle: `${profile.plateNumber} · $${profile.netAlpha.toFixed(0)} net`,
      }));
    }

    return (filteredItems as VaultFeedItem[]).slice(0, 6).map(profile => ({
      id: profile.id,
      title: profile.title,
      subtitle: profile.subtitle,
    }));
  }, [activeView, filteredItems, searchTerm]);

  const handleSuggestionSelect = (id: string) => {
    openDetailPanel(id);
    setShowSearchSuggestions(false);
  };

  const handleRefuel = (stats: FleetUnitStats) => {
    const currencyInput = window.prompt('Refuel currency (USD or LBP)', 'USD');
    if (currencyInput === null) return;
    const currency = currencyInput.trim().toUpperCase() === 'LBP' ? 'LBP' : (currencyInput.trim().toUpperCase() === 'USD' ? 'USD' : null);
    if (!currency) {
      showCoreStatus('Currency must be USD or LBP.');
      return;
    }

    const amountInput = window.prompt(`Refuel amount in ${currency}`, '0');
    if (amountInput === null) return;
    const amountOriginal = Number(amountInput);
    if (!Number.isFinite(amountOriginal) || amountOriginal < 0) {
      showCoreStatus('Refuel amount must be a valid non-negative number.');
      return;
    }

    const defaultFx = Number(settings.exchangeRate) > 0 ? Number(settings.exchangeRate) : 90000;
    const fxInput = currency === 'LBP'
      ? window.prompt('FX snapshot (LBP per 1 USD)', String(Math.round(defaultFx)))
      : String(Math.round(defaultFx));
    if (fxInput === null) return;
    const fxRateSnapshot = Number(fxInput);
    if (!Number.isFinite(fxRateSnapshot) || fxRateSnapshot <= 0) {
      showCoreStatus('FX snapshot must be a valid number greater than zero.');
      return;
    }

    const amountUsd = currency === 'LBP'
      ? (amountOriginal / fxRateSnapshot)
      : amountOriginal;
    const amountLbp = currency === 'LBP'
      ? amountOriginal
      : (amountOriginal * fxRateSnapshot);

    const existingLogs = Array.isArray(stats.driver.fuelLogs) ? stats.driver.fuelLogs : [];
    editDriver({
      ...stats.driver,
      lastRefuelKm: stats.totalOdometer,
      totalGasSpent: Math.max(0, (stats.driver.totalGasSpent || 0) + amountUsd),
      fuelLogs: [
        ...existingLogs,
        {
          id: `fuel-${stats.driver.id}-${Date.now()}`,
          timestamp: new Date().toISOString(),
          amountUsd,
          amountOriginal,
          currency,
          fxRateSnapshot,
          amountLbp,
          odometerKm: stats.totalOdometer,
          note: 'Fleet refuel log',
        },
      ]
    });
    showCoreStatus(
      currency === 'LBP'
        ? `Refuel logged for ${stats.driver.name}: ${Math.round(amountOriginal).toLocaleString()} LBP (≈ $${amountUsd.toFixed(2)} @ ${Math.round(fxRateSnapshot).toLocaleString()}).`
        : `Refuel logged for ${stats.driver.name}: $${amountUsd.toFixed(2)}.`
    );
  };

  const handleUpdateFleetGovernance = (
    stats: FleetUnitStats,
    payload: {
      vehicleOwnership: DriverVehicleOwnership;
      fuelCostResponsibility: DriverCostResponsibility;
      maintenanceResponsibility: DriverCostResponsibility;
      fuelRangeKm: number;
      companyShareOverridePercent?: number;
    }
  ) => {
    if (!Number.isFinite(payload.fuelRangeKm) || payload.fuelRangeKm <= 0) {
      showCoreStatus('Fuel range must be a valid number greater than zero.');
      return;
    }

    editDriver({
      ...stats.driver,
      vehicleOwnership: payload.vehicleOwnership,
      fuelCostResponsibility: payload.fuelCostResponsibility,
      maintenanceResponsibility: payload.maintenanceResponsibility,
      fuelRangeKm: Math.round(payload.fuelRangeKm),
      companyShareOverridePercent: typeof payload.companyShareOverridePercent === 'number' && Number.isFinite(payload.companyShareOverridePercent)
        ? Math.max(0, Math.min(100, payload.companyShareOverridePercent))
        : undefined,
    });
    showCoreStatus(`Asset governance updated for ${stats.driver.name}.`);
  };

  const showCoreStatus = (message: string) => {
    setCoreStatusMessage(message);
    setTimeout(() => setCoreStatusMessage(''), 3500);
  };

  const handleContactsFileImportClick = () => {
    contactsImportRef.current?.click();
  };

  const handleContactsImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const report = parseContactsImport(file.name, text);

      if (report.valid.length === 0) {
        setPendingContactsImport(null);
        showCoreStatus(report.errors[0] || 'No valid contacts found to import.');
        return;
      }

      setPendingContactsImport({
        fileName: file.name,
        totalRows: report.totalRows,
        rejectedRows: report.rejected,
        contacts: report.valid,
        errors: report.errors,
      });
      showCoreStatus(`Parsed ${report.valid.length} valid contacts from ${report.totalRows} rows. Review and merge.`);
    } catch {
      setPendingContactsImport(null);
      showCoreStatus('Contacts import failed. Unsupported file format or invalid data.');
    } finally {
      event.target.value = '';
    }
  };

  const handleContactsPhoneExtract = async () => {
    if (!contactPickerSupported) {
      contactsImportRef.current?.click();
      showCoreStatus('Direct phone picker is not supported on this browser. Select a contacts file (VCF/CSV/JSON) to continue.');
      return;
    }

    try {
      const rawContacts = await (navigator as any).contacts.select(['name', 'tel'], { multiple: true });
      if (!Array.isArray(rawContacts) || rawContacts.length === 0) {
        showCoreStatus('No contacts selected from device.');
        return;
      }

      const valid: ContactImportCandidate[] = [];
      let rejected = 0;

      rawContacts.forEach((entry: any) => {
        const rawName = Array.isArray(entry?.name) ? String(entry.name[0] || '').trim() : String(entry?.name || '').trim();
        const rawTel = Array.isArray(entry?.tel) ? String(entry.tel[0] || '').trim() : String(entry?.tel || '').trim();
        const normalizedPhone = normalizePhoneForWhatsApp(rawTel);

        if (!rawName || !normalizedPhone) {
          rejected += 1;
          return;
        }

        valid.push({ name: rawName, phone: normalizedPhone });
      });

      if (valid.length === 0) {
        setPendingContactsImport(null);
        showCoreStatus('No valid contacts extracted from selected device entries.');
        return;
      }

      setPendingContactsImport({
        fileName: 'Device Contacts',
        totalRows: rawContacts.length,
        rejectedRows: rejected,
        contacts: valid,
        errors: rejected > 0 ? [`${rejected} contact(s) were skipped due to missing name/phone.`] : [],
      });
      showCoreStatus(`Extracted ${valid.length} valid contacts from phone. Review and merge.`);
    } catch {
      showCoreStatus('Phone contacts extraction failed or was canceled.');
    }
  };

  const handleContactsExport = () => {
    if (customers.length === 0) {
      showCoreStatus('No contacts available to export.');
      return;
    }

    const escapeCsv = (value: unknown): string => {
      const text = String(value ?? '');
      if (text.includes('"') || text.includes(',') || text.includes('\n')) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    };

    const headers = [
      'id',
      'name',
      'phone',
      'source',
      'is_international',
      'market_segments',
      'gender',
      'entity_type',
      'profession',
      'home_address',
      'home_maps_link',
      'home_lat',
      'home_lng',
      'business_address',
      'business_maps_link',
      'business_lat',
      'business_lng',
      'frequent_locations_json',
      'created_at',
      'last_enriched_at',
      'notes',
      'profile_timeline_count',
      'profile_timeline_json',
    ];
    const rows = customers.map(contact => [
      contact.id,
      contact.name,
      contact.phone,
      contact.source,
      contact.isInternational ? 'true' : 'false',
      Array.isArray(contact.marketSegments) ? contact.marketSegments.join('|') : '',
      contact.gender || 'UNSPECIFIED',
      contact.entityType || 'UNSPECIFIED',
      contact.profession || '',
      contact.homeLocation?.address || '',
      contact.homeLocation?.mapsLink || '',
      typeof contact.homeLocation?.lat === 'number' ? contact.homeLocation.lat : '',
      typeof contact.homeLocation?.lng === 'number' ? contact.homeLocation.lng : '',
      contact.businessLocation?.address || '',
      contact.businessLocation?.mapsLink || '',
      typeof contact.businessLocation?.lat === 'number' ? contact.businessLocation.lat : '',
      typeof contact.businessLocation?.lng === 'number' ? contact.businessLocation.lng : '',
      JSON.stringify(contact.frequentLocations || []),
      contact.createdAt,
      contact.lastEnrichedAt || '',
      contact.notes || '',
      Array.isArray(contact.profileTimeline) ? contact.profileTimeline.length : 0,
      JSON.stringify(contact.profileTimeline || []),
    ].map(escapeCsv).join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `control-contacts-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    showCoreStatus(`Exported ${customers.length} contacts with profile data.`);
  };

  const handleConfirmContactsImport = () => {
    if (!pendingContactsImport) return;

    const shouldRouteToFleet = (name: string, notes?: string) => {
      return /\b(driver|delivery|taxi|cab)\b/i.test(`${name || ''} ${notes || ''}`);
    };

    const existingDriverPhones = new Set(
      drivers.map(driver => normalizePhoneForWhatsApp(driver.phone) || driver.phone.trim())
    );
    const existingPlates = new Set(drivers.map(driver => driver.plateNumber.toUpperCase()));

    const allocatePlate = (seed: number) => {
      let suffix = String(seed).padStart(4, '0').slice(-4);
      let plate = `IMP-${suffix}`;
      while (existingPlates.has(plate)) {
        seed += 1;
        suffix = String(seed).padStart(4, '0').slice(-4);
        plate = `IMP-${suffix}`;
      }
      existingPlates.add(plate);
      return plate;
    };

    let fleetAdded = 0;
    let fleetSkipped = 0;
    const customerCandidates = pendingContactsImport.contacts.filter((contact, index) => {
      if (!shouldRouteToFleet(contact.name, contact.notes)) return true;

      const normalizedPhone = normalizePhoneForWhatsApp(contact.phone) || contact.phone.trim();
      if (!normalizedPhone || existingDriverPhones.has(normalizedPhone)) {
        fleetSkipped += 1;
        return false;
      }

      existingDriverPhones.add(normalizedPhone);
      addDriver({
        id: `imp-driver-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
        name: contact.name,
        phone: normalizedPhone,
        carModel: 'Imported Unit',
        plateNumber: allocatePlate(Date.now() + index),
        status: 'ACTIVE',
        currentStatus: 'OFF_DUTY',
        vehicleOwnership: 'COMPANY_FLEET',
        fuelCostResponsibility: 'COMPANY',
        maintenanceResponsibility: 'COMPANY',
        joinedAt: new Date().toISOString(),
        baseMileage: 0,
        lastOilChangeKm: 0,
        lastCheckupKm: 0,
        totalGasSpent: 0,
        lastRefuelKm: 0,
        fuelRangeKm: 500,
        fuelLogs: [],
      });
      fleetAdded += 1;
      return false;
    });

    const incomingBatch: Customer[] = customerCandidates.map(buildCustomerFromImportedContact);
    const mergePreview = mergeCustomerCollections(customers, incomingBatch);

    if (incomingBatch.length > 0) {
      addCustomers(incomingBatch);
    }

    showCoreStatus(`Contacts import complete: ${mergePreview.added} added, ${mergePreview.merged} merged, ${mergePreview.unchanged} unchanged, ${fleetAdded} moved to fleet, ${fleetSkipped} fleet duplicates skipped, ${pendingContactsImport.rejectedRows} invalid rows.`);
    setPendingContactsImport(null);
  };

  const handleCancelContactsImport = () => {
    setPendingContactsImport(null);
    showCoreStatus('Contacts import canceled.');
  };

  const handleUpdateCustomerSegments = (profile: EnhancedCustomerProfile, nextSegments: CustomerMarketSegment[]) => {
    const key = customerPhoneKey(profile.phone);
    const existing = customers.find(customer => customerPhoneKey(customer.phone) === key);

    const patch: Customer = {
      id: existing?.id || profile.id || `${Date.now()}-${Math.random()}`,
      name: existing?.name || profile.name,
      phone: key,
      source: existing?.source || (profile.source as Customer['source']) || 'MANUAL',
      createdAt: existing?.createdAt || profile.lastTrip || new Date().toISOString(),
      ...(existing?.notes || profile.notes ? { notes: existing?.notes || profile.notes } : {}),
      ...(existing?.profileTimeline || profile.profileTimeline ? { profileTimeline: existing?.profileTimeline || profile.profileTimeline } : {}),
      ...(existing?.lastEnrichedAt ? { lastEnrichedAt: existing.lastEnrichedAt } : {}),
      isInternational: nextSegments.includes('EXPAT') || nextSegments.includes('TOURIST') || (!key.startsWith('961') && !nextSegments.includes('LOCAL_RESIDENT')),
      marketSegments: nextSegments,
      ...(existing?.gender || profile.gender ? { gender: existing?.gender || profile.gender } : {}),
      ...(existing?.entityType || profile.entityType ? { entityType: existing?.entityType || profile.entityType } : {}),
      ...(existing?.profession || profile.profession ? { profession: existing?.profession || profile.profession } : {}),
    };

    addCustomers([patch]);
    showCoreStatus(`Updated market segments for ${profile.name}: ${nextSegments.length > 0 ? nextSegments.join(' + ') : 'none'}.`);
  };

  const handleUpdateCustomerGender = (profile: EnhancedCustomerProfile, nextGender: CustomerGender) => {
    const key = customerPhoneKey(profile.phone);
    const existing = customers.find(customer => customerPhoneKey(customer.phone) === key);

    const patch: Customer = {
      id: existing?.id || profile.id || `${Date.now()}-${Math.random()}`,
      name: existing?.name || profile.name,
      phone: key,
      source: existing?.source || (profile.source as Customer['source']) || 'MANUAL',
      createdAt: existing?.createdAt || profile.lastTrip || new Date().toISOString(),
      ...(existing?.notes || profile.notes ? { notes: existing?.notes || profile.notes } : {}),
      ...(existing?.profileTimeline || profile.profileTimeline ? { profileTimeline: existing?.profileTimeline || profile.profileTimeline } : {}),
      ...(existing?.lastEnrichedAt ? { lastEnrichedAt: existing.lastEnrichedAt } : {}),
      isInternational: existing?.isInternational || profile.isInternational,
      marketSegments: existing?.marketSegments || profile.marketSegments,
      gender: nextGender,
      ...(existing?.entityType || profile.entityType ? { entityType: existing?.entityType || profile.entityType } : {}),
      ...(existing?.profession || profile.profession ? { profession: existing?.profession || profile.profession } : {}),
    };

    addCustomers([patch]);
    showCoreStatus(`Updated gender marker for ${profile.name}: ${nextGender}.`);
  };

  const handleUpdateCustomerEntityType = (profile: EnhancedCustomerProfile, nextEntityType: CustomerEntityType) => {
    const key = customerPhoneKey(profile.phone);
    const existing = customers.find(customer => customerPhoneKey(customer.phone) === key);

    const patch: Customer = {
      id: existing?.id || profile.id || `${Date.now()}-${Math.random()}`,
      name: existing?.name || profile.name,
      phone: key,
      source: existing?.source || (profile.source as Customer['source']) || 'MANUAL',
      createdAt: existing?.createdAt || profile.lastTrip || new Date().toISOString(),
      ...(existing?.notes || profile.notes ? { notes: existing?.notes || profile.notes } : {}),
      ...(existing?.profileTimeline || profile.profileTimeline ? { profileTimeline: existing?.profileTimeline || profile.profileTimeline } : {}),
      ...(existing?.lastEnrichedAt ? { lastEnrichedAt: existing.lastEnrichedAt } : {}),
      isInternational: existing?.isInternational || profile.isInternational,
      marketSegments: existing?.marketSegments || profile.marketSegments,
      gender: existing?.gender || profile.gender,
      entityType: nextEntityType,
      profession: existing?.profession || profile.profession,
    };

    addCustomers([patch]);
    showCoreStatus(`Updated customer classification for ${profile.name}: ${nextEntityType}.`);
  };

  const handleUpdateCustomerProfession = (profile: EnhancedCustomerProfile, nextProfession: string) => {
    const key = customerPhoneKey(profile.phone);
    const existing = customers.find(customer => customerPhoneKey(customer.phone) === key);
    const normalizedProfession = nextProfession.trim();

    const patch: Customer = {
      id: existing?.id || profile.id || `${Date.now()}-${Math.random()}`,
      name: existing?.name || profile.name,
      phone: key,
      source: existing?.source || (profile.source as Customer['source']) || 'MANUAL',
      createdAt: existing?.createdAt || profile.lastTrip || new Date().toISOString(),
      ...(existing?.notes || profile.notes ? { notes: existing?.notes || profile.notes } : {}),
      ...(existing?.profileTimeline || profile.profileTimeline ? { profileTimeline: existing?.profileTimeline || profile.profileTimeline } : {}),
      ...(existing?.lastEnrichedAt ? { lastEnrichedAt: existing.lastEnrichedAt } : {}),
      isInternational: existing?.isInternational || profile.isInternational,
      marketSegments: existing?.marketSegments || profile.marketSegments,
      gender: existing?.gender || profile.gender,
      entityType: existing?.entityType || profile.entityType,
      ...(normalizedProfession ? { profession: normalizedProfession } : {}),
    };

    addCustomers([patch]);
    showCoreStatus(`Updated profession marker for ${profile.name}: ${normalizedProfession || 'cleared'}.`);
  };

  const normalizeLocationInput = (
    label: string,
    address: string,
    mapOrCoords: string,
  ): CustomerLocation | undefined => {
    const normalizedAddress = address.trim();
    const normalizedMapOrCoords = mapOrCoords.trim();
    if (!normalizedAddress && !normalizedMapOrCoords) return undefined;

    const parsedMap = normalizedMapOrCoords ? parseGoogleMapsLink(normalizedMapOrCoords) : null;
    const parsedCoords = normalizedMapOrCoords ? parseGpsOrLatLngInput(normalizedMapOrCoords) : null;
    const mapsLink = parsedMap?.originalUrl || (normalizedMapOrCoords.startsWith('http') ? normalizedMapOrCoords : undefined);
    const lat = parsedMap?.lat ?? parsedCoords?.lat;
    const lng = parsedMap?.lng ?? parsedCoords?.lng;

    return {
      label,
      address: normalizedAddress || normalizedMapOrCoords,
      ...(mapsLink ? { mapsLink } : {}),
      ...(typeof lat === 'number' ? { lat } : {}),
      ...(typeof lng === 'number' ? { lng } : {}),
    };
  };

  const handleUpdateCustomerLocations = (
    profile: EnhancedCustomerProfile,
    payload: {
      homeAddress: string;
      homeMapOrCoords: string;
      businessAddress: string;
      businessMapOrCoords: string;
      frequentLocationsText: string;
    }
  ) => {
    const key = customerPhoneKey(profile.phone);
    const existing = customers.find(customer => customerPhoneKey(customer.phone) === key);

    const homeLocation = normalizeLocationInput('Home', payload.homeAddress, payload.homeMapOrCoords);
    const businessLocation = normalizeLocationInput('Business', payload.businessAddress, payload.businessMapOrCoords);
    const frequentLocations = payload.frequentLocationsText
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map((line, index) => normalizeLocationInput(`Place ${index + 1}`, '', line))
      .filter((entry): entry is CustomerLocation => Boolean(entry));

    const patch: Customer = {
      id: existing?.id || profile.id || `${Date.now()}-${Math.random()}`,
      name: existing?.name || profile.name,
      phone: key,
      source: existing?.source || (profile.source as Customer['source']) || 'MANUAL',
      createdAt: existing?.createdAt || profile.lastTrip || new Date().toISOString(),
      ...(existing?.notes || profile.notes ? { notes: existing?.notes || profile.notes } : {}),
      ...(existing?.profileTimeline || profile.profileTimeline ? { profileTimeline: existing?.profileTimeline || profile.profileTimeline } : {}),
      ...(existing?.lastEnrichedAt ? { lastEnrichedAt: existing.lastEnrichedAt } : {}),
      isInternational: existing?.isInternational || profile.isInternational,
      marketSegments: existing?.marketSegments || profile.marketSegments,
      gender: existing?.gender || profile.gender,
      entityType: existing?.entityType || profile.entityType,
      profession: existing?.profession || profile.profession,
      ...(homeLocation ? { homeLocation } : { homeLocation: undefined }),
      ...(businessLocation ? { businessLocation } : { businessLocation: undefined }),
      frequentLocations,
    };

    addCustomers([patch]);
    showCoreStatus(`Updated saved places for ${profile.name}.`);
  };

  const handleRemoveCustomerProfile = (profile: EnhancedCustomerProfile) => {
    const confirmed = window.confirm(`Remove CRM profile for ${profile.name}? This keeps trip history but removes this directory contact.`);
    if (!confirmed) return;

    const result = removeCustomerByPhone(profile.phone);
    if (!result.ok) {
      showCoreStatus(result.reason || 'Unable to remove CRM profile.');
      return;
    }

    setSelectedItem(null);
    setMobileDetailOpen(false);
    showCoreStatus(`Removed CRM profile for ${profile.name}.`);
  };

  const handleRemoveFleetProfile = (stats: FleetUnitStats) => {
    const confirmed = window.confirm(`Remove ${stats.driver.name} from Fleet and keep/add as CRM contact?`);
    if (!confirmed) return;

    const normalizedPhone = customerPhoneKey(stats.driver.phone) || stats.driver.phone;
    addCustomers([
      {
        id: `fleet-contact-${stats.driver.id}`,
        name: stats.driver.name,
        phone: normalizedPhone,
        source: 'MANUAL',
        createdAt: new Date().toISOString(),
        notes: '[FLEET CONTACT]',
      },
    ]);

    removeDriver(stats.driver.id);
    setActiveView('CUSTOMERS');
    openDetailPanel(normalizedPhone);
    showCoreStatus(`Removed ${stats.driver.name} from fleet and moved to CRM contacts.`);
  };

  const handleCreateCreditEntry = (payload: {
    partyType: CreditPartyType;
    partyName: string;
    cycle: CreditCycle;
    amountUsd: number;
    partyId?: string;
    dueDate?: string;
    notes?: string;
  }) => {
    const result = addCreditLedgerEntry(payload);
    if (!result.ok) {
      showCoreStatus(result.reason || 'Unable to create credit entry.');
      return;
    }
    showCoreStatus(`Credit logged for ${payload.partyName} (${payload.cycle}).`);
  };

  const handleSettleCreditEntry = (entryId: string) => {
    const result = settleCreditLedgerEntry(entryId);
    if (!result.ok) {
      showCoreStatus(result.reason || 'Unable to settle credit entry.');
      return;
    }

    if (result.receipt) {
      const receipt = result.receipt;
      const escapeHtml = (value: string) => value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

      const issuedAt = format(parseISO(receipt.issuedAt), 'PPP p');
      const notes = receipt.notes ? escapeHtml(receipt.notes) : '—';
      const partyTypeLabel = receipt.partyType === 'DRIVER' ? 'Driver' : 'Client';
      const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Receipt ${escapeHtml(receipt.receiptNumber)}</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 24px; background: #f8fafc; color: #0f172a; }
      .sheet { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 20px; padding: 28px; }
      .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 1px solid #e2e8f0; padding-bottom: 16px; margin-bottom: 20px; }
      .brand { font-size: 24px; font-weight: 900; letter-spacing: 0.04em; text-transform: uppercase; }
      .sub { font-size: 12px; color: #64748b; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 4px; }
      .pill { border: 1px solid #93c5fd; color: #1d4ed8; background: #eff6ff; border-radius: 999px; padding: 6px 12px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 18px; margin-bottom: 20px; }
      .label { font-size: 10px; color: #64748b; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
      .value { font-size: 14px; color: #0f172a; font-weight: 800; margin-top: 2px; }
      .amount { margin-top: 6px; border: 1px solid #86efac; background: #f0fdf4; border-radius: 14px; padding: 14px; }
      .amount .label { color: #166534; }
      .amount .value { color: #166534; font-size: 28px; letter-spacing: -0.02em; }
      .notes { margin-top: 14px; border-top: 1px dashed #cbd5e1; padding-top: 14px; white-space: pre-wrap; word-break: break-word; }
      .footer { margin-top: 22px; border-top: 1px solid #e2e8f0; padding-top: 14px; font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
      @media print {
        body { background: #fff; padding: 0; }
        .sheet { border: none; border-radius: 0; max-width: none; margin: 0; padding: 0; }
      }
    </style>
  </head>
  <body>
    <main class="sheet">
      <section class="header">
        <div>
          <div class="brand">Control Taxi</div>
          <div class="sub">Payment Receipt</div>
        </div>
        <div class="pill">#${escapeHtml(receipt.receiptNumber)}</div>
      </section>

      <section class="grid">
        <div><div class="label">Receipt ID</div><div class="value">${escapeHtml(receipt.id)}</div></div>
        <div><div class="label">Issued At</div><div class="value">${escapeHtml(issuedAt)}</div></div>
        <div><div class="label">Party Type</div><div class="value">${escapeHtml(partyTypeLabel)}</div></div>
        <div><div class="label">Cycle</div><div class="value">${escapeHtml(receipt.cycle)}</div></div>
        <div style="grid-column: 1 / -1;"><div class="label">Party</div><div class="value">${escapeHtml(receipt.partyName)}</div></div>
      </section>

      <section class="amount">
        <div class="label">Amount Received (USD)</div>
        <div class="value">$${receipt.amountUsd.toFixed(2)}</div>
      </section>

      <section class="notes">
        <div class="label">Notes</div>
        <div class="value">${notes}</div>
      </section>

      <section class="footer">Generated by Control Taxi · Accounting Ledger</section>
    </main>
    <script>
      window.addEventListener('load', () => {
        window.print();
      });
    </script>
  </body>
</html>`;

      const receiptWindow = window.open('', '_blank', 'noopener,noreferrer,width=900,height=720');
      if (receiptWindow) {
        receiptWindow.document.open();
        receiptWindow.document.write(html);
        receiptWindow.document.close();
      }
    }

    showCoreStatus('Credit entry settled and printable receipt generated.');
  };

  const renderIntelligenceContent = () => {
    if (!selectedItem) {
      if (activeView === 'CUSTOMERS') {
        return <DirectoryOverviewView profiles={customerProfiles} onSelectCustomer={openDetailPanel} />;
      }
      if (activeView === 'FLEET') {
        return <FleetOverviewView units={fleetHealth} windowLabel={metricsWindowLabel} onSelectDriver={openDetailPanel} />;
      }
      if (activeView === 'FINANCE') {
        return (
          <FinanceOverviewView
            totals={financeTotals}
            rows={financeRows}
            windowLabel={metricsWindowLabel}
            creditLedger={creditLedger}
            receipts={receipts}
            customers={customers}
            drivers={drivers}
            onCreateCreditEntry={handleCreateCreditEntry}
            onSettleCreditEntry={handleSettleCreditEntry}
          />
        );
      }
      if (activeView === 'VAULT') {
        return (
          <VaultConsoleView
            selectedActionId={null}
            counts={{ trips: trips.length, drivers: drivers.length, customers: customers.length, alerts: alerts.length }}
            statusMessage={vaultStatusMessage}
            syncStatus={vaultSyncStatus}
            syncDetail={vaultSyncDetail}
            syncChannel={syncChannel}
            clearArmed={vaultClearArmed}
            busyAction={vaultBusyAction}
            pendingImport={pendingVaultImport}
            onExport={handleVaultExport}
            onImport={handleVaultImportClick}
            onConfirmImport={handleVaultConfirmImport}
            onCancelImport={handleVaultCancelImport}
            onClear={handleVaultClear}
            onCancelClear={handleVaultClearCancel}
            onCopySyncChannel={handleCopySyncChannel}
          />
        );
      }
      return (
        <div className="h-full flex flex-col items-center justify-center opacity-20 text-center">
           <ShieldCheck size={80} className="mb-4" />
           <h3 className="text-2xl font-black uppercase tracking-tighter">Target Selection Required</h3>
           <p className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400 mt-2">Intelligence Core Idle</p>
        </div>
      );
    }

    if (activeView === 'CUSTOMERS') {
      const profile = customerProfiles.find(p => p.phone === selectedItem);
      if (!profile) return null;
      return (
        <CustomerIntelligenceView
          profile={profile}
          onJumpToDriver={(id) => { setActiveView('FLEET'); openDetailPanel(id); }}
          onUpdateSegments={handleUpdateCustomerSegments}
          onUpdateGender={handleUpdateCustomerGender}
          onUpdateEntityType={handleUpdateCustomerEntityType}
          onUpdateProfession={handleUpdateCustomerProfession}
          onUpdateLocations={handleUpdateCustomerLocations}
          onRemoveProfile={handleRemoveCustomerProfile}
        />
      );
    }

    if (activeView === 'FLEET') {
      const stats = fleetHealth.find(f => f.driver.id === selectedItem);
      if (!stats) return null;
      return <FleetReadinessView stats={stats} onRefuel={() => handleRefuel(stats)} onUpdateGovernance={payload => handleUpdateFleetGovernance(stats, payload)} onRemoveFromFleet={() => handleRemoveFleetProfile(stats)} windowLabel={metricsWindowLabel} />;
    }

    if (activeView === 'FINANCE') {
      const row = financeRows.find(r => r.id === selectedItem);
      if (!row) {
        return (
          <FinanceOverviewView
            totals={financeTotals}
            rows={financeRows}
            windowLabel={metricsWindowLabel}
            creditLedger={creditLedger}
            receipts={receipts}
            customers={customers}
            drivers={drivers}
            onCreateCreditEntry={handleCreateCreditEntry}
            onSettleCreditEntry={handleSettleCreditEntry}
          />
        );
      }
      return (
        <FinancePerformanceView
          row={row}
          totals={financeTotals}
          windowLabel={metricsWindowLabel}
          creditLedger={creditLedger}
          receipts={receipts}
          customers={customers}
          drivers={drivers}
          onCreateCreditEntry={handleCreateCreditEntry}
          onSettleCreditEntry={handleSettleCreditEntry}
        />
      );
    }

    if (activeView === 'VAULT') {
      return (
        <VaultConsoleView
          selectedActionId={selectedItem}
          counts={{ trips: trips.length, drivers: drivers.length, customers: customers.length, alerts: alerts.length }}
          statusMessage={vaultStatusMessage}
          syncStatus={vaultSyncStatus}
          syncDetail={vaultSyncDetail}
          syncChannel={syncChannel}
          clearArmed={vaultClearArmed}
          busyAction={vaultBusyAction}
          pendingImport={pendingVaultImport}
          onExport={handleVaultExport}
          onImport={handleVaultImportClick}
          onConfirmImport={handleVaultConfirmImport}
          onCancelImport={handleVaultCancelImport}
          onClear={handleVaultClear}
          onCancelClear={handleVaultClearCancel}
          onCopySyncChannel={handleCopySyncChannel}
        />
      );
    }

    return (
      <div className="h-full flex flex-col items-center justify-center opacity-20 text-center">
         <ShieldAlert size={80} className="mb-4" />
         <h3 className="text-2xl font-black uppercase tracking-tighter">Segment Unavailable</h3>
         <p className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400 mt-2">Under Construction</p>
      </div>
    );
  };

  return (
    <div className="crm-shell flex flex-col h-full bg-slate-50 dark:bg-brand-950 text-slate-900 dark:text-slate-100 font-sans select-none animate-fade-in transition-colors duration-500">
      
      <div className="crm-toolbar flex flex-col md:flex-row items-stretch md:items-center justify-between border-b border-slate-200 dark:border-white/5 bg-white dark:bg-brand-950/50 px-4 md:px-6 min-h-14 py-2 md:py-0 gap-3">
        <div className="crm-tabs flex space-x-6 md:space-x-8 overflow-x-auto scrollbar-hide">
           {[
             { id: 'CUSTOMERS', label: 'Directory', icon: User },
             { id: 'FLEET', label: 'Fleet', icon: Gauge },
             { id: 'FINANCE', label: 'Yield', icon: DollarSign },
             { id: 'VAULT', label: 'Vault', icon: Database }
           ].map(tab => (
             <button key={tab.id} onClick={() => { setActiveView(tab.id as ViewMode); setSelectedItem(null); setMobileDetailOpen(false); }} className={`crm-tab-button flex items-center space-x-2.5 h-10 md:h-14 border-b-2 transition-all flex-shrink-0 ${activeView === tab.id ? 'border-brand-900 dark:border-emerald-500 text-brand-900 dark:text-emerald-500' : 'border-transparent text-slate-400 dark:text-slate-50'}`}><tab.icon size={14} /><span className="text-[10px] font-black uppercase tracking-widest">{tab.label}</span></button>
           ))}
        </div>
          <div className="crm-controls flex items-center gap-2 flex-wrap md:flex-nowrap">
            <div className="crm-search relative flex-1 md:w-64">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder={searchPlaceholder}
                className="w-full bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl h-10 pl-10 text-[10px] font-bold uppercase tracking-widest focus:outline-none"
                value={searchTerm}
                onFocus={() => setShowSearchSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSearchSuggestions(false), 120)}
                onChange={e => {
                  setSearchTerm(e.target.value);
                  setShowSearchSuggestions(true);
                }}
              />
              {showSearchSuggestions && searchSuggestions.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 rounded-2xl shadow-2xl z-30 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                  {searchSuggestions.map(s => {
                    const tierTone = getLoyaltyTierTone(s.loyaltyTier);
                    return (
                    <button
                      key={s.id}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleSuggestionSelect(s.id);
                      }}
                      className={`w-full text-left px-4 py-3 border-b border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-brand-950 transition-colors ${tierTone.suggestion}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[10px] font-black uppercase tracking-widest text-brand-900 dark:text-white truncate">{s.title}</p>
                        {s.loyaltyTier && (
                          <span className={`text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest ${tierTone.badge}`}>{tierTone.label}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 truncate">{s.subtitle}</p>
                        {(activeView === 'CUSTOMERS' && (s.subtitle && !customerPhoneKey(s.subtitle).startsWith('961'))) && (
                          <span className="text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-blue-300 text-blue-600 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10">INTL</span>
                        )}
                      </div>
                    </button>
                  )})}
                </div>
              )}
           </div>
           {(activeView === 'FLEET' || activeView === 'FINANCE') && (
             <div className="flex items-center gap-1 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-100 dark:bg-white/5 p-1">
               {(['TODAY', '7D', '30D', 'ALL'] as const).map(window => (
                 <button
                   key={window}
                   type="button"
                   onClick={() => setMetricsWindow(window)}
                   className={`h-8 px-2.5 rounded-lg text-[8px] font-black uppercase tracking-widest transition-colors ${metricsWindow === window ? 'bg-brand-900 text-gold-400 dark:bg-brand-800' : 'text-slate-500 dark:text-slate-300'}`}
                 >
                   {window}
                 </button>
               ))}
             </div>
           )}
           {activeView === 'CUSTOMERS' && (
             <div className="crm-desktop-customer-actions hidden md:flex flex-col items-start gap-2">
               <div className="flex items-center gap-2">
               <button
                 type="button"
                 onClick={handleContactsFileImportClick}
                 className="h-10 px-3 rounded-xl border border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 text-[9px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300 inline-flex items-center gap-1.5"
               >
                 <FileJson size={12} className="text-blue-600" />
                 File Import
               </button>
               <button
                 type="button"
                 onClick={handleContactsExport}
                 className="h-10 px-3 rounded-xl border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[9px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1.5"
               >
                 <Download size={12} className="text-emerald-600" />
                 Export Contacts
               </button>
               {pendingContactsImport && (
                 <>
                   <button
                     type="button"
                     onClick={handleConfirmContactsImport}
                     className="h-10 px-3 rounded-xl border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[9px] font-black uppercase tracking-widest text-emerald-700"
                   >
                     Merge {pendingContactsImport.contacts.length}
                   </button>
                   <button
                     type="button"
                     onClick={handleCancelContactsImport}
                     className="h-10 px-3 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5 text-[9px] font-black uppercase tracking-widest text-slate-500"
                   >
                     Cancel
                   </button>
                 </>
               )}
               </div>
             </div>
           )}
        </div>
      </div>

      {(coreStatusMessage || pendingContactsImport) && (
        <div className="px-4 md:px-6 py-3 border-b border-slate-200 dark:border-white/5 bg-white dark:bg-brand-950/40 space-y-2">
          {coreStatusMessage && (
            <p role="status" aria-live="polite" className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">{coreStatusMessage}</p>
          )}
          {pendingContactsImport && (
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-300">
              Pending contacts import: {pendingContactsImport.fileName} · {pendingContactsImport.contacts.length} valid · {pendingContactsImport.rejectedRows} invalid
            </p>
          )}
        </div>
      )}

      {activeView === 'CUSTOMERS' && (
        <div className="crm-mobile-customer-actions md:hidden px-4 py-3 border-b border-slate-200 dark:border-white/5 bg-white dark:bg-brand-950/40 space-y-2">
          <button
            type="button"
            onClick={handleContactsPhoneExtract}
            className="w-full h-11 rounded-xl border border-gold-300 dark:border-gold-800/60 bg-gold-50 dark:bg-gold-900/15 text-[10px] font-black uppercase tracking-widest text-gold-700 dark:text-gold-400 inline-flex items-center justify-center gap-1.5"
          >
            <Smartphone size={12} className="text-gold-600" />
            Phone Extract
          </button>
          <button
            type="button"
            onClick={handleContactsFileImportClick}
            className="w-full h-11 rounded-xl border border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 text-[10px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300 inline-flex items-center justify-center gap-1.5"
          >
            <FileJson size={12} className="text-blue-600" />
            File Import (CSV / JSON / VCF)
          </button>
          <button
            type="button"
            onClick={handleContactsExport}
            className="w-full h-11 rounded-xl border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[10px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300 inline-flex items-center justify-center gap-1.5"
          >
            <Download size={12} className="text-emerald-600" />
            Export Contacts (CSV)
          </button>
          {pendingContactsImport && (
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                onClick={handleConfirmContactsImport}
                className="h-11 rounded-xl border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[10px] font-black uppercase tracking-widest text-emerald-700"
              >
                Merge {pendingContactsImport.contacts.length}
              </button>
              <button
                type="button"
                onClick={handleCancelContactsImport}
                className="h-11 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5 text-[10px] font-black uppercase tracking-widest text-slate-500"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex-1 flex overflow-hidden relative">
        <div className="w-full md:w-64 lg:w-80 border-r border-slate-200 dark:border-white/5 bg-white dark:bg-brand-950/80 overflow-y-auto transition-all">
          {isProcessing ? (
            Array(6).fill(0).map((_, i) => <SkeletonItem key={i} />)
          ) : filteredItems.length > 0 ? (
            filteredItems.map((item, index) => {
              if (activeView === 'CUSTOMERS') {
                const profile = item as EnhancedCustomerProfile;
                const tierTone = getLoyaltyTierTone(profile.loyaltyTier);
                const id = profile.phone;
                const hasSingleSegment = (profile.marketSegments || []).length === 1;
                const primarySegment = hasSingleSegment ? profile.marketSegments?.[0] : null;
                const showUndecidedSegment = Boolean(profile.isInternational && !hasSingleSegment);
                const genderLabel = profile.gender === 'MALE' ? 'M' : profile.gender === 'FEMALE' ? 'F' : null;
                const showBusiness = profile.entityType === 'BUSINESS';
                const professionLabel = (profile.profession || '').trim();
                const hasHomeLocation = Boolean(profile.homeLocation?.address);
                const hasBusinessLocation = Boolean(profile.businessLocation?.address);
                const frequentLocationCount = Array.isArray(profile.frequentLocations) ? profile.frequentLocations.length : 0;
                const phoneKey = customerPhoneKey(profile.phone);
                const callHref = phoneKey ? `tel:+${phoneKey}` : '';
                const whatsappHref = buildWhatsAppLink(phoneKey) || '';

                return (
                  <div
                    key={id}
                    onClick={() => openDetailPanel(id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openDetailPanel(id);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    className={`w-full p-4 md:p-5 text-left border-b border-slate-100 dark:border-white/5 transition-all relative ${selectedItem === id ? 'bg-brand-50 dark:bg-emerald-500/5 border-l-4 border-l-brand-900 dark:border-l-emerald-500' : 'hover:bg-slate-50 dark:hover:bg-white/5'} ${tierTone.card}`}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${selectedItem === id ? 'bg-brand-900 text-gold-400 dark:bg-white/10 dark:text-emerald-500' : 'bg-slate-100 text-slate-400 dark:bg-brand-900/50'}`}>
                        <User size={18} />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-blue-200 text-blue-600 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10">#{index + 1}</span>
                        <span className={`text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest ${tierTone.badge}`}>{tierTone.label}</span>
                      </div>
                    </div>
                    <h4 className="text-sm font-black uppercase tracking-tight truncate text-brand-900 dark:text-white leading-none mb-1">{profile.name}</h4>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <a
                        href={callHref}
                        onClick={(event) => event.stopPropagation()}
                        className="text-[9px] font-bold text-slate-400 uppercase tracking-widest truncate underline-offset-2 hover:underline"
                      >
                        {profile.phone}
                      </a>
                      {callHref && (
                        <a
                          href={callHref}
                          onClick={(event) => event.stopPropagation()}
                          className="text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-slate-300 text-slate-500 dark:border-slate-700"
                        >
                          Call
                        </a>
                      )}
                      {whatsappHref && (
                        <a
                          href={whatsappHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(event) => event.stopPropagation()}
                          className="text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-emerald-300 text-emerald-600 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10"
                        >
                          WA
                        </a>
                      )}
                      {primarySegment === 'EXPAT' && (
                        <span className="text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-blue-300 text-blue-600 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10">EXPAT</span>
                      )}
                      {primarySegment === 'TOURIST' && (
                        <span className="text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-purple-300 text-purple-600 bg-purple-50 dark:border-purple-900/40 dark:text-purple-300 dark:bg-purple-900/10">TOURIST</span>
                      )}
                      {primarySegment === 'LOCAL_RESIDENT' && (
                        <span className="text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10">LOCAL</span>
                      )}
                      {showUndecidedSegment && (
                        <span className="text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-indigo-300 text-indigo-600 bg-indigo-50 dark:border-indigo-900/40 dark:text-indigo-300 dark:bg-indigo-900/10">EXPAT / TOURIST</span>
                      )}
                      {genderLabel && (
                        <span className="text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-pink-300 text-pink-600 bg-pink-50 dark:border-pink-900/40 dark:text-pink-300 dark:bg-pink-900/10">{genderLabel}</span>
                      )}
                      {showBusiness && (
                        <span className="text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-900/40 dark:text-amber-300 dark:bg-amber-900/10">BIZ</span>
                      )}
                      {professionLabel && (
                        <span className="text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-teal-300 text-teal-700 bg-teal-50 dark:border-teal-900/40 dark:text-teal-300 dark:bg-teal-900/10">{professionLabel}</span>
                      )}
                      {(hasHomeLocation || hasBusinessLocation || frequentLocationCount > 0) && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            jumpToSavedPlaces(id);
                          }}
                          className="text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-slate-300 text-slate-500 bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:bg-slate-900/20 inline-flex items-center gap-1"
                        >
                          <MapPin size={9} />
                          {hasHomeLocation ? 'H' : ''}
                          {hasHomeLocation && hasBusinessLocation ? '/' : ''}
                          {hasBusinessLocation ? 'B' : ''}
                          {frequentLocationCount > 0 ? `+${frequentLocationCount}` : ''}
                        </button>
                      )}
                    </div>
                  </div>
                );
              }

              if (activeView === 'FLEET') {
                const profile = item as FleetUnitStats;
                const id = profile.driver.id;
                const driverPhoneKey = customerPhoneKey(profile.driver.phone);
                const driverCallHref = driverPhoneKey ? `tel:+${driverPhoneKey}` : '';
                const driverWhatsappHref = buildWhatsAppLink(driverPhoneKey) || '';
                const feedbackRate = profile.completedTrips > 0
                  ? Math.round((profile.feedbackCount / profile.completedTrips) * 100)
                  : 0;
                return (
                  <div
                    key={id}
                    onClick={() => openDetailPanel(id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openDetailPanel(id);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    className={`w-full p-4 md:p-5 text-left border-b border-slate-100 dark:border-white/5 transition-all relative ${selectedItem === id ? 'bg-brand-50 dark:bg-emerald-500/5 border-l-4 border-l-brand-900 dark:border-l-emerald-500' : 'hover:bg-slate-50 dark:hover:bg-white/5'}`}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${selectedItem === id ? 'bg-brand-900 text-gold-400 dark:bg-white/10 dark:text-emerald-500' : 'bg-slate-100 text-slate-400 dark:bg-brand-900/50'}`}>
                        <Car size={18} />
                      </div>
                      <span className="text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-slate-300 text-slate-400 dark:border-slate-700">FLEET</span>
                    </div>
                    <h4 className="text-sm font-black uppercase tracking-tight truncate text-brand-900 dark:text-white leading-none mb-1">{profile.driver.name}</h4>
                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest truncate">{profile.driver.plateNumber}</p>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <span className={`text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest ${profile.driver.status === 'ACTIVE'
                        ? 'border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10'
                        : 'border-red-300 text-red-700 bg-red-50 dark:border-red-900/40 dark:text-red-300 dark:bg-red-900/10'}`}>
                        {profile.driver.status}
                      </span>
                      <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-slate-300 text-slate-600 bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:bg-slate-900/20">
                        {profile.driver.currentStatus}
                      </span>
                      <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10">
                        Trips {profile.completedTrips}
                      </span>
                      <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-purple-300 text-purple-700 bg-purple-50 dark:border-purple-900/40 dark:text-purple-300 dark:bg-purple-900/10">
                        Feedback {profile.feedbackCount}
                      </span>
                      <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-indigo-300 text-indigo-700 bg-indigo-50 dark:border-indigo-900/40 dark:text-indigo-300 dark:bg-indigo-900/10">
                        Rate {feedbackRate}%
                      </span>
                      <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-slate-300 text-slate-600 bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:bg-slate-900/20">
                        {ownershipLabelMap[profile.driver.vehicleOwnership || 'COMPANY_FLEET']}
                      </span>
                      <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-900/40 dark:text-amber-300 dark:bg-amber-900/10">
                        Fuel {responsibilityLabelMap[profile.driver.fuelCostResponsibility || 'COMPANY']}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <a
                        href={driverCallHref}
                        onClick={(event) => event.stopPropagation()}
                        className="text-[9px] font-bold text-slate-400 uppercase tracking-widest truncate underline-offset-2 hover:underline"
                      >
                        {profile.driver.phone}
                      </a>
                      {driverCallHref && (
                        <a
                          href={driverCallHref}
                          onClick={(event) => event.stopPropagation()}
                          className="text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-slate-300 text-slate-500 dark:border-slate-700"
                        >
                          Call
                        </a>
                      )}
                      {driverWhatsappHref && (
                        <a
                          href={driverWhatsappHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(event) => event.stopPropagation()}
                          className="text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-emerald-300 text-emerald-600 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10"
                        >
                          WA
                        </a>
                      )}
                    </div>
                    <div className="flex items-center space-x-2 mt-1.5">
                      <div className="flex items-center space-x-1">
                        <Star size={10} className="text-gold-500 fill-gold-500" />
                        <span className="text-[10px] font-black text-slate-500 dark:text-slate-400">
                          {profile.avgRating > 0 ? profile.avgRating.toFixed(1) : '—'}
                        </span>
                      </div>
                      <span className="text-[10px] font-bold text-slate-400">({profile.ratingCount})</span>
                    </div>
                  </div>
                );
              }

              if (activeView === 'FINANCE') {
                const profile = item as FinanceDriverProfile;
                const id = profile.id;
                const safeBurnRatio = Number.isFinite(profile.burnRatio) ? profile.burnRatio : 0;
                return (
                  <button key={id} onClick={() => openDetailPanel(id)} className={`w-full p-4 md:p-5 text-left border-b border-slate-100 dark:border-white/5 transition-all relative ${selectedItem === id ? 'bg-brand-50 dark:bg-emerald-500/5 border-l-4 border-l-brand-900 dark:border-l-emerald-500' : 'hover:bg-slate-50 dark:hover:bg-white/5'}`}>
                    <div className="flex justify-between items-start mb-2">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${selectedItem === id ? 'bg-brand-900 text-gold-400 dark:bg-white/10 dark:text-emerald-500' : 'bg-slate-100 text-slate-400 dark:bg-brand-900/50'}`}>
                        <DollarSign size={18} />
                      </div>
                      <span className={`text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest ${profile.netAlpha >= 0 ? 'border-emerald-500 text-emerald-600 bg-emerald-500/5' : 'border-red-300 text-red-500 bg-red-500/5'}`}>
                        {profile.netAlpha >= 0 ? 'POS' : 'NEG'}
                      </span>
                    </div>
                    <h4 className="text-sm font-black uppercase tracking-tight truncate text-brand-900 dark:text-white leading-none mb-1">{profile.name}</h4>
                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest truncate">{profile.plateNumber}</p>
                    <p className="text-[10px] font-black mt-1 text-brand-900 dark:text-emerald-500">${profile.netAlpha.toFixed(0)} NET</p>
                    <p className="text-[9px] font-black mt-0.5 text-blue-700 dark:text-blue-300">${profile.companyOwed.toFixed(0)} OWED</p>
                    <p className="text-[8px] font-black mt-0.5 text-indigo-700 dark:text-indigo-300 uppercase tracking-widest">{profile.shareRuleLabel}</p>
                    <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                      <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10">
                        SHARE {(profile.companyShareRate * 100).toFixed(1)}%
                      </span>
                      <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-gold-300 text-gold-700 bg-gold-50 dark:border-gold-900/40 dark:text-gold-300 dark:bg-gold-900/10">
                        BR {(safeBurnRatio * 100).toFixed(1)}%
                      </span>
                      <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-cyan-300 text-cyan-700 bg-cyan-50 dark:border-cyan-900/40 dark:text-cyan-300 dark:bg-cyan-900/10">
                        ATTR UNIT
                      </span>
                    </div>
                  </button>
                );
              }

              const profile = item as VaultFeedItem;
              const id = profile.id;
              return (
                <button key={id} onClick={() => openDetailPanel(id)} className={`w-full p-4 md:p-5 text-left border-b border-slate-100 dark:border-white/5 transition-all relative ${selectedItem === id ? 'bg-brand-50 dark:bg-emerald-500/5 border-l-4 border-l-brand-900 dark:border-l-emerald-500' : 'hover:bg-slate-50 dark:hover:bg-white/5'}`}>
                  <div className="flex justify-between items-start mb-2">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${selectedItem === id ? 'bg-brand-900 text-gold-400 dark:bg-white/10 dark:text-emerald-500' : 'bg-slate-100 text-slate-400 dark:bg-brand-900/50'}`}>
                      {profile.id === 'EXPORT' ? <Download size={18} /> : profile.id === 'IMPORT' ? <Upload size={18} /> : profile.id === 'CLEAR' ? <Archive size={18} /> : <Database size={18} />}
                    </div>
                    <span className={`text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest ${profile.tone === 'DANGER' ? 'border-red-300 text-red-500 bg-red-500/5' : profile.tone === 'SAFE' ? 'border-emerald-400 text-emerald-600 bg-emerald-500/5' : profile.tone === 'RESTORE' ? 'border-blue-300 text-blue-600 bg-blue-500/5' : 'border-amber-300 text-amber-600 bg-amber-500/5'}`}>{profile.tone}</span>
                  </div>
                  <h4 className="text-sm font-black uppercase tracking-tight truncate text-brand-900 dark:text-white leading-none mb-1">{profile.title}</h4>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest truncate">{profile.subtitle}</p>
                </button>
              );
            })
          ) : (
            <div className="p-12 text-center opacity-40 flex flex-col items-center">
              <UserX size={48} className="mb-4 text-slate-300 dark:text-brand-800" />
              <p className="text-[10px] font-black uppercase tracking-widest">{emptyStateTitle}</p>
              <p className="text-[8px] font-bold uppercase text-slate-400 mt-1">{emptyStateSubtitle}</p>
            </div>
          )}
        </div>

          <div className="hidden md:block flex-1 bg-slate-100/30 dark:bg-black/20 overflow-y-auto p-4 md:p-6 lg:p-12">
          {isProcessing ? (
             <div className="max-w-4xl mx-auto flex flex-col items-center justify-center h-full opacity-40">
                <Loader2 className="w-8 h-8 animate-spin mb-4" />
                <p className="text-[10px] font-black uppercase tracking-[0.4em]">Deriving Intel...</p>
             </div>
          ) : (
            <div className="max-w-4xl mx-auto space-y-6 md:space-y-12 animate-in fade-in slide-in-from-right-8 duration-500">
               {renderIntelligenceContent()}
            </div>
          )}
        </div>

        {shouldShowMobileDetail && (
          <div className="md:hidden fixed inset-0 z-40">
            <button
              type="button"
              aria-label="Close detail panel"
              onClick={closeMobileDetailPanel}
              className="absolute inset-0 bg-black/45"
            />
            <div className="absolute inset-y-0 right-0 w-full bg-slate-100 dark:bg-brand-950 overflow-y-auto p-4">
              <div className="max-w-4xl mx-auto space-y-6 animate-in fade-in slide-in-from-right-8 duration-300">
                <button onClick={closeMobileDetailPanel} className="flex items-center space-x-2 text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2"><ChevronLeft size={16} /><span>Return to Feed</span></button>
                {renderIntelligenceContent()}
              </div>
            </div>
          </div>
        )}
      </div>

      <input
        ref={importFileRef}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={handleVaultImportFile}
      />
      <input
        ref={contactsImportRef}
        type="file"
        accept=".json,.csv,.vcf,application/json,text/csv,text/vcard,text/x-vcard"
        className="hidden"
        onChange={handleContactsImportFile}
      />
    </div>
  );
};

const CustomerIntelligenceView: React.FC<{
  profile: EnhancedCustomerProfile,
  onJumpToDriver: (id: string) => void,
  onUpdateSegments: (profile: EnhancedCustomerProfile, nextSegments: CustomerMarketSegment[]) => void,
  onUpdateGender: (profile: EnhancedCustomerProfile, nextGender: CustomerGender) => void,
  onUpdateEntityType: (profile: EnhancedCustomerProfile, nextEntityType: CustomerEntityType) => void,
  onUpdateProfession: (profile: EnhancedCustomerProfile, nextProfession: string) => void,
  onRemoveProfile: (profile: EnhancedCustomerProfile) => void,
  onUpdateLocations: (profile: EnhancedCustomerProfile, payload: {
    homeAddress: string;
    homeMapOrCoords: string;
    businessAddress: string;
    businessMapOrCoords: string;
    frequentLocationsText: string;
  }) => void,
}> = ({ profile, onJumpToDriver, onUpdateSegments, onUpdateGender, onUpdateEntityType, onUpdateProfession, onRemoveProfile, onUpdateLocations }) => {
  const profileTierTone = getLoyaltyTierTone(profile.loyaltyTier);
  const activeSegments = profile.marketSegments || [];
  const hasSingleSegment = activeSegments.length === 1;
  const isUndecidedInternational = Boolean(profile.isInternational && !hasSingleSegment);
  const phoneKey = customerPhoneKey(profile.phone);
  const callHref = phoneKey ? `tel:+${phoneKey}` : '';
  const whatsappHref = buildWhatsAppLink(phoneKey) || '';
  const isSegmentActive = (segment: CustomerMarketSegment) => activeSegments.includes(segment);
  const [professionDraft, setProfessionDraft] = useState(profile.profession || '');
  const [homeAddressDraft, setHomeAddressDraft] = useState(profile.homeLocation?.address || '');
  const [homeMapDraft, setHomeMapDraft] = useState(profile.homeLocation?.mapsLink || (typeof profile.homeLocation?.lat === 'number' && typeof profile.homeLocation?.lng === 'number' ? `${profile.homeLocation.lat},${profile.homeLocation.lng}` : ''));
  const [businessAddressDraft, setBusinessAddressDraft] = useState(profile.businessLocation?.address || '');
  const [businessMapDraft, setBusinessMapDraft] = useState(profile.businessLocation?.mapsLink || (typeof profile.businessLocation?.lat === 'number' && typeof profile.businessLocation?.lng === 'number' ? `${profile.businessLocation.lat},${profile.businessLocation.lng}` : ''));
  const [frequentLocationsDraft, setFrequentLocationsDraft] = useState((profile.frequentLocations || []).map(location => location.mapsLink || location.address).join('\n'));

  useEffect(() => {
    setProfessionDraft(profile.profession || '');
  }, [profile.profession, profile.phone]);

  useEffect(() => {
    setHomeAddressDraft(profile.homeLocation?.address || '');
    setHomeMapDraft(profile.homeLocation?.mapsLink || (typeof profile.homeLocation?.lat === 'number' && typeof profile.homeLocation?.lng === 'number' ? `${profile.homeLocation.lat},${profile.homeLocation.lng}` : ''));
    setBusinessAddressDraft(profile.businessLocation?.address || '');
    setBusinessMapDraft(profile.businessLocation?.mapsLink || (typeof profile.businessLocation?.lat === 'number' && typeof profile.businessLocation?.lng === 'number' ? `${profile.businessLocation.lat},${profile.businessLocation.lng}` : ''));
    setFrequentLocationsDraft((profile.frequentLocations || []).map(location => location.mapsLink || location.address).join('\n'));
  }, [profile.homeLocation, profile.businessLocation, profile.frequentLocations, profile.phone]);

  const toggleSegment = (segment: CustomerMarketSegment) => {
    onUpdateSegments(profile, [segment]);
  };

  return (
  <div className="space-y-8 md:space-y-12 animate-in fade-in duration-700">
    <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-slate-200 dark:border-white/10 pb-8 gap-6">
      <div className="flex items-center space-x-6">
        <div className={`w-16 h-16 md:w-20 md:h-20 rounded-[2rem] bg-brand-900 text-gold-400 dark:bg-gold-500/10 dark:text-gold-500 flex items-center justify-center border-4 border-white dark:border-brand-800 shadow-2xl transition-transform hover:scale-110`}>
           <User size={32} className="md:w-10 md:h-10" />
        </div>
        <div>
          <h2 className="text-3xl md:text-5xl font-black tracking-tighter uppercase text-brand-900 dark:text-white leading-tight">{profile.name}</h2>
          <div className="flex flex-wrap items-center mt-3 gap-4">
             <div className="flex items-center space-x-2 text-brand-700 dark:text-emerald-500 bg-brand-50 dark:bg-emerald-500/10 px-3 py-1 rounded-lg border border-brand-100 dark:border-emerald-500/20">
               <Phone size={14}/> <span className="text-xs font-black tracking-widest">{profile.phone}</span>
             </div>
             {callHref && (
               <a
                 href={callHref}
                 className="h-8 px-3 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-950 text-[9px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 inline-flex items-center"
               >
                 Call
               </a>
             )}
             {whatsappHref && (
               <a
                 href={whatsappHref}
                 target="_blank"
                 rel="noopener noreferrer"
                 className="h-8 px-3 rounded-lg border border-emerald-300 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[9px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300 inline-flex items-center"
               >
                 WhatsApp
               </a>
             )}
             <button
               type="button"
               onClick={() => onRemoveProfile(profile)}
               className="h-8 px-3 rounded-lg border border-red-300 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 text-[9px] font-black uppercase tracking-widest text-red-700 dark:text-red-300 inline-flex items-center"
             >
               Remove CRM
             </button>
          </div>
        </div>
      </div>
      <div className="md:text-right flex flex-col items-end">
        <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">Asset Intelligence</div>
          <div className={`text-2xl md:text-3xl font-black uppercase tracking-tighter flex items-center gap-1.5 ${profileTierTone.headerText}`}>
           {(profile.loyaltyTier === 'VIP' || profile.loyaltyTier === 'VVIP') && (
             <Star size={18} className={profile.loyaltyTier === 'VVIP' ? 'text-amber-500 dark:text-pink-300' : 'text-slate-500 dark:text-violet-300'} fill="currentColor" />
           )}
           {(profile.loyaltyTier === 'VVIP') && (
             <Star size={14} className="text-pink-500 dark:text-pink-300" fill="currentColor" />
           )}
           {profile.loyaltyTier}
        </div>
      </div>
    </div>
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
       {[
         { label: 'LTV Yield', val: `$${profile.totalSpend.toFixed(2)}`, icon: DollarSign, color: 'text-brand-900 dark:text-emerald-500' },
         { label: 'Reliability', val: `${profile.reliabilityScore}%`, icon: Activity, color: 'text-blue-600' },
         { label: 'Completed', val: profile.completedTrips, icon: Hash, color: 'text-slate-900 dark:text-white' },
         { label: 'Risk', val: profile.cancelledTrips, icon: AlertCircle, color: 'text-red-600' }
       ].map((box, i) => (
         <div key={i} className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 p-5 md:p-6 rounded-3xl shadow-sm">
            <div className="p-2.5 bg-slate-50 dark:bg-black rounded-xl w-fit mb-4 text-slate-400"><box.icon size={16} /></div>
            <p className="text-[9px] font-black text-slate-400 dark:text-slate-600 uppercase tracking-widest mb-1">{box.label}</p>
            <p className={`text-2xl font-black tracking-tighter ${box.color}`}>{box.val}</p>
         </div>
       ))}
    </div>

    <div className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 rounded-[2rem] p-6 md:p-8 space-y-4">
      <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400">Market Segment</h4>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <button
          type="button"
          onClick={() => toggleSegment('EXPAT')}
          className={`h-11 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-colors ${isSegmentActive('EXPAT') ? 'border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10' : 'border-slate-200 text-slate-500 bg-white dark:border-white/10 dark:text-slate-300 dark:bg-brand-950'}`}
        >
          EXPAT
        </button>
        <button
          type="button"
          onClick={() => toggleSegment('TOURIST')}
          className={`h-11 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-colors ${isSegmentActive('TOURIST') ? 'border-purple-300 text-purple-700 bg-purple-50 dark:border-purple-900/40 dark:text-purple-300 dark:bg-purple-900/10' : 'border-slate-200 text-slate-500 bg-white dark:border-white/10 dark:text-slate-300 dark:bg-brand-950'}`}
        >
          TOURIST
        </button>
        <button
          type="button"
          onClick={() => toggleSegment('LOCAL_RESIDENT')}
          className={`h-11 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-colors ${isSegmentActive('LOCAL_RESIDENT') ? 'border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10' : 'border-slate-200 text-slate-500 bg-white dark:border-white/10 dark:text-slate-300 dark:bg-brand-950'}`}
        >
          LOCAL RESIDENT
        </button>
      </div>
      <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
        Active: {isUndecidedInternational ? 'EXPAT or TOURIST (pick one)' : (activeSegments.length > 0 ? activeSegments.map(segment => segment === 'LOCAL_RESIDENT' ? 'LOCAL RESIDENT' : segment).join(' + ') : 'None')}
      </p>
    </div>

    <div className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 rounded-[2rem] p-6 md:p-8 space-y-4">
      <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400">Gender Marker</h4>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <button
          type="button"
          onClick={() => onUpdateGender(profile, 'MALE')}
          className={`h-11 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-colors ${profile.gender === 'MALE' ? 'border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10' : 'border-slate-200 text-slate-500 bg-white dark:border-white/10 dark:text-slate-300 dark:bg-brand-950'}`}
        >
          Male
        </button>
        <button
          type="button"
          onClick={() => onUpdateGender(profile, 'FEMALE')}
          className={`h-11 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-colors ${profile.gender === 'FEMALE' ? 'border-pink-300 text-pink-700 bg-pink-50 dark:border-pink-900/40 dark:text-pink-300 dark:bg-pink-900/10' : 'border-slate-200 text-slate-500 bg-white dark:border-white/10 dark:text-slate-300 dark:bg-brand-950'}`}
        >
          Female
        </button>
        <button
          type="button"
          onClick={() => onUpdateGender(profile, 'UNSPECIFIED')}
          className={`h-11 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-colors ${profile.gender === 'UNSPECIFIED' ? 'border-slate-300 text-slate-700 bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:bg-slate-900/20' : 'border-slate-200 text-slate-500 bg-white dark:border-white/10 dark:text-slate-300 dark:bg-brand-950'}`}
        >
          Unspecified
        </button>
      </div>
      <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
        Active: {profile.gender || 'UNSPECIFIED'}
      </p>
    </div>

    <div className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 rounded-[2rem] p-6 md:p-8 space-y-4">
      <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400">Business & Profession</h4>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <button
          type="button"
          onClick={() => onUpdateEntityType(profile, 'BUSINESS')}
          className={`h-11 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-colors ${profile.entityType === 'BUSINESS' ? 'border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-900/40 dark:text-amber-300 dark:bg-amber-900/10' : 'border-slate-200 text-slate-500 bg-white dark:border-white/10 dark:text-slate-300 dark:bg-brand-950'}`}
        >
          Business
        </button>
        <button
          type="button"
          onClick={() => onUpdateEntityType(profile, 'INDIVIDUAL')}
          className={`h-11 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-colors ${profile.entityType === 'INDIVIDUAL' ? 'border-cyan-300 text-cyan-700 bg-cyan-50 dark:border-cyan-900/40 dark:text-cyan-300 dark:bg-cyan-900/10' : 'border-slate-200 text-slate-500 bg-white dark:border-white/10 dark:text-slate-300 dark:bg-brand-950'}`}
        >
          Individual
        </button>
        <button
          type="button"
          onClick={() => onUpdateEntityType(profile, 'UNSPECIFIED')}
          className={`h-11 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-colors ${profile.entityType === 'UNSPECIFIED' ? 'border-slate-300 text-slate-700 bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:bg-slate-900/20' : 'border-slate-200 text-slate-500 bg-white dark:border-white/10 dark:text-slate-300 dark:bg-brand-950'}`}
        >
          Unspecified
        </button>
      </div>
      <div className="space-y-2">
        <input
          type="text"
          value={professionDraft}
          onChange={(event) => setProfessionDraft(event.target.value)}
          placeholder="Profession (e.g., Doctor, Engineer)"
          className="w-full h-11 px-4 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-950 text-[10px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-200 outline-none"
        />
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => onUpdateProfession(profile, professionDraft)}
            className="h-10 rounded-xl border border-teal-300 dark:border-teal-900/40 bg-teal-50 dark:bg-teal-900/10 text-[10px] font-black uppercase tracking-widest text-teal-700 dark:text-teal-300"
          >
            Save Profession
          </button>
          <button
            type="button"
            onClick={() => {
              setProfessionDraft('');
              onUpdateProfession(profile, '');
            }}
            className="h-10 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-950 text-[10px] font-black uppercase tracking-widest text-slate-500"
          >
            Clear
          </button>
        </div>
      </div>
      <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
        Type: {profile.entityType || 'UNSPECIFIED'}{(profile.profession || '').trim() ? ` · Profession: ${profile.profession}` : ''}
      </p>
    </div>

    <div id={`saved-places-${customerPhoneKey(profile.phone)}`} className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 rounded-[2rem] p-6 md:p-8 space-y-4">
      <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400">Saved Places</h4>
      <div className="space-y-2">
        <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Home Address</p>
        <input
          type="text"
          value={homeAddressDraft}
          onChange={(event) => setHomeAddressDraft(event.target.value)}
          placeholder="Street or area"
          className="w-full h-11 px-4 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-950 text-[10px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-200 outline-none"
        />
        <input
          type="text"
          value={homeMapDraft}
          onChange={(event) => setHomeMapDraft(event.target.value)}
          placeholder="Google Maps link or lat,lng"
          className="w-full h-11 px-4 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-950 text-[10px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-200 outline-none"
        />
      </div>
      <div className="space-y-2">
        <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Business Address</p>
        <input
          type="text"
          value={businessAddressDraft}
          onChange={(event) => setBusinessAddressDraft(event.target.value)}
          placeholder="Office, shop, or branch"
          className="w-full h-11 px-4 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-950 text-[10px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-200 outline-none"
        />
        <input
          type="text"
          value={businessMapDraft}
          onChange={(event) => setBusinessMapDraft(event.target.value)}
          placeholder="Google Maps link or lat,lng"
          className="w-full h-11 px-4 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-950 text-[10px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-200 outline-none"
        />
      </div>
      <div className="space-y-2">
        <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Frequent Places (one per line)</p>
        <textarea
          value={frequentLocationsDraft}
          onChange={(event) => setFrequentLocationsDraft(event.target.value)}
          placeholder="Google Maps links, geocodes, or plain place text"
          rows={4}
          className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-950 text-[10px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-200 outline-none"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => onUpdateLocations(profile, {
            homeAddress: homeAddressDraft,
            homeMapOrCoords: homeMapDraft,
            businessAddress: businessAddressDraft,
            businessMapOrCoords: businessMapDraft,
            frequentLocationsText: frequentLocationsDraft,
          })}
          className="h-10 rounded-xl border border-blue-300 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 text-[10px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300"
        >
          Save Places
        </button>
        <button
          type="button"
          onClick={() => {
            setHomeAddressDraft('');
            setHomeMapDraft('');
            setBusinessAddressDraft('');
            setBusinessMapDraft('');
            setFrequentLocationsDraft('');
            onUpdateLocations(profile, {
              homeAddress: '',
              homeMapOrCoords: '',
              businessAddress: '',
              businessMapOrCoords: '',
              frequentLocationsText: '',
            });
          }}
          className="h-10 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-950 text-[10px] font-black uppercase tracking-widest text-slate-500"
        >
          Clear Places
        </button>
      </div>
    </div>

    <div className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 rounded-[2rem] p-6 md:p-8 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400">Profile Memory</h4>
        <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">{profile.profileTimeline?.length || 0} entries</span>
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4">
        <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2">Customer Notes</p>
        <p className="text-[11px] font-bold text-brand-900 dark:text-slate-200 whitespace-pre-wrap break-words">{profile.notes?.trim() || 'No profile notes yet.'}</p>
      </div>

      {profile.profileTimeline && profile.profileTimeline.length > 0 && (
        <div className="space-y-3">
          {profile.profileTimeline.slice(0, 6).map(entry => (
            <div key={entry.id} className="rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4">
              <div className="flex items-center justify-between gap-3 mb-2">
                <span className="text-[8px] font-black uppercase tracking-widest text-slate-400">{entry.source}</span>
                <span className="text-[8px] font-bold uppercase tracking-wider text-slate-400">{format(parseISO(entry.timestamp), 'MMM d, h:mm a')}</span>
              </div>
              <p className="text-[11px] font-bold text-brand-900 dark:text-slate-200 break-words">{entry.note}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  </div>
  );
};

const DirectoryOverviewView: React.FC<{
  profiles: EnhancedCustomerProfile[];
  onSelectCustomer: (phone: string) => void;
}> = ({ profiles, onSelectCustomer }) => {
  const bookedCustomers = profiles.filter(profile => profile.totalTrips > 0);
  const bookedCustomersCount = bookedCustomers.length;
  const activationRate = profiles.length > 0 ? Math.round((bookedCustomersCount / profiles.length) * 100) : 0;
  const activeBookersLast30Days = bookedCustomers.filter(profile => profile.recencyDays <= 30).length;
  const vipCount = profiles.filter(profile => profile.loyaltyTier === 'VIP' || profile.loyaltyTier === 'VVIP').length;
  const highReliability = bookedCustomers.filter(profile => profile.reliabilityScore >= 80).length;
  const topSpenders = [...bookedCustomers]
    .sort((a, b) => b.totalSpend - a.totalSpend)
    .slice(0, 6);

  return (
    <div className="space-y-8 md:space-y-12 animate-in fade-in duration-700">
      <div className="border-b border-slate-200 dark:border-white/10 pb-6">
        <h2 className="text-3xl md:text-5xl font-black tracking-tighter uppercase text-brand-900 dark:text-white">Directory Overview</h2>
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400 mt-2">Select a contact from the feed to open full intelligence</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
        {[
          { label: 'Total Contacts', value: profiles.length, tone: 'text-brand-900 dark:text-white', icon: Users },
          { label: 'Booked Customers', value: bookedCustomersCount, tone: 'text-emerald-600', icon: Activity },
          { label: 'Booker Rate', value: `${activationRate}%`, tone: 'text-blue-600', icon: BarChart3 },
          { label: 'Active Bookers 30D', value: activeBookersLast30Days, tone: 'text-indigo-600', icon: UserCheck },
          { label: 'VIP + VVIP', value: vipCount, tone: 'text-gold-600', icon: Star },
          { label: 'Reliable 80%+', value: highReliability, tone: 'text-blue-600', icon: ShieldCheck },
        ].map((card, index) => (
          <div key={index} className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 p-5 md:p-6 rounded-3xl shadow-sm">
            <div className="p-2.5 bg-slate-50 dark:bg-black rounded-xl w-fit mb-4 text-slate-400"><card.icon size={16} /></div>
            <p className="text-[9px] font-black text-slate-400 dark:text-slate-600 uppercase tracking-widest mb-1">{card.label}</p>
            <p className={`text-2xl font-black tracking-tighter ${card.tone}`}>{card.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 rounded-[2rem] p-6 md:p-8">
        <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400 mb-4">Top Customer Value</h4>
        <div className="space-y-3">
          {topSpenders.length > 0 ? topSpenders.map(profile => (
            <button
              key={profile.phone}
              type="button"
              onClick={() => onSelectCustomer(profile.phone)}
              className="w-full text-left flex items-center justify-between bg-slate-50 dark:bg-brand-950 rounded-xl px-4 py-3 border border-slate-200 dark:border-white/10 hover:bg-brand-50 dark:hover:bg-emerald-500/5 transition-colors"
            >
              <div>
                <p className="text-sm font-black uppercase tracking-tight text-brand-900 dark:text-white">{profile.name}</p>
                <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">{profile.completedTrips} completed · reliability {profile.reliabilityScore}%</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-black text-emerald-600">${profile.totalSpend.toFixed(0)}</p>
                <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">LTV</p>
              </div>
            </button>
          )) : (
            <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-4 py-5">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">No customer profiles yet. Add trips to populate the directory.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const FleetOverviewView: React.FC<{
  units: FleetUnitStats[];
  windowLabel: string;
  onSelectDriver: (driverId: string) => void;
}> = ({ units, windowLabel, onSelectDriver }) => {
  const activeUnits = units.filter(unit => unit.driver.status === 'ACTIVE').length;
  const lowFuelUnits = units.filter(unit => unit.isFuelLow).length;
  const maintenanceAlerts = units.filter(unit => unit.isOilUrgent || unit.isCheckupUrgent).length;
  const ownerDriverUnits = units.filter(unit => unit.driver.vehicleOwnership === 'OWNER_DRIVER').length;
  const topUnits = [...units]
    .sort((a, b) => b.profitabilityIndex - a.profitabilityIndex)
    .slice(0, 6);

  return (
    <div className="space-y-8 md:space-y-12 animate-in fade-in duration-700">
      <div className="border-b border-slate-200 dark:border-white/10 pb-6">
        <h2 className="text-3xl md:text-5xl font-black tracking-tighter uppercase text-brand-900 dark:text-white">Fleet Overview</h2>
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400 mt-2">{windowLabel} snapshot · Select a unit for full readiness intelligence</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
        {[
          { label: 'Total Units', value: units.length, tone: 'text-brand-900 dark:text-white', icon: Car },
          { label: 'Active Units', value: activeUnits, tone: 'text-emerald-600', icon: UserCheck },
          { label: 'Low Fuel', value: lowFuelUnits, tone: lowFuelUnits > 0 ? 'text-red-500' : 'text-slate-500', icon: Fuel },
          { label: 'Owner Drivers', value: ownerDriverUnits, tone: ownerDriverUnits > 0 ? 'text-indigo-600' : 'text-slate-500', icon: User },
        ].map((card, index) => (
          <div key={index} className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 p-5 md:p-6 rounded-3xl shadow-sm">
            <div className="p-2.5 bg-slate-50 dark:bg-black rounded-xl w-fit mb-4 text-slate-400"><card.icon size={16} /></div>
            <p className="text-[9px] font-black text-slate-400 dark:text-slate-600 uppercase tracking-widest mb-1">{card.label}</p>
            <p className={`text-2xl font-black tracking-tighter ${card.tone}`}>{card.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 rounded-[2rem] p-6 md:p-8">
        <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400 mb-4">Top Fleet Net Alpha</h4>
        <div className="space-y-3">
          {topUnits.length > 0 ? topUnits.map(unit => (
            <button
              key={unit.driver.id}
              type="button"
              onClick={() => onSelectDriver(unit.driver.id)}
              className="w-full text-left flex items-center justify-between bg-slate-50 dark:bg-brand-950 rounded-xl px-4 py-3 border border-slate-200 dark:border-white/10 hover:bg-brand-50 dark:hover:bg-emerald-500/5 transition-colors"
            >
              <div>
                <p className="text-sm font-black uppercase tracking-tight text-brand-900 dark:text-white">{unit.driver.name}</p>
                <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">{unit.driver.plateNumber} · {ownershipLabelMap[unit.driver.vehicleOwnership || 'COMPANY_FLEET']} · {unit.completedTrips} completed</p>
                <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 mt-1">
                  {unit.isFuelLow
                    ? 'Next Action: Refuel now'
                    : (unit.isOilUrgent || unit.isCheckupUrgent)
                      ? 'Next Action: Schedule maintenance'
                      : 'Next Action: No immediate action'}
                </p>
              </div>
              <div className="text-right">
                <p className={`text-sm font-black ${unit.profitabilityIndex >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>${unit.profitabilityIndex.toFixed(0)}</p>
                <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">Net Alpha</p>
                <p className="text-[8px] font-black uppercase tracking-widest text-amber-600 dark:text-amber-400 mt-1">Fuel {responsibilityLabelMap[unit.driver.fuelCostResponsibility || 'COMPANY']}</p>
              </div>
            </button>
          )) : (
            <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-4 py-5">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">No fleet telemetry yet. Complete missions to unlock readiness insights.</p>
            </div>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 rounded-[2rem] p-6 md:p-8">
        <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400 mb-4">Readiness Alerts</h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 px-4 py-3">
            <p className="text-[8px] font-black uppercase tracking-widest text-red-600">Refuel Needed</p>
            <p className="text-xl font-black text-red-600 mt-1">{lowFuelUnits}</p>
          </div>
          <div className="rounded-xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 px-4 py-3">
            <p className="text-[8px] font-black uppercase tracking-widest text-amber-700">Service Due</p>
            <p className="text-xl font-black text-amber-700 mt-1">{maintenanceAlerts}</p>
          </div>
          <div className="rounded-xl border border-indigo-200 dark:border-indigo-900/40 bg-indigo-50 dark:bg-indigo-900/10 px-4 py-3">
            <p className="text-[8px] font-black uppercase tracking-widest text-indigo-700">Owner Drivers</p>
            <p className="text-xl font-black text-indigo-700 mt-1">{ownerDriverUnits}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

const FleetReadinessView: React.FC<{
  stats: FleetUnitStats;
  onRefuel: () => void;
  onUpdateGovernance: (payload: {
    vehicleOwnership: DriverVehicleOwnership;
    fuelCostResponsibility: DriverCostResponsibility;
    maintenanceResponsibility: DriverCostResponsibility;
    fuelRangeKm: number;
    companyShareOverridePercent?: number;
  }) => void;
  onRemoveFromFleet: () => void;
  windowLabel: string;
}> = ({ stats, onRefuel, onUpdateGovernance, onRemoveFromFleet, windowLabel }) => {
  const driverPhoneKey = customerPhoneKey(stats.driver.phone);
  const driverCallHref = driverPhoneKey ? `tel:+${driverPhoneKey}` : '';
  const driverWhatsappHref = buildWhatsAppLink(driverPhoneKey) || '';
  const [ownershipDraft, setOwnershipDraft] = useState<DriverVehicleOwnership>(stats.driver.vehicleOwnership || 'COMPANY_FLEET');
  const [fuelCostDraft, setFuelCostDraft] = useState<DriverCostResponsibility>(stats.driver.fuelCostResponsibility || 'COMPANY');
  const [maintenanceCostDraft, setMaintenanceCostDraft] = useState<DriverCostResponsibility>(stats.driver.maintenanceResponsibility || 'COMPANY');
  const [fuelRangeDraft, setFuelRangeDraft] = useState(String(stats.driver.fuelRangeKm || 500));
  const [companyShareOverrideDraft, setCompanyShareOverrideDraft] = useState<string>(
    typeof stats.driver.companyShareOverridePercent === 'number' && Number.isFinite(stats.driver.companyShareOverridePercent)
      ? String(stats.driver.companyShareOverridePercent)
      : ''
  );
  const recentFuelLogs = Array.isArray(stats.driver.fuelLogs)
    ? stats.driver.fuelLogs
        .slice()
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 5)
    : [];

  useEffect(() => {
    setOwnershipDraft(stats.driver.vehicleOwnership || 'COMPANY_FLEET');
    setFuelCostDraft(stats.driver.fuelCostResponsibility || 'COMPANY');
    setMaintenanceCostDraft(stats.driver.maintenanceResponsibility || 'COMPANY');
    setFuelRangeDraft(String(stats.driver.fuelRangeKm || 500));
    setCompanyShareOverrideDraft(
      typeof stats.driver.companyShareOverridePercent === 'number' && Number.isFinite(stats.driver.companyShareOverridePercent)
        ? String(stats.driver.companyShareOverridePercent)
        : ''
    );
  }, [
    stats.driver.id,
    stats.driver.vehicleOwnership,
    stats.driver.fuelCostResponsibility,
    stats.driver.maintenanceResponsibility,
    stats.driver.fuelRangeKm,
    stats.driver.companyShareOverridePercent,
  ]);

  const handleExportFuelLedger = () => {
    const logs = Array.isArray(stats.driver.fuelLogs)
      ? stats.driver.fuelLogs.slice().sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      : [];
    if (logs.length === 0) return;

    const escapeCsv = (value: unknown): string => {
      const text = String(value ?? '');
      if (text.includes('"') || text.includes(',') || text.includes('\n')) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    };

    const headers = ['driver_id', 'driver_name', 'plate_number', 'timestamp', 'currency', 'amount_original', 'fx_snapshot', 'amount_lbp', 'amount_usd', 'odometer_km', 'note'];
    const rows = logs.map(log => [
      stats.driver.id,
      stats.driver.name,
      stats.driver.plateNumber,
      log.timestamp,
      log.currency || 'USD',
      Number(log.amountOriginal ?? log.amountUsd ?? 0).toFixed(log.currency === 'LBP' ? 0 : 2),
      Number(log.fxRateSnapshot || 0).toFixed(0),
      Number(log.amountLbp || 0).toFixed(0),
      Number(log.amountUsd || 0).toFixed(2),
      typeof log.odometerKm === 'number' ? Math.round(log.odometerKm) : '',
      log.note || '',
    ].map(escapeCsv).join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `fuel-ledger-${stats.driver.plateNumber}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-8 md:space-y-12 animate-in fade-in duration-700">
      <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-slate-200 dark:border-white/10 pb-6 gap-4">
        <div>
          <h2 className="text-3xl md:text-5xl font-black tracking-tighter uppercase">{stats.driver.carModel}</h2>
          <div className="flex flex-wrap items-center mt-3 gap-4">
            <div className="flex items-center space-x-2 text-gold-600 font-black tracking-widest text-xs uppercase">
              <Gear size={14}/> <span>PLT: {stats.driver.plateNumber}</span>
            </div>
            <div className="flex items-center space-x-2 bg-slate-100 dark:bg-white/5 px-3 py-1 rounded-full border border-slate-200 dark:border-white/10">
              <Car size={14} className="text-slate-400" />
              <span className="text-[9px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300">{ownershipLabelMap[stats.driver.vehicleOwnership || 'COMPANY_FLEET']}</span>
            </div>
            <div className="flex items-center space-x-2 bg-amber-50 dark:bg-amber-900/10 px-3 py-1 rounded-full border border-amber-200 dark:border-amber-900/30">
              <Fuel size={14} className="text-amber-600" />
              <span className="text-[9px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-300">Fuel {responsibilityLabelMap[stats.driver.fuelCostResponsibility || 'COMPANY']}</span>
            </div>
            <div className="flex items-center space-x-2 bg-blue-50 dark:bg-blue-900/10 px-3 py-1 rounded-full border border-blue-200 dark:border-blue-900/30">
              <ShieldCheck size={14} className="text-blue-600" />
              <span className="text-[9px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300">Maint {responsibilityLabelMap[stats.driver.maintenanceResponsibility || 'COMPANY']}</span>
            </div>
            <div className="flex items-center space-x-2 bg-slate-100 dark:bg-white/5 px-3 py-1 rounded-full border border-slate-200 dark:border-white/10">
              <Star size={14} className="text-gold-500 fill-gold-500" />
              <span className="text-xs font-black text-brand-900 dark:text-gold-400">{stats.avgRating.toFixed(1)}</span>
              <span className="text-[9px] font-bold text-slate-400">({stats.ratingCount} SAMPLES)</span>
            </div>
            {driverCallHref && (
              <a
                href={driverCallHref}
                className="h-8 px-3 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-950 text-[9px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 inline-flex items-center"
              >
                Call
              </a>
            )}
            {driverWhatsappHref && (
              <a
                href={driverWhatsappHref}
                target="_blank"
                rel="noopener noreferrer"
                className="h-8 px-3 rounded-lg border border-emerald-300 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[9px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300 inline-flex items-center"
              >
                WhatsApp
              </a>
            )}
            <button
              type="button"
              onClick={onRemoveFromFleet}
              className="h-8 px-3 rounded-lg border border-red-300 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 text-[9px] font-black uppercase tracking-widest text-red-700 dark:text-red-300 inline-flex items-center"
            >
              Remove Fleet
            </button>
          </div>
        </div>
        <div className="md:text-right">
          <div className="text-[10px] font-black text-slate-400 uppercase mb-1">Odometer</div>
          <div className="text-2xl md:text-3xl font-black uppercase text-brand-900 dark:text-white">
            {stats.totalOdometer.toLocaleString()} <span className="text-xs text-slate-400 font-bold uppercase tracking-widest ml-1">KM</span>
          </div>
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 mt-2">Window: {windowLabel}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Mission Yield', val: `$${stats.revenue.toFixed(0)}`, icon: DollarSign, color: 'text-emerald-500' },
          { label: 'Fuel Overhead', val: `$${stats.gasSpent.toFixed(0)}`, icon: Droplet, color: 'text-red-400' },
          { label: 'Net Alpha', val: `$${stats.profitabilityIndex.toFixed(0)}`, icon: TrendingUp, color: 'text-blue-500' },
          { label: 'Burn Ratio', val: `${(stats.fuelBurnRatio * 100).toFixed(1)}%`, icon: Zap, color: 'text-gold-500' }
        ].map((box, i) => (
          <div key={i} className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 p-5 rounded-2xl">
            <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">{box.label}</p>
            <p className={`text-lg font-black tracking-tighter ${box.color}`}>{box.val}</p>
          </div>
        ))}
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-brand-900 p-8 rounded-[2rem] border border-slate-200 dark:border-white/10 shadow-sm space-y-5">
          <div className="flex items-center space-x-3 text-brand-900 dark:text-indigo-400">
            <Briefcase size={20} />
            <h4 className="text-xs font-black uppercase tracking-widest">Asset Governance</h4>
          </div>
          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1 block">Ownership</label>
              <select value={ownershipDraft} onChange={e => setOwnershipDraft(e.target.value as DriverVehicleOwnership)} className="w-full h-10 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-3 text-[10px] font-black uppercase tracking-widest">
                <option value="COMPANY_FLEET">Company Fleet</option>
                <option value="OWNER_DRIVER">Owner Driver</option>
                <option value="RENTAL">Rental</option>
              </select>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1 block">Fuel Cost</label>
                <select value={fuelCostDraft} onChange={e => setFuelCostDraft(e.target.value as DriverCostResponsibility)} className="w-full h-10 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-3 text-[10px] font-black uppercase tracking-widest">
                  <option value="COMPANY">Company</option>
                  <option value="DRIVER">Driver</option>
                  <option value="SHARED">Shared</option>
                </select>
              </div>
              <div>
                <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1 block">Maintenance Cost</label>
                <select value={maintenanceCostDraft} onChange={e => setMaintenanceCostDraft(e.target.value as DriverCostResponsibility)} className="w-full h-10 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-3 text-[10px] font-black uppercase tracking-widest">
                  <option value="COMPANY">Company</option>
                  <option value="DRIVER">Driver</option>
                  <option value="SHARED">Shared</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1 block">Fuel Range (KM)</label>
              <input
                type="number"
                min={1}
                value={fuelRangeDraft}
                onChange={e => setFuelRangeDraft(e.target.value)}
                className="w-full h-10 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-3 text-[10px] font-black uppercase tracking-widest"
              />
            </div>
            <div>
              <label className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1 block">Company Share Override % (Optional)</label>
              <input
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={companyShareOverrideDraft}
                onChange={e => setCompanyShareOverrideDraft(e.target.value)}
                placeholder="Leave empty for auto rules"
                className="w-full h-10 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-3 text-[10px] font-black uppercase tracking-widest"
              />
            </div>
            <button
              type="button"
              onClick={() => onUpdateGovernance({
                vehicleOwnership: ownershipDraft,
                fuelCostResponsibility: fuelCostDraft,
                maintenanceResponsibility: maintenanceCostDraft,
                fuelRangeKm: Number(fuelRangeDraft),
                companyShareOverridePercent: companyShareOverrideDraft.trim() === '' ? undefined : Number(companyShareOverrideDraft),
              })}
              className="h-10 rounded-xl border border-indigo-300 dark:border-indigo-900/40 bg-indigo-50 dark:bg-indigo-900/10 text-[10px] font-black uppercase tracking-widest text-indigo-700 dark:text-indigo-300"
            >
              Save Governance
            </button>
          </div>
        </div>

        <div className="bg-white dark:bg-brand-900 p-8 rounded-[2rem] border border-slate-200 dark:border-white/10 shadow-sm space-y-6">
          <div className="flex justify-between items-center"><div className="flex items-center space-x-3 text-brand-900 dark:text-emerald-500"><Droplet size={20} /><h4 className="text-xs font-black uppercase tracking-widest">Lubrication</h4></div><span className="text-xl font-black">{stats.oilChangeStatus}%</span></div>
          <div className="h-4 w-full bg-slate-100 dark:bg-black rounded-full overflow-hidden p-1"><div className={`h-full rounded-full transition-all duration-1000 ${stats.isOilUrgent ? 'bg-red-500' : 'bg-brand-900 dark:bg-emerald-500'}`} style={{ width: `${stats.oilChangeStatus}%` }} /></div>
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">{stats.kmSinceOil.toLocaleString()} KM since last change</p>
        </div>

        <div className="bg-white dark:bg-brand-900 p-8 rounded-[2rem] border border-slate-200 dark:border-white/10 shadow-sm space-y-6">
          <div className="flex justify-between items-center">
            <div className="flex items-center space-x-3 text-brand-900 dark:text-gold-500"><Fuel size={20} /><h4 className="text-xs font-black uppercase tracking-widest">Propulsion</h4></div>
            <span className="text-xl font-black">{stats.fuelLevel}%</span>
          </div>
          <div className="h-4 w-full bg-slate-100 dark:bg-black rounded-full overflow-hidden p-1">
            <div className={`h-full rounded-full transition-all duration-1000 ${stats.isFuelLow ? 'bg-red-500 animate-pulse' : 'bg-gold-500'}`} style={{ width: `${stats.fuelLevel}%` }} />
          </div>
          <div className="flex justify-between items-end">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Est. Range: {Math.round((stats.fuelLevel/100) * (stats.driver.fuelRangeKm || 500))} KM</p>
            <button onClick={onRefuel} className="flex items-center space-x-2 text-[10px] font-black uppercase text-gold-600 hover:text-gold-400 transition-colors"><RefreshCcw size={12}/> <span>Log Refuel</span></button>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-brand-900 p-8 rounded-[2rem] border border-slate-200 dark:border-white/10 shadow-sm">
        <div className="flex items-center space-x-3 text-brand-900 dark:text-blue-500 mb-8"><ShieldCheck size={20} /><h4 className="text-xs font-black uppercase tracking-widest">General Checkup</h4></div>
        <div className="h-4 w-full bg-slate-100 dark:bg-black rounded-full overflow-hidden p-1 mb-4"><div className={`h-full rounded-full transition-all duration-1000 ${stats.isCheckupUrgent ? 'bg-red-500' : 'bg-blue-500'}`} style={{ width: `${stats.checkupStatus}%` }} /></div>
        <div className="flex justify-between items-center">
           <span className="text-xl font-black">{stats.checkupStatus}% Readiness</span>
           <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">{stats.kmSinceCheckup.toLocaleString()} KM since full audit</span>
        </div>
      </div>

      <div className="bg-white dark:bg-brand-900 p-8 rounded-[2rem] border border-slate-200 dark:border-white/10 shadow-sm space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3 text-brand-900 dark:text-emerald-500">
            <Droplet size={20} />
            <h4 className="text-xs font-black uppercase tracking-widest">Fuel Ledger</h4>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">Last 5 Logs</span>
            <button
              type="button"
              onClick={handleExportFuelLedger}
              disabled={recentFuelLogs.length === 0}
              className="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-950 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Export CSV
            </button>
          </div>
        </div>

        {recentFuelLogs.length > 0 ? (
          <div className="space-y-2">
            {recentFuelLogs.map(log => (
              <div key={log.id} className="flex items-center justify-between rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-4 py-3">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-brand-900 dark:text-slate-100">{format(parseISO(log.timestamp), 'MMM d, h:mm a')}</p>
                  <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{typeof log.odometerKm === 'number' ? `${Math.round(log.odometerKm).toLocaleString()} KM` : 'ODOMETER N/A'}</p>
                  <p className="text-[8px] font-bold uppercase tracking-wider text-slate-400">{log.currency || 'USD'} {Number(log.amountOriginal ?? log.amountUsd ?? 0).toLocaleString(undefined, { maximumFractionDigits: (log.currency === 'LBP' ? 0 : 2) })}{log.currency === 'LBP' ? ` · FX ${Math.round(Number(log.fxRateSnapshot || 0)).toLocaleString()}` : ''}</p>
                </div>
                <p className="text-sm font-black text-emerald-600 dark:text-emerald-400">${(Number(log.amountUsd) || 0).toFixed(2)}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-4 py-5">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">No fuel logs yet. Use Log Refuel to create entries.</p>
          </div>
        )}
      </div>
    </div>
  );
};

const FinanceCreditPanel: React.FC<{
  entries: CreditLedgerEntry[];
  receipts: ReceiptRecord[];
  customers: Customer[];
  drivers: Driver[];
  onCreateCreditEntry: (payload: {
    partyType: CreditPartyType;
    partyName: string;
    cycle: CreditCycle;
    amountUsd: number;
    partyId?: string;
    dueDate?: string;
    notes?: string;
  }) => void;
  onSettleCreditEntry: (entryId: string) => void;
  filterDriverId?: string;
}> = ({ entries, receipts, customers, drivers, onCreateCreditEntry, onSettleCreditEntry, filterDriverId }) => {
  const [partyType, setPartyType] = useState<CreditPartyType>('CLIENT');
  const [cycle, setCycle] = useState<CreditCycle>('WEEKLY');
  const [partyId, setPartyId] = useState('');
  const [amountUsd, setAmountUsd] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (filterDriverId) {
      setPartyType('DRIVER');
      setPartyId(filterDriverId);
    }
  }, [filterDriverId]);

  const partyOptions = partyType === 'CLIENT'
    ? customers.map(item => ({ id: item.id, name: item.name }))
    : drivers.map(item => ({ id: item.id, name: item.name }));

  const filteredEntries = entries.filter(entry => {
    if (!filterDriverId) return true;
    return entry.partyType === 'DRIVER' && entry.partyId === filterDriverId;
  });

  const openEntries = filteredEntries.filter(entry => entry.status === 'OPEN');
  const openBacklog = openEntries.reduce((sum, entry) => sum + entry.amountUsd, 0);
  const recentReceipts = receipts
    .filter(receipt => {
      if (!filterDriverId) return true;
      return receipt.partyType === 'DRIVER' && drivers.some(driver => driver.id === filterDriverId && driver.name === receipt.partyName);
    })
    .slice(0, 6);

  const exportOpenBacklogCsv = () => {
    if (openEntries.length === 0) return;

    const escapeCsv = (value: unknown): string => {
      const text = String(value ?? '');
      if (text.includes('"') || text.includes(',') || text.includes('\n')) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    };

    const headers = ['entry_id', 'party_type', 'party_name', 'cycle', 'amount_usd', 'due_date', 'notes', 'created_at'];
    const rows = openEntries.map(entry => [
      entry.id,
      entry.partyType,
      entry.partyName,
      entry.cycle,
      entry.amountUsd.toFixed(2),
      entry.dueDate || '',
      entry.notes || '',
      entry.createdAt,
    ].map(escapeCsv).join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `open-backlog-${filterDriverId || 'all'}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const submitCredit = () => {
    const amount = Number(amountUsd);
    const selectedParty = partyOptions.find(option => option.id === partyId);
    if (!selectedParty) return;

    onCreateCreditEntry({
      partyType,
      partyId: selectedParty.id,
      partyName: selectedParty.name,
      cycle,
      amountUsd: amount,
      dueDate: dueDate || undefined,
      notes: notes.trim() || undefined,
    });

    setAmountUsd('');
    setDueDate('');
    setNotes('');
  };

  return (
    <div className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 rounded-[2rem] p-6 md:p-8 space-y-5">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400">Credit Ledger</h4>
          <p className="text-[9px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300 mt-1">Open backlog ${openBacklog.toFixed(2)} · {openEntries.length} open</p>
        </div>
        <button
          type="button"
          onClick={exportOpenBacklogCsv}
          disabled={openEntries.length === 0}
          className="h-8 px-3 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-950 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Export Open CSV
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <select value={partyType} onChange={event => { setPartyType(event.target.value as CreditPartyType); setPartyId(''); }} className="h-10 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-3 text-[10px] font-black uppercase tracking-widest">
          <option value="CLIENT">Client Credit</option>
          <option value="DRIVER">Driver Credit</option>
        </select>
        <select value={cycle} onChange={event => setCycle(event.target.value as CreditCycle)} className="h-10 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-3 text-[10px] font-black uppercase tracking-widest">
          <option value="WEEKLY">Weekly</option>
          <option value="MONTHLY">Monthly</option>
        </select>
        <select value={partyId} onChange={event => setPartyId(event.target.value)} className="h-10 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-3 text-[10px] font-black uppercase tracking-widest">
          <option value="">Select {partyType === 'CLIENT' ? 'Client' : 'Driver'}</option>
          {partyOptions.map(option => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <input
          type="number"
          min={0}
          step={0.01}
          value={amountUsd}
          onChange={event => setAmountUsd(event.target.value)}
          placeholder="Amount USD"
          className="h-10 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-3 text-[10px] font-black uppercase tracking-widest"
        />
        <input
          type="date"
          value={dueDate}
          onChange={event => setDueDate(event.target.value)}
          className="h-10 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-3 text-[10px] font-black uppercase tracking-widest"
        />
        <input
          type="text"
          value={notes}
          onChange={event => setNotes(event.target.value)}
          placeholder="Notes"
          className="h-10 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-3 text-[10px] font-black uppercase tracking-widest"
        />
        <button
          type="button"
          onClick={submitCredit}
          disabled={!partyId || !Number.isFinite(Number(amountUsd)) || Number(amountUsd) <= 0}
          className="h-10 rounded-xl border border-blue-300 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 text-[10px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Add Credit
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4 space-y-2">
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Open Credits</p>
          {openEntries.length === 0 ? (
            <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">No open credits.</p>
          ) : (
            openEntries.slice(0, 8).map(entry => (
              <div key={entry.id} className="flex items-center justify-between border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 bg-white dark:bg-brand-900">
                <div>
                  <p className="text-[9px] font-black uppercase tracking-widest text-brand-900 dark:text-slate-100">{entry.partyName}</p>
                  <p className="text-[8px] font-bold uppercase tracking-widest text-slate-400">{entry.partyType} · {entry.cycle} · {entry.dueDate || 'No due date'}</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] font-black text-blue-700 dark:text-blue-300">${entry.amountUsd.toFixed(2)}</p>
                  <button type="button" onClick={() => onSettleCreditEntry(entry.id)} className="text-[8px] font-black uppercase tracking-widest text-emerald-600">Settle + Receipt</button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 p-4 space-y-2">
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Recent Receipts</p>
          {recentReceipts.length === 0 ? (
            <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">No receipts yet.</p>
          ) : (
            recentReceipts.map(receipt => (
              <div key={receipt.id} className="border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 bg-white dark:bg-brand-900">
                <p className="text-[9px] font-black uppercase tracking-widest text-brand-900 dark:text-slate-100">{receipt.partyName}</p>
                <p className="text-[8px] font-black uppercase tracking-widest text-indigo-700 dark:text-indigo-300">#{receipt.receiptNumber}</p>
                <p className="text-[8px] font-bold uppercase tracking-widest text-slate-400">{receipt.partyType} · {receipt.cycle} · {format(parseISO(receipt.issuedAt), 'MMM d, h:mm a')}</p>
                <p className="text-[10px] font-black text-emerald-600">${receipt.amountUsd.toFixed(2)}</p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

const FinanceOverviewView: React.FC<{
  totals: FinanceTotals;
  rows: FinanceDriverProfile[];
  windowLabel: string;
  creditLedger: CreditLedgerEntry[];
  receipts: ReceiptRecord[];
  customers: Customer[];
  drivers: Driver[];
  onCreateCreditEntry: (payload: {
    partyType: CreditPartyType;
    partyName: string;
    cycle: CreditCycle;
    amountUsd: number;
    partyId?: string;
    dueDate?: string;
    notes?: string;
  }) => void;
  onSettleCreditEntry: (entryId: string) => void;
}> = ({ totals, rows, windowLabel, creditLedger, receipts, customers, drivers, onCreateCreditEntry, onSettleCreditEntry }) => (
  <div className="space-y-8 md:space-y-12 animate-in fade-in duration-700">
    <div className="border-b border-slate-200 dark:border-white/10 pb-6">
      <h2 className="text-3xl md:text-5xl font-black tracking-tighter uppercase text-brand-900 dark:text-white">Yield Command</h2>
      <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400 mt-2">{windowLabel} Net Alpha Overview</p>
    </div>

    <div className="grid grid-cols-2 md:grid-cols-5 gap-4 md:gap-6">
      {[
        { label: 'Gross Revenue', value: `$${totals.grossRevenue.toFixed(0)}`, tone: 'text-brand-900 dark:text-emerald-500', icon: DollarSign },
        { label: 'Company Owed', value: `$${totals.companyOwed.toFixed(0)}`, tone: 'text-blue-600 dark:text-blue-300', icon: Briefcase },
        { label: 'Net Alpha', value: `$${totals.netAlpha.toFixed(0)}`, tone: totals.netAlpha >= 0 ? 'text-emerald-600' : 'text-red-500', icon: TrendingUp },
        { label: 'Burn Ratio', value: `${(totals.burnRatio * 100).toFixed(1)}%`, tone: 'text-gold-600', icon: PieChart },
        { label: 'Avg Fare', value: `$${totals.avgFare.toFixed(1)}`, tone: 'text-blue-600', icon: BarChart3 },
      ].map((card, idx) => (
        <div key={idx} className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 p-5 md:p-6 rounded-3xl shadow-sm">
          <div className="p-2.5 bg-slate-50 dark:bg-black rounded-xl w-fit mb-4 text-slate-400"><card.icon size={16} /></div>
          <p className="text-[9px] font-black text-slate-400 dark:text-slate-600 uppercase tracking-widest mb-1">{card.label}</p>
          <p className={`text-2xl font-black tracking-tighter ${card.tone}`}>{card.value}</p>
        </div>
      ))}
    </div>

    <div className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 rounded-[2rem] p-6 md:p-8">
      <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400 mb-4">Top Net Alpha Units</h4>
      <div className="space-y-3">
        {rows.slice(0, 5).map(row => {
          const safeBurnRatio = Number.isFinite(row.burnRatio) ? row.burnRatio : 0;
          return (
          <div key={row.id} className="flex items-center justify-between bg-slate-50 dark:bg-brand-950 rounded-xl px-4 py-3 border border-slate-200 dark:border-white/10">
            <div>
              <p className="text-sm font-black uppercase tracking-tight text-brand-900 dark:text-white">{row.name}</p>
              <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">{row.plateNumber} · Attr Unit · {row.completedTrips} Trips</p>
              <p className="text-[9px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300 mt-1">Company share {(row.companyShareRate * 100).toFixed(1)}%</p>
              <p className="text-[8px] font-black uppercase tracking-widest text-indigo-700 dark:text-indigo-300 mt-1">{row.shareRuleLabel}</p>
            </div>
            <div className="text-right">
              <p className={`text-sm font-black ${row.netAlpha >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>${row.netAlpha.toFixed(0)}</p>
              <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">Net</p>
              <p className="text-[9px] font-bold uppercase tracking-widest text-blue-700 dark:text-blue-300">Owed ${row.companyOwed.toFixed(0)}</p>
              <p className="text-[9px] font-bold uppercase tracking-widest text-gold-600 dark:text-gold-400">BR {(safeBurnRatio * 100).toFixed(1)}%</p>
            </div>
          </div>
        )})}
      </div>
    </div>

    <FinanceCreditPanel
      entries={creditLedger}
      receipts={receipts}
      customers={customers}
      drivers={drivers}
      onCreateCreditEntry={onCreateCreditEntry}
      onSettleCreditEntry={onSettleCreditEntry}
    />
  </div>
);

const FinancePerformanceView: React.FC<{
  row: FinanceDriverProfile;
  totals: FinanceTotals;
  windowLabel: string;
  creditLedger: CreditLedgerEntry[];
  receipts: ReceiptRecord[];
  customers: Customer[];
  drivers: Driver[];
  onCreateCreditEntry: (payload: {
    partyType: CreditPartyType;
    partyName: string;
    cycle: CreditCycle;
    amountUsd: number;
    partyId?: string;
    dueDate?: string;
    notes?: string;
  }) => void;
  onSettleCreditEntry: (entryId: string) => void;
}> = ({ row, totals, windowLabel, creditLedger, receipts, customers, drivers, onCreateCreditEntry, onSettleCreditEntry }) => (
  <div className="space-y-8 md:space-y-12 animate-in fade-in duration-700">
    <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-slate-200 dark:border-white/10 pb-6 gap-4">
      <div>
        <h2 className="text-3xl md:text-5xl font-black tracking-tighter uppercase text-brand-900 dark:text-white">{row.name}</h2>
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400 mt-2">{row.plateNumber}</p>
      </div>
      <div className="md:text-right">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Portfolio Share</p>
        <p className="text-2xl font-black text-brand-900 dark:text-emerald-500">{totals.grossRevenue > 0 ? ((row.grossRevenue / totals.grossRevenue) * 100).toFixed(1) : '0.0'}%</p>
        <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 mt-2">Window: {windowLabel}</p>
      </div>
    </div>

    <div className="grid grid-cols-2 md:grid-cols-5 gap-4 md:gap-6">
      {[
        { label: 'Net Alpha', value: `$${row.netAlpha.toFixed(0)}`, tone: row.netAlpha >= 0 ? 'text-emerald-600' : 'text-red-500', icon: row.netAlpha >= 0 ? ArrowUpRight : ArrowDownRight },
        { label: 'Gross Revenue', value: `$${row.grossRevenue.toFixed(0)}`, tone: 'text-brand-900 dark:text-emerald-500', icon: DollarSign },
        { label: 'Company Owed', value: `$${row.companyOwed.toFixed(0)}`, tone: 'text-blue-600 dark:text-blue-300', icon: Briefcase },
        { label: 'Share Rate', value: `${(row.companyShareRate * 100).toFixed(1)}%`, tone: 'text-cyan-600 dark:text-cyan-300', icon: ShieldQuestion },
        { label: 'Avg Fare', value: `$${row.avgFare.toFixed(1)}`, tone: 'text-blue-600', icon: BarChart3 },
        { label: 'Burn Ratio', value: `${(row.burnRatio * 100).toFixed(1)}%`, tone: 'text-gold-600', icon: Zap },
      ].map((box, idx) => (
        <div key={idx} className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 p-5 md:p-6 rounded-3xl shadow-sm">
          <div className="p-2.5 bg-slate-50 dark:bg-black rounded-xl w-fit mb-4 text-slate-400"><box.icon size={16} /></div>
          <p className="text-[9px] font-black text-slate-400 dark:text-slate-600 uppercase tracking-widest mb-1">{box.label}</p>
          <p className={`text-2xl font-black tracking-tighter ${box.tone}`}>{box.value}</p>
        </div>
      ))}
    </div>

    <div className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 rounded-[2rem] p-6 md:p-8">
      <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400 mb-4">Unit Output</h4>
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-slate-50 dark:bg-brand-950 rounded-xl p-4 border border-slate-200 dark:border-white/10">
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Completed Trips</p>
          <p className="text-2xl font-black text-brand-900 dark:text-white mt-1">{row.completedTrips}</p>
        </div>
        <div className="bg-slate-50 dark:bg-brand-950 rounded-xl p-4 border border-slate-200 dark:border-white/10">
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Distance</p>
          <p className="text-2xl font-black text-brand-900 dark:text-white mt-1">{row.totalDistance.toFixed(0)} KM</p>
        </div>
      </div>
    </div>

    <FinanceCreditPanel
      entries={creditLedger}
      receipts={receipts}
      customers={customers}
      drivers={drivers}
      onCreateCreditEntry={onCreateCreditEntry}
      onSettleCreditEntry={onSettleCreditEntry}
      filterDriverId={row.id}
    />
  </div>
);

const VaultConsoleView: React.FC<{
  selectedActionId: string | null;
  counts: { trips: number; drivers: number; customers: number; alerts: number };
  statusMessage: string;
  syncStatus: 'IDLE' | 'CHECKING' | 'VERIFIED' | 'NOT_VERIFIED';
  syncDetail: string;
  syncChannel: string;
  clearArmed: boolean;
  busyAction: 'EXPORT' | 'IMPORT' | 'CLEAR' | null;
  pendingImport: PendingVaultImport | null;
  onExport: () => void;
  onImport: () => void;
  onConfirmImport: () => void;
  onCancelImport: () => void;
  onClear: () => void;
  onCancelClear: () => void;
  onCopySyncChannel: () => void;
}> = ({ selectedActionId, counts, statusMessage, syncStatus, syncDetail, syncChannel, clearArmed, busyAction, pendingImport, onExport, onImport, onConfirmImport, onCancelImport, onClear, onCancelClear, onCopySyncChannel }) => {
  const actionLabels: Record<string, string> = {
    STATUS: 'System Status',
    EXPORT: 'Export Backup',
    IMPORT: 'Import Backup',
    CLEAR: 'Hard Reset Sync',
  };
  const selectedLabel = selectedActionId ? `Selected: ${actionLabels[selectedActionId] || selectedActionId}` : 'Select a vault module from feed';
  const canClear = busyAction === null;
  const showExport = !selectedActionId || selectedActionId === 'EXPORT';
  const showImport = !selectedActionId || selectedActionId === 'IMPORT';
  const showClear = !selectedActionId || selectedActionId === 'CLEAR';
  const isStatusFocus = selectedActionId === 'STATUS';
  const syncBadge =
    syncStatus === 'VERIFIED'
      ? {
          label: 'Vault Sync: Verified',
          tone: 'border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-emerald-700',
        }
      : syncStatus === 'CHECKING'
        ? {
            label: 'Vault Sync: Checking',
            tone: 'border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 text-blue-700',
          }
        : syncStatus === 'NOT_VERIFIED'
          ? {
              label: 'Vault Sync: Not Verified',
              tone: 'border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 text-amber-700',
            }
          : {
              label: 'Vault Sync: Idle',
              tone: 'border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 text-slate-500 dark:text-slate-300',
            };

  return (
    <div className="space-y-8 md:space-y-12 animate-in fade-in duration-700">
      <div className="border-b border-slate-200 dark:border-white/10 pb-6">
        <h2 className="text-3xl md:text-5xl font-black tracking-tighter uppercase text-brand-900 dark:text-white">Vault Core</h2>
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400 mt-2">{selectedLabel}</p>
        <div className={`mt-3 inline-flex items-center rounded-xl border px-3 py-1.5 text-[9px] font-black uppercase tracking-widest ${syncBadge.tone}`}>
          {syncBadge.label}
        </div>
        {syncDetail ? (
          <p className="mt-2 text-[9px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-300">{syncDetail}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="text-[9px] font-black uppercase tracking-wide text-slate-500 dark:text-slate-300">Channel: {syncChannel}</p>
          <button
            type="button"
            onClick={onCopySyncChannel}
            className="h-7 px-2 rounded-lg border border-slate-300 dark:border-white/20 bg-white dark:bg-brand-950 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300"
          >
            Copy Channel
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 md:gap-6">
        {[
          { label: 'Trips', value: counts.trips, icon: FileText },
          { label: 'Deleted', value: counts.deletedTrips, icon: Archive },
          { label: 'Drivers', value: counts.drivers, icon: Car },
          { label: 'Customers', value: counts.customers, icon: Users },
          { label: 'Alerts', value: counts.alerts, icon: ShieldQuestion },
        ].map((box, idx) => (
          <div key={idx} className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 p-5 md:p-6 rounded-3xl shadow-sm">
            <div className="p-2.5 bg-slate-50 dark:bg-black rounded-xl w-fit mb-4 text-slate-400"><box.icon size={16} /></div>
            <p className="text-[9px] font-black text-slate-400 dark:text-slate-600 uppercase tracking-widest mb-1">{box.label}</p>
            <p className="text-2xl font-black tracking-tighter text-brand-900 dark:text-white">{box.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-white dark:bg-brand-900 border border-slate-200 dark:border-white/10 rounded-[2rem] p-6 md:p-8 space-y-6">
        {isStatusFocus ? (
          <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-4 py-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">Vault status selected. Use left feed to choose Export, Import, or Hard Reset actions.</p>
          </div>
        ) : (
          <>
            <div className={`grid gap-3 ${showExport && showImport && showClear ? 'grid-cols-1 md:grid-cols-3' : 'grid-cols-1'}`}>
              {showExport && (
                <button onClick={onExport} disabled={busyAction !== null} className="h-12 rounded-xl border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[10px] font-black uppercase tracking-widest text-emerald-700 hover:bg-emerald-100 dark:hover:bg-emerald-900/20 disabled:opacity-50">{busyAction === 'EXPORT' ? 'Exporting...' : 'Export Backup'}</button>
              )}
              {showImport && (
                <button onClick={onImport} disabled={busyAction !== null} className="h-12 rounded-xl border border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 text-[10px] font-black uppercase tracking-widest text-blue-700 hover:bg-blue-100 dark:hover:bg-blue-900/20 disabled:opacity-50">{busyAction === 'IMPORT' ? 'Importing...' : 'Import Backup'}</button>
              )}
              {showClear && (
                <button onClick={onClear} disabled={!canClear} className="h-12 rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 text-[10px] font-black uppercase tracking-widest text-red-600 hover:bg-red-100 dark:hover:bg-red-900/20 disabled:opacity-50">{busyAction === 'CLEAR' ? 'Resetting...' : clearArmed ? 'Confirm Hard Reset' : 'Hard Reset Sync'}</button>
              )}
            </div>

            {showImport && pendingImport && (
              <div className="border border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 rounded-xl p-4 space-y-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-blue-700">Pending Import</p>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-300">{pendingImport.fileName}</p>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-300">
                  V{pendingImport.inspection.version || 'Unknown'} · {pendingImport.inspection.counts.trips} trips · {pendingImport.inspection.counts.deletedTrips} deleted · {pendingImport.inspection.counts.drivers} drivers · {pendingImport.inspection.counts.customers} customers · {pendingImport.inspection.counts.alerts} alerts{pendingImport.inspection.hasSettings ? ' · settings' : ''}
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <button onClick={onConfirmImport} disabled={busyAction !== null} className="h-11 rounded-xl border border-blue-300 dark:border-blue-900/50 bg-white dark:bg-brand-950 text-[10px] font-black uppercase tracking-widest text-blue-700 disabled:opacity-50">{busyAction === 'IMPORT' ? 'Applying...' : 'Confirm Import'}</button>
                  <button onClick={onCancelImport} disabled={busyAction !== null} className="h-11 rounded-xl border border-slate-300 dark:border-white/20 bg-white dark:bg-brand-950 text-[10px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 disabled:opacity-50">Cancel</button>
                </div>
              </div>
            )}

            {showImport && !pendingImport && (
              <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-4 py-3 space-y-2">
                <div className="flex items-start gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-300">
                  <Database size={12} className="mt-0.5 text-blue-600" />
                  <p>Vault import accepts Control backup JSON only.</p>
                </div>
                <div className="flex items-start gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-300">
                  <ShieldAlert size={12} className="mt-0.5 text-amber-500" />
                  <p>It applies trips, drivers, alerts, and settings; customers are merged safely by phone.</p>
                </div>
              </div>
            )}

            {showClear && (
              <div className="border-t border-slate-100 dark:border-white/10 pt-5">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">
                  {clearArmed
                    ? 'Clear is armed. Click Confirm Clear Ops Data to proceed, or cancel below.'
                    : 'Click Clear Ops Data once to arm confirmation.'}
                </p>
                {clearArmed && (
                  <button
                    type="button"
                    onClick={onCancelClear}
                    className="mt-3 h-10 px-4 rounded-xl border border-slate-300 dark:border-white/20 bg-white dark:bg-brand-950 text-[10px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300"
                  >
                    Cancel Clear
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {statusMessage && (
          <div role="status" aria-live="polite" className="rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">{statusMessage}</p>
          </div>
        )}
      </div>
    </div>
  );
};
