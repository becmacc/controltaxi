
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useStore } from '../context/StoreContext';
import { Trip, TripStatus, Driver, Customer, CustomerLocation, TripStop, TripPaymentMode, TripSettlementStatus } from '../types';
import { useLocation } from 'react-router-dom';
import { format, isToday, isFuture, isPast, parseISO } from 'date-fns';
import { 
  Search, Phone, User, UserCheck, Star, MapPin, Navigation, Clock, X, Check,
  FileText, CheckCircle2, XCircle, Car, Calendar,
  Download, AlertTriangle, DollarSign, List as ListIcon, 
  MessageCircle, Send, Settings, MailCheck, HeartHandshake,
  LayoutGrid, MoreVertical, ExternalLink, ArrowRightLeft, UserX, ClipboardX, Trash2, Archive, ChevronDown, ChevronUp, Maximize2, Minimize2
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { HorizontalScrollArea } from '../components/ui/HorizontalScrollArea';
import { MessageModal } from '../components/MessageModal';
import { CustomerSnapshotCard } from '../components/CustomerSnapshotCard';
import { UnitSnapshotCard } from '../components/UnitSnapshotCard';
import { MIN_RIDE_FARE_USD } from '../constants';
import { formatTripDestination, formatTripPickup, formatTripStops, replacePlaceholders } from '../services/placeholderService';
import { buildWhatsAppLink, sanitizeCommunicationText } from '../services/whatsapp';
import { buildCustomerSnapshotForTrip, CustomerSnapshot } from '../services/customerSnapshot';
import { customerPhoneKey } from '../services/customerProfile';
import { parseGoogleMapsLink, parseGpsOrLatLngInput } from '../services/locationParser';
import { loadGoogleMapsScript } from '../services/googleMapsLoader';
import { computeTrafficIndex } from '../services/trafficMetrics';
import { buildUnitSnapshotMetrics } from '../services/unitSnapshot';

declare var google: any;

type ViewMode = 'TABLE' | 'CARD';
type TripModalFocusTarget = 'DEFAULT' | 'REQUOTE';
const OPERATOR_INDEX_MARKERS = ['NEW', 'CORP', 'AIRPORT', 'PRIORITY', 'FOLLOWUP', 'VIP', 'VVIP'] as const;

const extractIndexMarkers = (text?: string): string[] => {
  if (!text) return [];
  const matches = text.toUpperCase().match(/\[(NEW|CORP|AIRPORT|PRIORITY|FOLLOWUP|VIP|VVIP)\]/g) || [];
  return Array.from(new Set(matches.map(match => match.replace(/\[|\]/g, ''))));
};

const normalizeExternalUrl = (value?: string): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    return parsed.href;
  } catch {
    return '';
  }
};

const isPositiveFeedbackRating = (rating?: number): boolean => {
  return typeof rating === 'number' && Number.isFinite(rating) && rating >= 4;
};

export const TripsPage: React.FC = () => {
  const { trips, deletedTrips, drivers, customers, creditLedger, receipts, updateFullTrip, deleteCancelledTrip, restoreDeletedTrip, settings, addCustomers } = useStore();
  const location = useLocation();
  const [filterText, setFilterText] = useState('');
  const [timeFilter, setTimeFilter] = useState<'ALL' | 'TODAY' | 'UPCOMING' | 'PAST'>('ALL');
  const [viewMode, setViewMode] = useState<ViewMode>('TABLE');
  const [paymentModeFilters, setPaymentModeFilters] = useState<TripPaymentMode[]>(['CASH', 'CREDIT']);
  const [settlementFilters, setSettlementFilters] = useState<TripSettlementStatus[]>(['PENDING', 'SETTLED', 'RECEIPTED']);
  const [statusFilters, setStatusFilters] = useState<TripStatus[]>([
    TripStatus.QUOTED,
    TripStatus.CONFIRMED,
    TripStatus.COMPLETED,
    TripStatus.CANCELLED,
  ]);
  
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null);
  const [snapshotPreviewTrip, setSnapshotPreviewTrip] = useState<Trip | null>(null);
  const [unitSnapshotDriverId, setUnitSnapshotDriverId] = useState<string | null>(null);
  const [modalFocusTarget, setModalFocusTarget] = useState<TripModalFocusTarget>('DEFAULT');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [copiedType, setCopiedType] = useState<string | null>(null);
  const [messagingContext, setMessagingContext] = useState<{ trip: Trip, type: 'FEEDBACK_REQ' | 'THANKS' } | null>(null);
  const [manifestState, setManifestState] = useState<'IDLE' | 'DONE' | 'ERROR'>('IDLE');
  const [manifestMessage, setManifestMessage] = useState('');
  const [whatsAppError, setWhatsAppError] = useState<string | null>(null);
  const [actionToast, setActionToast] = useState<{ tone: 'SUCCESS' | 'ERROR'; message: string } | null>(null);
  const [completedTripsCollapsed, setCompletedTripsCollapsed] = useState(true);
  const [deletedTripsCollapsed, setDeletedTripsCollapsed] = useState(true);
  const [handledDeepLinkKey, setHandledDeepLinkKey] = useState<string>('');
  const [isTableFullView, setIsTableFullView] = useState(false);
  const [inlineAssignTripId, setInlineAssignTripId] = useState<number | null>(null);
  const [inlineAssignQuery, setInlineAssignQuery] = useState('');
  const [showInlineAssignSuggestions, setShowInlineAssignSuggestions] = useState(false);
  const [inlineAssignHighlightedIndex, setInlineAssignHighlightedIndex] = useState(0);
  const [inlineScheduleTripId, setInlineScheduleTripId] = useState<number | null>(null);
  const [inlineScheduleDraft, setInlineScheduleDraft] = useState('');

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target.closest('[contenteditable="true"]'));
    };

    const handleTableHotkeys = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;

      if (event.key === 'Escape') {
        setIsTableFullView(false);
        return;
      }

      if (event.key.toLowerCase() === 'f' && !event.metaKey && !event.ctrlKey && !event.altKey && viewMode === 'TABLE') {
        event.preventDefault();
        setIsTableFullView(prev => !prev);
      }
    };

    window.addEventListener('keydown', handleTableHotkeys);
    return () => window.removeEventListener('keydown', handleTableHotkeys);
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== 'TABLE') {
      setIsTableFullView(false);
    }
  }, [viewMode]);

  useEffect(() => {
    if (isTableFullView) {
      document.body.classList.add('missionlog-table-fullview');
    } else {
      document.body.classList.remove('missionlog-table-fullview');
    }

    return () => {
      document.body.classList.remove('missionlog-table-fullview');
    };
  }, [isTableFullView]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const rawId = params.get('id');
    if (!rawId) return;

    const tripId = Number(rawId);
    if (!Number.isFinite(tripId)) return;

    const deepLinkKey = `id:${tripId}`;
    if (handledDeepLinkKey === deepLinkKey) return;

    const match = trips.find(trip => trip.id === tripId);
    if (!match) return;

    setHandledDeepLinkKey(deepLinkKey);
    setFilterText('');
    setTimeFilter('ALL');
    setSelectedTrip(match);
    setIsModalOpen(true);
  }, [location.search, trips, handledDeepLinkKey]);

  const pulseStats = useMemo(() => {
    const todayTrips = trips.filter(t => isToday(parseISO(t.tripDate || t.createdAt)));
    const pendingAssignment = trips.filter(t => t.status === TripStatus.CONFIRMED && !t.driverId).length;
    const completed = todayTrips.filter(t => t.status === TripStatus.COMPLETED).length;
    const totalTodayRevenue = todayTrips.filter(t => t.status !== TripStatus.CANCELLED).reduce((acc, t) => acc + t.fareUsd, 0);
    const successRate = todayTrips.length > 0 ? Math.round((completed / Math.max(1, (todayTrips.length - todayTrips.filter(t => t.status === TripStatus.QUOTED).length))) * 100) || 0 : 100;
    return { todayCount: todayTrips.length, pendingAssignment, successRate, projectedRevenue: totalTodayRevenue };
  }, [trips]);

  const customerSearchIndex = useMemo(() => {
    const index = new Map<string, string>();

    customers.forEach(customer => {
      const key = customerPhoneKey(customer.phone);
      if (!key) return;

      const marketSegments = Array.isArray(customer.marketSegments) ? customer.marketSegments.join(' ') : '';
      const frequentLocations = Array.isArray(customer.frequentLocations)
        ? customer.frequentLocations
            .flatMap(location => [location.label || '', location.address || '', location.mapsLink || ''])
            .join(' ')
        : '';

      const blob = [
        customer.name,
        customer.phone,
        customer.notes || '',
        customer.profession || '',
        customer.entityType || '',
        customer.gender || '',
        marketSegments,
        customer.homeLocation?.label || '',
        customer.homeLocation?.address || '',
        customer.homeLocation?.mapsLink || '',
        customer.businessLocation?.label || '',
        customer.businessLocation?.address || '',
        customer.businessLocation?.mapsLink || '',
        frequentLocations,
      ]
        .join(' ')
        .toLowerCase();

      index.set(key, blob);
    });

    return index;
  }, [customers]);

  const ALL_PAYMENT_FILTERS: TripPaymentMode[] = ['CASH', 'CREDIT'];
  const ALL_SETTLEMENT_FILTERS: TripSettlementStatus[] = ['PENDING', 'SETTLED', 'RECEIPTED'];
  const ALL_STATUS_FILTERS: TripStatus[] = [TripStatus.QUOTED, TripStatus.CONFIRMED, TripStatus.COMPLETED, TripStatus.CANCELLED];

  const baseFilteredTrips = useMemo(() => {
    const lower = filterText.toLowerCase();
    return trips.filter(trip => {
      const linkedCustomerBlob = customerSearchIndex.get(customerPhoneKey(trip.customerPhone));
      const matchesText = trip.customerName.toLowerCase().includes(lower) || 
                          trip.customerPhone.includes(filterText) || 
                          trip.pickupText.toLowerCase().includes(lower) || 
                          trip.destinationText.toLowerCase().includes(lower) ||
                          trip.notes.toLowerCase().includes(lower) ||
                          (trip.driverId && drivers.find(d => d.id === trip.driverId)?.name.toLowerCase().includes(lower)) ||
                          Boolean(linkedCustomerBlob && linkedCustomerBlob.includes(lower));

      const tripDate = trip.tripDate ? parseISO(trip.tripDate) : parseISO(trip.createdAt);
      let matchesTime = true;
      if (timeFilter === 'TODAY') matchesTime = isToday(tripDate);
      else if (timeFilter === 'UPCOMING') matchesTime = isFuture(tripDate) && !isToday(tripDate);
      else if (timeFilter === 'PAST') matchesTime = isPast(tripDate) && !isToday(tripDate);

      return matchesText && matchesTime;
    }).sort((a, b) => {
      const dateA = a.tripDate ? new Date(a.tripDate).getTime() : new Date(a.createdAt).getTime();
      const dateB = b.tripDate ? new Date(b.tripDate).getTime() : new Date(b.createdAt).getTime();
      return dateB - dateA;
    });
  }, [trips, drivers, filterText, timeFilter, customerSearchIndex]);

  const baseFilteredDeletedTrips = useMemo(() => {
    const lower = filterText.toLowerCase();
    return deletedTrips.filter(record => {
      const trip = record.trip;
      const driverName = trip.driverId ? (drivers.find(d => d.id === trip.driverId)?.name || '') : '';
      const linkedCustomerBlob = customerSearchIndex.get(customerPhoneKey(trip.customerPhone));
      const matchesText = trip.customerName.toLowerCase().includes(lower) ||
        trip.customerPhone.includes(filterText) ||
        trip.pickupText.toLowerCase().includes(lower) ||
        trip.destinationText.toLowerCase().includes(lower) ||
        trip.notes.toLowerCase().includes(lower) ||
        record.deletedReason.toLowerCase().includes(lower) ||
        driverName.toLowerCase().includes(lower) ||
        Boolean(linkedCustomerBlob && linkedCustomerBlob.includes(lower));

      const deletedDate = parseISO(record.deletedAt || trip.createdAt);
      let matchesTime = true;
      if (timeFilter === 'TODAY') matchesTime = isToday(deletedDate);
      else if (timeFilter === 'UPCOMING') matchesTime = false;
      else if (timeFilter === 'PAST') matchesTime = isPast(deletedDate) && !isToday(deletedDate);

      return matchesText && matchesTime;
    }).sort((a, b) => {
      const dateA = new Date(a.deletedAt).getTime();
      const dateB = new Date(b.deletedAt).getTime();
      return dateB - dateA;
    });
  }, [deletedTrips, drivers, filterText, timeFilter, customerSearchIndex]);

  const filteredTrips = useMemo(() => {
    return baseFilteredTrips.filter(trip => {
      const normalizedPaymentMode: TripPaymentMode = trip.paymentMode === 'CREDIT' ? 'CREDIT' : 'CASH';
      const normalizedSettlementStatus: TripSettlementStatus = trip.settlementStatus || 'PENDING';
      return paymentModeFilters.includes(normalizedPaymentMode)
        && settlementFilters.includes(normalizedSettlementStatus)
        && statusFilters.includes(trip.status);
    });
  }, [baseFilteredTrips, paymentModeFilters, settlementFilters, statusFilters]);

  const filteredDeletedTrips = useMemo(() => {
    return baseFilteredDeletedTrips.filter(record => {
      const trip = record.trip;
      const normalizedPaymentMode: TripPaymentMode = trip.paymentMode === 'CREDIT' ? 'CREDIT' : 'CASH';
      const normalizedSettlementStatus: TripSettlementStatus = trip.settlementStatus || 'PENDING';
      return paymentModeFilters.includes(normalizedPaymentMode)
        && settlementFilters.includes(normalizedSettlementStatus)
        && statusFilters.includes(trip.status);
    });
  }, [baseFilteredDeletedTrips, paymentModeFilters, settlementFilters, statusFilters]);

  const filterOptionCounts = useMemo(() => {
    const pool = [
      ...baseFilteredTrips,
      ...baseFilteredDeletedTrips.map(record => record.trip),
    ];

    return pool.reduce(
      (acc, trip) => {
        const mode: TripPaymentMode = trip.paymentMode === 'CREDIT' ? 'CREDIT' : 'CASH';
        const settlement: TripSettlementStatus = trip.settlementStatus || 'PENDING';

        acc.payment[mode] += 1;
        acc.settlement[settlement] += 1;
        acc.status[trip.status] += 1;
        return acc;
      },
      {
        payment: { CASH: 0, CREDIT: 0 },
        settlement: { PENDING: 0, SETTLED: 0, RECEIPTED: 0 },
        status: {
          [TripStatus.QUOTED]: 0,
          [TripStatus.CONFIRMED]: 0,
          [TripStatus.COMPLETED]: 0,
          [TripStatus.CANCELLED]: 0,
        },
      } as {
        payment: Record<TripPaymentMode, number>;
        settlement: Record<TripSettlementStatus, number>;
        status: Record<TripStatus, number>;
      }
    );
  }, [baseFilteredTrips, baseFilteredDeletedTrips]);

  const togglePaymentModeFilter = (mode: TripPaymentMode) => {
    setPaymentModeFilters(prev => {
      const exists = prev.includes(mode);
      if (exists) {
        const next = prev.filter(entry => entry !== mode);
        return next.length > 0 ? next : ['CASH', 'CREDIT'];
      }
      return [...prev, mode];
    });
  };

  const toggleSettlementFilter = (status: TripSettlementStatus) => {
    setSettlementFilters(prev => {
      const exists = prev.includes(status);
      if (exists) {
        const next = prev.filter(entry => entry !== status);
        return next.length > 0 ? next : ['PENDING', 'SETTLED', 'RECEIPTED'];
      }
      return [...prev, status];
    });
  };

  const toggleStatusFilter = (status: TripStatus) => {
    setStatusFilters(prev => {
      const exists = prev.includes(status);
      if (exists) {
        const next = prev.filter(entry => entry !== status);
        return next.length > 0 ? next : ALL_STATUS_FILTERS;
      }
      return [...prev, status];
    });
  };

  const hasActiveFilters =
    filterText.trim().length > 0 ||
    timeFilter !== 'ALL' ||
    paymentModeFilters.length !== ALL_PAYMENT_FILTERS.length ||
    settlementFilters.length !== ALL_SETTLEMENT_FILTERS.length ||
    statusFilters.length !== ALL_STATUS_FILTERS.length;

  const clearAllFilters = () => {
    setFilterText('');
    setTimeFilter('ALL');
    setPaymentModeFilters(ALL_PAYMENT_FILTERS);
    setSettlementFilters(ALL_SETTLEMENT_FILTERS);
    setStatusFilters(ALL_STATUS_FILTERS);
  };

  const activeTrips = useMemo(
    () => filteredTrips.filter(trip => trip.status !== TripStatus.COMPLETED),
    [filteredTrips]
  );

  const completedTrips = useMemo(() => {
    return filteredTrips
      .filter(trip => trip.status === TripStatus.COMPLETED)
      .sort((a, b) => {
        const aStamp = a.completedAt || a.tripDate || a.createdAt;
        const bStamp = b.completedAt || b.tripDate || b.createdAt;
        return new Date(bStamp).getTime() - new Date(aStamp).getTime();
      });
  }, [filteredTrips]);

  const activeDrivers = useMemo(
    () => drivers.filter(d => d.status === 'ACTIVE'),
    [drivers]
  );

  const inlineAssignSuggestions = useMemo(() => {
    const query = inlineAssignQuery.trim().toLowerCase();
    if (!query) return activeDrivers.slice(0, 8);

    return activeDrivers
      .filter(driver => `${driver.name} ${driver.plateNumber} ${driver.carModel}`.toLowerCase().includes(query))
      .slice(0, 8);
  }, [activeDrivers, inlineAssignQuery]);

  useEffect(() => {
    setInlineAssignHighlightedIndex(0);
  }, [inlineAssignSuggestions]);

  const selectedTripSnapshot = useMemo(() => {
    if (!selectedTrip) return null;
    return buildCustomerSnapshotForTrip(selectedTrip, customers, trips, drivers, creditLedger, receipts);
  }, [selectedTrip, customers, trips, drivers, creditLedger, receipts]);

  const snapshotPreviewData = useMemo(() => {
    if (!snapshotPreviewTrip) return null;
    return buildCustomerSnapshotForTrip(snapshotPreviewTrip, customers, trips, drivers, creditLedger, receipts);
  }, [snapshotPreviewTrip, customers, trips, drivers, creditLedger, receipts]);

  const unitSnapshotDriver = useMemo(
    () => (unitSnapshotDriverId ? drivers.find(driver => driver.id === unitSnapshotDriverId) || null : null),
    [unitSnapshotDriverId, drivers]
  );

  const unitSnapshotMetrics = useMemo(() => {
    if (!unitSnapshotDriver) return null;
    return buildUnitSnapshotMetrics(unitSnapshotDriver, trips);
  }, [unitSnapshotDriver, trips]);

  const getTripIndexMarkers = (trip: Trip): string[] => {
    const normalizedPhone = customerPhoneKey(trip.customerPhone);
    const directoryCustomer = normalizedPhone
      ? customers.find(entry => customerPhoneKey(entry.phone) === normalizedPhone)
      : null;

    const markerSet = new Set<string>([
      ...extractIndexMarkers(directoryCustomer?.notes),
      ...extractIndexMarkers(trip.notes),
    ]);

    return OPERATOR_INDEX_MARKERS.filter(marker => markerSet.has(marker));
  };

  const getTripStopPreview = (trip: Trip): string => {
    const stops = (trip.stops || []).map(stop => stop.text.trim()).filter(Boolean);
    if (stops.length === 0) return '';
    if (stops.length === 1) return stops[0].split(',')[0];
    const firstTwo = stops.slice(0, 2).map(stop => stop.split(',')[0]);
    const remaining = stops.length - firstTwo.length;
    return remaining > 0 ? `${firstTwo.join(' · ')} +${remaining}` : firstTwo.join(' · ');
  };

  const describeTraffic = (index?: number): { label: string; tone: string } => {
    const safe = Number.isFinite(index) ? Number(index) : 0;
    if (safe > 85) return { label: 'Gridlock', tone: 'text-red-600 dark:text-red-400' };
    if (safe > 60) return { label: 'Heavy', tone: 'text-orange-600 dark:text-orange-400' };
    if (safe > 35) return { label: 'Dense', tone: 'text-amber-600 dark:text-amber-400' };
    if (safe > 15) return { label: 'Normal', tone: 'text-blue-600 dark:text-blue-400' };
    return { label: 'Fluid', tone: 'text-emerald-600 dark:text-emerald-400' };
  };

  const getTripTrafficMetrics = (trip: Trip) => {
    const baselineMin = Number.isFinite(trip.durationMin) ? Math.max(0, Number(trip.durationMin)) : 0;
    const etaMinRaw = Number.isFinite(trip.durationInTrafficMin)
      ? Math.max(0, Number(trip.durationInTrafficMin))
      : baselineMin;
    const etaMin = etaMinRaw > 0 ? etaMinRaw : baselineMin;

    const derivedSurplus = Number.isFinite(trip.surplusMin)
      ? Math.max(0, Number(trip.surplusMin))
      : Math.max(0, etaMin - baselineMin);

    const trafficIndex = Number.isFinite(trip.trafficIndex)
      ? Math.round(Number(trip.trafficIndex))
      : Math.round(computeTrafficIndex(etaMin, baselineMin > 0 ? baselineMin : Math.max(1, etaMin || 1)));

    const etaText = (trip.durationInTrafficText || '').trim()
      || (Number.isFinite(etaMin) && etaMin > 0 ? `${Math.round(etaMin)} min` : (trip.durationText || 'N/A'));

    return {
      baselineMin,
      etaMin,
      etaText,
      trafficIndex,
      surplusMin: Math.round(derivedSurplus),
    };
  };

  const getTripPaymentMode = (trip: Trip): TripPaymentMode => (trip.paymentMode === 'CREDIT' ? 'CREDIT' : 'CASH');
  const isTripPaymentLocked = (trip: Trip): boolean => (trip.settlementStatus || 'PENDING') === 'RECEIPTED';

  const handleTripPaymentModeUpdate = (trip: Trip, nextMode?: TripPaymentMode) => {
    if (isTripPaymentLocked(trip)) {
      showActionToast(`Trip #${trip.id.toString().slice(-4)} is receipted. Payment mode is locked.`, 'ERROR');
      return;
    }

    const currentMode = getTripPaymentMode(trip);
    const targetMode = nextMode || (currentMode === 'CREDIT' ? 'CASH' : 'CREDIT');
    if (targetMode === currentMode) return;

    const updatedTrip: Trip = {
      ...trip,
      paymentMode: targetMode,
    };

    updateFullTrip(updatedTrip);

    if (selectedTrip?.id === trip.id) {
      setSelectedTrip(updatedTrip);
    }

    showActionToast(`Trip #${trip.id.toString().slice(-4)} payment set to ${targetMode}.`);
  };

  const handleApplyRequote = (updatedTrip: Trip) => {
    updateFullTrip(updatedTrip);
    setSelectedTrip(updatedTrip);
  };

  const messagingSnapshot = useMemo(() => {
    if (!messagingContext?.trip) return null;
    return buildCustomerSnapshotForTrip(messagingContext.trip, customers, trips, drivers, creditLedger, receipts);
  }, [messagingContext, customers, trips, drivers, creditLedger, receipts]);

  const reviewLink = useMemo(
    () => normalizeExternalUrl(settings.googleBusinessReviewUrl),
    [settings.googleBusinessReviewUrl]
  );

  const operationalServiceLinks = useMemo(() => {
    return [
      normalizeExternalUrl(settings.bookingFlowUrl) ? `Book: ${normalizeExternalUrl(settings.bookingFlowUrl)}` : '',
      normalizeExternalUrl(settings.fareEstimatorUrl) ? `Fare Estimator: ${normalizeExternalUrl(settings.fareEstimatorUrl)}` : '',
      normalizeExternalUrl(settings.customRequestUrl) ? `Custom Request: ${normalizeExternalUrl(settings.customRequestUrl)}` : '',
      normalizeExternalUrl(settings.promotionalOfferUrl) ? `Promo Offer: ${normalizeExternalUrl(settings.promotionalOfferUrl)}` : '',
      normalizeExternalUrl(settings.couponProgramUrl) ? `Coupon Program: ${normalizeExternalUrl(settings.couponProgramUrl)}` : '',
      normalizeExternalUrl(settings.loyaltyProgramUrl) ? `Loyalty Rewards: ${normalizeExternalUrl(settings.loyaltyProgramUrl)}` : '',
    ].filter(Boolean);
  }, [
    settings.bookingFlowUrl,
    settings.fareEstimatorUrl,
    settings.customRequestUrl,
    settings.promotionalOfferUrl,
    settings.couponProgramUrl,
    settings.loyaltyProgramUrl,
  ]);

  const operationalServiceLinksBlock = useMemo(() => {
    if (operationalServiceLinks.length === 0) return '';
    return `\n\nLinks:\n${operationalServiceLinks.join('\n')}`;
  }, [operationalServiceLinks]);

  const messagingInitialMessage = useMemo(() => {
    if (!messagingContext) return '';

    const baseTemplate = messagingContext.type === 'FEEDBACK_REQ'
      ? settings.templates.feedback_request
      : settings.templates.feedback_thanks;

    const baseMessage = replacePlaceholders(baseTemplate, messagingContext.trip, drivers, settings);
    const withExplicitPlaceholder = baseMessage.split('{google_review_link}').join(reviewLink);

    const shouldIncludeReviewLink =
      messagingContext.type === 'THANKS' &&
      isPositiveFeedbackRating(messagingContext.trip.rating) &&
      reviewLink.length > 0;

    if (!shouldIncludeReviewLink) {
      return withExplicitPlaceholder;
    }

    const hasReviewLinkAlready = withExplicitPlaceholder.toLowerCase().includes(reviewLink.toLowerCase());
    if (hasReviewLinkAlready) {
      return withExplicitPlaceholder;
    }

    return `${withExplicitPlaceholder}\n\nIf you enjoyed the ride, we'd really appreciate your Google review:\n${reviewLink}`;
  }, [messagingContext, settings.templates.feedback_request, settings.templates.feedback_thanks, drivers, reviewLink]);

  const statusConfig = {
    [TripStatus.QUOTED]: { icon: FileText, label: 'Quoted', className: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-brand-900/50 dark:text-slate-400 dark:border-brand-800' },
    [TripStatus.CONFIRMED]: { icon: Clock, label: 'Confirmed', className: 'bg-blue-50 text-blue-600 border-blue-100 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800/50' },
    [TripStatus.COMPLETED]: { icon: CheckCircle2, label: 'Success', className: 'bg-emerald-50 text-emerald-600 border-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800/50' },
    [TripStatus.CANCELLED]: { icon: XCircle, label: 'Cancelled', className: 'bg-red-50 text-red-600 border-red-100 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800/50' },
  };

  const copyToClipboard = (text: string, type: string, id: number) => {
    navigator.clipboard.writeText(sanitizeCommunicationText(text));
    setCopiedType(`${type}-${id}`);
    setTimeout(() => setCopiedType(null), 2000);
  };

  const openWhatsAppMessage = (phone: string | undefined, text: string) => {
    const link = buildWhatsAppLink(phone || '', sanitizeCommunicationText(text));
    if (!link) {
      setWhatsAppError('Valid WhatsApp phone is required for this communication.');
      setTimeout(() => setWhatsAppError(null), 2500);
      return;
    }
    window.open(link, '_blank', 'noopener,noreferrer');
  };

  const showActionToast = (message: string, tone: 'SUCCESS' | 'ERROR' = 'SUCCESS') => {
    setActionToast({ tone, message });
    window.setTimeout(() => setActionToast(null), 2200);
  };

  const parseDurationToMinutes = (duration?: string) => {
    const seconds = duration ? Number.parseFloat(duration.replace('s', '')) : 0;
    return Math.ceil((Number.isFinite(seconds) ? seconds : 0) / 60);
  };

  const geocodeAddress = async (address: string): Promise<{ placeId: string; formattedAddress: string; lat: number; lng: number } | null> => {
    const query = address.trim();
    if (!query) return null;

    const parseFirstResult = (payload: any) => {
      const first = payload?.results?.[0];
      const lat = Number(first?.geometry?.location?.lat);
      const lng = Number(first?.geometry?.location?.lng);
      if (!first || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return {
        placeId: String(first.place_id || 'GEOCODED_DESTINATION'),
        formattedAddress: String(first.formatted_address || query),
        lat,
        lng,
      };
    };

    const parsePlaceCandidate = (payload: any) => {
      const candidate = payload?.candidates?.[0];
      const lat = Number(candidate?.geometry?.location?.lat);
      const lng = Number(candidate?.geometry?.location?.lng);
      if (!candidate || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return {
        placeId: String(candidate.place_id || 'GEOCODED_DESTINATION'),
        formattedAddress: String(candidate.formatted_address || candidate.name || query),
        lat,
        lng,
      };
    };

    const restrictedEndpoint = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&components=country:LB&key=${encodeURIComponent(settings.googleMapsApiKey)}`;
    const restrictedResponse = await fetch(restrictedEndpoint);
    if (restrictedResponse.ok) {
      const restrictedPayload = await restrictedResponse.json();
      const restrictedResult = parseFirstResult(restrictedPayload);
      if (restrictedResult) return restrictedResult;
    }

    const placesEndpoint = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(query)}&inputtype=textquery&fields=place_id,name,formatted_address,geometry&locationbias=circle:30000@33.8938,35.5018&region=lb&language=en&key=${encodeURIComponent(settings.googleMapsApiKey)}`;
    const placesResponse = await fetch(placesEndpoint);
    if (placesResponse.ok) {
      const placesPayload = await placesResponse.json();
      const placesResult = parsePlaceCandidate(placesPayload);
      if (placesResult) return placesResult;
    }

    const fallbackEndpoint = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${encodeURIComponent(settings.googleMapsApiKey)}`;
    const fallbackResponse = await fetch(fallbackEndpoint);
    if (!fallbackResponse.ok) return null;
    const fallbackPayload = await fallbackResponse.json();
    return parseFirstResult(fallbackPayload);
  };

  const geocodePlaceId = async (placeId: string): Promise<{ formattedAddress: string; lat: number; lng: number } | null> => {
    const cleanedPlaceId = placeId.trim();
    if (!cleanedPlaceId) return null;

    const endpoint = `https://maps.googleapis.com/maps/api/geocode/json?place_id=${encodeURIComponent(cleanedPlaceId)}&key=${encodeURIComponent(settings.googleMapsApiKey)}`;
    const response = await fetch(endpoint);
    if (!response.ok) return null;

    const payload = await response.json();
    const first = payload?.results?.[0];
    const lat = Number(first?.geometry?.location?.lat);
    const lng = Number(first?.geometry?.location?.lng);
    if (!first || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return {
      formattedAddress: String(first.formatted_address || ''),
      lat,
      lng,
    };
  };

  const resolvePickupCoordinates = async (trip: Trip): Promise<{ lat: number; lng: number } | null> => {
    if (Number.isFinite(trip.pickupLat) && Number.isFinite(trip.pickupLng)) {
      return { lat: Number(trip.pickupLat), lng: Number(trip.pickupLng) };
    }

    if (trip.pickupPlaceId) {
      const byPlaceId = await geocodePlaceId(trip.pickupPlaceId);
      if (byPlaceId) {
        return { lat: byPlaceId.lat, lng: byPlaceId.lng };
      }
    }

    const byAddress = await geocodeAddress(trip.pickupText);
    if (byAddress) {
      return { lat: byAddress.lat, lng: byAddress.lng };
    }

    return null;
  };

  const resolveDestinationInput = async (input: string): Promise<{ destinationText: string; destinationPlaceId: string; destinationOriginalLink?: string; destLat: number; destLng: number } | null> => {
    const cleaned = input.trim();
    if (!cleaned) return null;

    const parsed = parseGoogleMapsLink(cleaned) || parseGpsOrLatLngInput(cleaned);
    if (parsed) {
      return {
        destinationText: `${parsed.lat.toFixed(6)}, ${parsed.lng.toFixed(6)}`,
        destinationPlaceId: 'GPS',
        destinationOriginalLink: parsed.originalUrl,
        destLat: parsed.lat,
        destLng: parsed.lng,
      };
    }

    const geocoded = await geocodeAddress(cleaned);
    if (!geocoded) return null;

    return {
      destinationText: geocoded.formattedAddress,
      destinationPlaceId: geocoded.placeId,
      destinationOriginalLink: undefined,
      destLat: geocoded.lat,
      destLng: geocoded.lng,
    };
  };

  const resolveStopInput = async (input: string): Promise<TripStop | null> => {
    const cleaned = input.trim();
    if (!cleaned) return null;

    const parsed = parseGoogleMapsLink(cleaned) || parseGpsOrLatLngInput(cleaned);
    if (parsed) {
      return {
        text: `${parsed.lat.toFixed(6)}, ${parsed.lng.toFixed(6)}`,
        placeId: 'GPS',
        originalLink: parsed.originalUrl,
        lat: parsed.lat,
        lng: parsed.lng,
      };
    }

    const geocoded = await geocodeAddress(cleaned);
    if (!geocoded) return null;

    return {
      text: geocoded.formattedAddress,
      placeId: geocoded.placeId,
      lat: geocoded.lat,
      lng: geocoded.lng,
    };
  };

  const buildSafeDepartureTime = (trip: Trip) => {
    const now = new Date();
    const minimumFutureMs = 2 * 60 * 1000;
    const minimumFutureTime = new Date(now.getTime() + minimumFutureMs);
    const requested = trip.tripDate ? new Date(trip.tripDate) : now;

    if (!Number.isFinite(requested.getTime()) || requested.getTime() <= minimumFutureTime.getTime()) {
      return minimumFutureTime.toISOString();
    }

    return requested.toISOString();
  };

  const handleRequoteDestination = async (trip: Trip, destinationInput: string, stopInputs: string[]): Promise<{ ok: true; updatedTrip: Trip } | { ok: false; reason: string }> => {
    try {
      if (!settings.googleMapsApiKey.trim()) {
        return { ok: false, reason: 'Google Maps API key is missing in Settings.' };
      }

      const cleanedDestination = destinationInput.trim();
      let resolvedDestination = cleanedDestination
        ? await resolveDestinationInput(cleanedDestination)
        : {
            destinationText: trip.destinationText,
            destinationPlaceId: trip.destinationPlaceId || 'GPS',
            destinationOriginalLink: trip.destinationOriginalLink,
            destLat: Number(trip.destLat),
            destLng: Number(trip.destLng),
          };

      if (resolvedDestination && (!Number.isFinite(resolvedDestination.destLat) || !Number.isFinite(resolvedDestination.destLng))) {
        const byPlaceId = resolvedDestination.destinationPlaceId
          ? await geocodePlaceId(resolvedDestination.destinationPlaceId)
          : null;
        if (byPlaceId) {
          resolvedDestination = {
            ...resolvedDestination,
            destinationText: byPlaceId.formattedAddress || resolvedDestination.destinationText,
            destLat: byPlaceId.lat,
            destLng: byPlaceId.lng,
          };
        } else {
          const byAddress = await geocodeAddress(resolvedDestination.destinationText || trip.destinationText);
          if (byAddress) {
            resolvedDestination = {
              destinationText: byAddress.formattedAddress,
              destinationPlaceId: byAddress.placeId,
              destinationOriginalLink: resolvedDestination.destinationOriginalLink,
              destLat: byAddress.lat,
              destLng: byAddress.lng,
            };
          }
        }
      }

      if (!resolvedDestination || !Number.isFinite(resolvedDestination.destLat) || !Number.isFinite(resolvedDestination.destLng)) {
        return { ok: false, reason: 'Destination could not be resolved. Use a clear address or Google Maps link.' };
      }

      const pickupCoords = await resolvePickupCoordinates(trip);
      if (!pickupCoords) {
        return { ok: false, reason: 'Pickup coordinates are missing and could not be resolved.' };
      }

      const cleanedStops = stopInputs.map(value => value.trim()).filter(Boolean);
      const resolvedStops: TripStop[] = [];
      for (const stopValue of cleanedStops) {
        const resolvedStop = await resolveStopInput(stopValue);
        if (!resolvedStop || !Number.isFinite(resolvedStop.lat) || !Number.isFinite(resolvedStop.lng)) {
          return { ok: false, reason: `Stop could not be resolved: ${stopValue}` };
        }
        resolvedStops.push(resolvedStop);
      }

      const intermediates = resolvedStops.map(stop => ({
        location: {
          latLng: {
            latitude: Number(stop.lat),
            longitude: Number(stop.lng),
          },
        },
      }));

      const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': settings.googleMapsApiKey,
          'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.staticDuration'
        },
        body: JSON.stringify({
          origin: {
            location: {
              latLng: {
                latitude: pickupCoords.lat,
                longitude: pickupCoords.lng,
              },
            },
          },
          destination: {
            location: {
              latLng: {
                latitude: resolvedDestination.destLat,
                longitude: resolvedDestination.destLng,
              },
            },
          },
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_AWARE',
          languageCode: 'en-US',
          units: 'METRIC',
          departureTime: buildSafeDepartureTime(trip),
          ...(intermediates.length > 0 ? { intermediates } : {}),
        }),
      });

      if (!response.ok) {
        const details = await response.text();
        return { ok: false, reason: `Routes API error (${response.status}): ${details || 'Unable to compute route.'}` };
      }

      const payload = await response.json();
      const route = payload?.routes?.[0];
      if (!route) {
        return { ok: false, reason: 'No route found for this destination.' };
      }

      const distanceMeters = Number(route.distanceMeters || 0);
      const durationInTrafficMin = parseDurationToMinutes(route.duration);
      const baselineDurationMin = parseDurationToMinutes(route.staticDuration || route.duration);
      const surplusMin = Math.max(0, durationInTrafficMin - baselineDurationMin);

      const distanceKm = distanceMeters / 1000;
      const ratePerKm = trip.ratePerKmSnapshot || settings.ratePerKm;
      const hourlyWaitRate = trip.hourlyWaitRateSnapshot || settings.hourlyWaitRate;
      const exchangeRate = trip.exchangeRateSnapshot || settings.exchangeRate;
      const effectiveDistance = distanceKm * (trip.isRoundTrip ? 2 : 1);
      const baseFare = Math.ceil(effectiveDistance * ratePerKm);
      const waitFare = Math.ceil((trip.waitTimeHours || 0) * hourlyWaitRate);
      const computedFare = baseFare + waitFare;
      const minimumFare = Number.isFinite(MIN_RIDE_FARE_USD) ? Math.max(0, MIN_RIDE_FARE_USD) : 7;
      const fareUsd = Math.max(minimumFare, computedFare);

      return {
        ok: true,
        updatedTrip: {
          ...trip,
          destinationText: resolvedDestination.destinationText,
          destinationPlaceId: resolvedDestination.destinationPlaceId,
          destinationOriginalLink: resolvedDestination.destinationOriginalLink,
          destLat: resolvedDestination.destLat,
          destLng: resolvedDestination.destLng,
          stops: resolvedStops,
          distanceKm,
          distanceText: `${distanceKm.toFixed(1)} km`,
          durationMin: baselineDurationMin,
          durationText: `${baselineDurationMin} min`,
          durationInTrafficMin,
          durationInTrafficText: `${durationInTrafficMin} min`,
          trafficIndex: computeTrafficIndex(durationInTrafficMin, baselineDurationMin),
          surplusMin,
          fareUsd,
          fareLbp: fareUsd * exchangeRate,
        },
      };
    } catch (error: any) {
      return { ok: false, reason: String(error?.message || 'Failed to recompute destination quote.') };
    }
  };

  const escapeCsvCell = (value: unknown): string => {
    const text = String(value ?? '');
    if (text.includes('"') || text.includes(',') || text.includes('\n')) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const handleManifestDownload = (scope: 'FILTERED' | 'ALL' = 'FILTERED') => {
    const exportTrips = scope === 'ALL' ? trips : filteredTrips;
    const exportDeleted = scope === 'ALL' ? deletedTrips : filteredDeletedTrips;

    if (exportTrips.length === 0 && exportDeleted.length === 0) {
      setManifestState('ERROR');
      setManifestMessage('No vectors available for export with current filters.');
      return;
    }

    const headers = [
      'trip_id',
      'status',
      'scheduled_at',
      'created_at',
      'customer_name',
      'customer_phone',
      'driver_name',
      'pickup',
      'destination',
      'distance_km',
      'duration_min',
      'eta_traffic_min',
      'traffic_index',
      'surplus_min',
      'fare_usd',
      'fare_lbp',
      'payment_mode',
      'settlement_status',
      'credit_entry_id',
      'receipt_id',
      'settled_at',
      'stops_count',
      'stops',
      'confirmation_sent',
      'feedback_request_sent',
      'thank_you_sent',
      'notes',
      'archived_deleted_at',
      'archive_reason'
    ];

    try {
      const activeRows = exportTrips.map(trip => {
        const driverName = drivers.find(d => d.id === trip.driverId)?.name || 'Unassigned';
        const trafficMetrics = getTripTrafficMetrics(trip);
        return [
          trip.id,
          trip.status,
          trip.tripDate || '',
          trip.createdAt,
          trip.customerName,
          trip.customerPhone,
          driverName,
          trip.pickupText,
          trip.destinationText,
          trip.distanceKm,
          trip.durationMin,
          trafficMetrics.etaMin,
          trafficMetrics.trafficIndex,
          trafficMetrics.surplusMin,
          trip.fareUsd,
          trip.fareLbp,
          trip.paymentMode || 'CASH',
          trip.settlementStatus || 'PENDING',
          trip.creditLedgerEntryId || '',
          trip.receiptId || '',
          trip.settledAt || '',
          trip.stops?.length || 0,
          formatTripStops(trip).replace(/\n/g, ' | '),
          trip.confirmation_sent_at ? 'YES' : 'NO',
          trip.feedback_request_sent_at ? 'YES' : 'NO',
          trip.thank_you_sent_at ? 'YES' : 'NO',
          trip.notes,
          '',
          ''
        ].map(escapeCsvCell).join(',');
      });

      const deletedRows = exportDeleted.map(record => {
        const trip = record.trip;
        const driverName = drivers.find(d => d.id === trip.driverId)?.name || 'Unassigned';
        const trafficMetrics = getTripTrafficMetrics(trip);
        return [
          trip.id,
          trip.status,
          trip.tripDate || '',
          trip.createdAt,
          trip.customerName,
          trip.customerPhone,
          driverName,
          trip.pickupText,
          trip.destinationText,
          trip.distanceKm,
          trip.durationMin,
          trafficMetrics.etaMin,
          trafficMetrics.trafficIndex,
          trafficMetrics.surplusMin,
          trip.fareUsd,
          trip.fareLbp,
          trip.paymentMode || 'CASH',
          trip.settlementStatus || 'PENDING',
          trip.creditLedgerEntryId || '',
          trip.receiptId || '',
          trip.settledAt || '',
          trip.stops?.length || 0,
          formatTripStops(trip).replace(/\n/g, ' | '),
          trip.confirmation_sent_at ? 'YES' : 'NO',
          trip.feedback_request_sent_at ? 'YES' : 'NO',
          trip.thank_you_sent_at ? 'YES' : 'NO',
          trip.notes,
          record.deletedAt,
          record.deletedReason
        ].map(escapeCsvCell).join(',');
      });

      const csvContent = [headers.join(','), ...activeRows, ...deletedRows].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `mission-log-manifest-${scope === 'ALL' ? 'all' : 'filtered'}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);

      setManifestState('DONE');
      setManifestMessage(`Manifest exported (${exportTrips.length} active + ${exportDeleted.length} archived deletions · ${scope === 'ALL' ? 'all history' : 'filtered'}).`);
    } catch {
      setManifestState('ERROR');
      setManifestMessage('Manifest export failed. Please retry.');
    }
  };

  const getDriverTemplate = (trip: Trip) => {
    const date = trip.tripDate ? format(parseISO(trip.tripDate), "d MMM, h:mm a") : format(parseISO(trip.createdAt), "d MMM, h:mm a");
    return `MISSION ASSIGNED\nTime: ${date}\nClient: ${trip.customerName}\nCall: ${trip.customerPhone}\n\nPickup: ${formatTripPickup(trip)}\nDrop-off: ${formatTripDestination(trip)}\n\nPayment: ${trip.paymentMode || 'CASH'}\nSettlement: ${trip.settlementStatus || 'PENDING'}\n\nNotes: ${trip.notes || 'Standard pickup'}${operationalServiceLinksBlock}`;
  };

  const getCustomerTemplate = (trip: Trip) => {
    const driver = drivers.find(d => d.id === trip.driverId);
    const date = trip.tripDate ? format(parseISO(trip.tripDate), "d MMM, h:mm a") : format(parseISO(trip.createdAt), "d MMM, h:mm a");
    const driverInfo = driver ? `\nDriver: ${driver.name}` : '';
    return `RIDE CONFIRMED\nDate: ${date}\nFrom: ${formatTripPickup(trip)}\nTo: ${formatTripDestination(trip)}\nFare: $${trip.fareUsd}${driverInfo}${operationalServiceLinksBlock}`;
  };

  const getTripExtractTemplate = (trip: Trip) => {
    const driver = drivers.find(d => d.id === trip.driverId);
    const date = trip.tripDate ? format(parseISO(trip.tripDate), "d MMM, h:mm a") : format(parseISO(trip.createdAt), "d MMM, h:mm a");
    return [
      `MISSION EXTRACT`,
      `#${trip.id.toString().slice(-4)} · ${statusConfig[trip.status].label.toUpperCase()}`,
      `${date}`,
      `${trip.customerName} (${trip.customerPhone})`,
      `Driver: ${driver?.name || 'Unassigned'}`,
      `Pickup: ${formatTripPickup(trip)}`,
      `Destination: ${formatTripDestination(trip)}`,
      `Fare: $${trip.fareUsd}`,
      `Payment: ${trip.paymentMode || 'CASH'}`,
      `Settlement: ${trip.settlementStatus || 'PENDING'}`,
      `Notes: ${trip.notes || '-'}`,
      ...(operationalServiceLinks.length > 0 ? ['', 'Links:', ...operationalServiceLinks] : []),
    ].join('\n');
  };

  const openModal = (trip: Trip, focusTarget: TripModalFocusTarget = 'DEFAULT') => {
    setSnapshotPreviewTrip(null);
    setUnitSnapshotDriverId(null);
    setModalFocusTarget(focusTarget);
    setSelectedTrip(trip);
    setIsModalOpen(true);
  };

  const handleInlineDriverAssign = (trip: Trip, nextDriverId: string) => {
    const normalizedDriverId = nextDriverId.trim();
    if (!normalizedDriverId) {
      setInlineAssignTripId(null);
      setInlineAssignQuery('');
      setShowInlineAssignSuggestions(false);
      setInlineAssignHighlightedIndex(0);
      return;
    }

    const assignedDriver = drivers.find(driver => driver.id === normalizedDriverId);
    if (!assignedDriver) {
      showActionToast('Selected driver was not found.', 'ERROR');
      setInlineAssignTripId(null);
      setInlineAssignQuery('');
      setShowInlineAssignSuggestions(false);
      setInlineAssignHighlightedIndex(0);
      return;
    }

    const updatedTrip: Trip = {
      ...trip,
      driverId: normalizedDriverId,
    };

    updateFullTrip(updatedTrip);

    if (selectedTrip?.id === trip.id) {
      setSelectedTrip(updatedTrip);
    }

    setInlineAssignTripId(null);
    setInlineAssignQuery('');
    setShowInlineAssignSuggestions(false);
    setInlineAssignHighlightedIndex(0);
    showActionToast(`Trip #${trip.id.toString().slice(-4)} assigned to ${assignedDriver.name}.`);
  };

  const buildDateTimeLocalValue = (isoValue?: string): string => {
    const candidate = isoValue ? new Date(isoValue) : new Date();
    if (Number.isNaN(candidate.getTime())) return '';
    return format(candidate, "yyyy-MM-dd'T'HH:mm");
  };

  const openInlineScheduleEditor = (trip: Trip) => {
    setInlineAssignTripId(null);
    setInlineAssignQuery('');
    setShowInlineAssignSuggestions(false);
    setInlineAssignHighlightedIndex(0);
    setInlineScheduleTripId(trip.id);
    setInlineScheduleDraft(buildDateTimeLocalValue(trip.tripDate || trip.createdAt));
  };

  const closeInlineScheduleEditor = () => {
    setInlineScheduleTripId(null);
    setInlineScheduleDraft('');
  };

  const handleInlineScheduleSave = (trip: Trip) => {
    const trimmed = inlineScheduleDraft.trim();
    if (!trimmed) {
      showActionToast('Pick a valid scheduled time.', 'ERROR');
      return;
    }

    const candidateDate = new Date(trimmed);
    if (Number.isNaN(candidateDate.getTime())) {
      showActionToast('Pick a valid scheduled time.', 'ERROR');
      return;
    }

    const updatedTrip: Trip = {
      ...trip,
      tripDate: candidateDate.toISOString(),
    };

    updateFullTrip(updatedTrip);

    if (selectedTrip?.id === trip.id) {
      setSelectedTrip(updatedTrip);
    }

    closeInlineScheduleEditor();
    showActionToast(`Trip #${trip.id.toString().slice(-4)} schedule updated.`);
  };

  const handleCommitPhase = (updatedTrip: Trip) => {
    if (!selectedTrip) return;
    const wasCompleted = selectedTrip.status !== TripStatus.COMPLETED && updatedTrip.status === TripStatus.COMPLETED;
    const feedbackJustReceived = selectedTrip.rating === undefined && updatedTrip.rating !== undefined;

    updateFullTrip(updatedTrip);
    setIsModalOpen(false);
    setModalFocusTarget('DEFAULT');

    if (wasCompleted) {
      setManifestState('DONE');
      setManifestMessage(`Trip #${updatedTrip.id.toString().slice(-4)} marked completed and moved to Completed Archive.`);
      showActionToast(`Trip #${updatedTrip.id.toString().slice(-4)} moved to Completed Archive.`);
      setCompletedTripsCollapsed(false);
      setTimeout(() => setMessagingContext({ trip: updatedTrip, type: 'FEEDBACK_REQ' }), 400);
    } else if (feedbackJustReceived) {
      setTimeout(() => setMessagingContext({ trip: updatedTrip, type: 'THANKS' }), 400);
    }
  };

  const handleDeleteCancelled = (trip: Trip) => {
    const confirmDelete = window.confirm(`Delete cancelled trip #${trip.id.toString().slice(-4)}? It will stay archived in Vault and manifest exports.`);
    if (!confirmDelete) return;

    const result = deleteCancelledTrip(trip.id);
    if (!result.ok) {
      setManifestState('ERROR');
      setManifestMessage(result.reason || 'Failed to archive deleted trip.');
      showActionToast(result.reason || 'Failed to archive deleted trip.', 'ERROR');
      return;
    }

    setManifestState('DONE');
    setManifestMessage(`Cancelled trip #${trip.id.toString().slice(-4)} deleted and archived.`);
    showActionToast(`Trip #${trip.id.toString().slice(-4)} deleted and archived.`);

    if (selectedTrip?.id === trip.id) {
      setSelectedTrip(null);
      setIsModalOpen(false);
    }
  };

  const handleRestoreDeletedTrip = (archiveId: string, tripLabel: string) => {
    const result = restoreDeletedTrip(archiveId);
    if (!result.ok) {
      setManifestState('ERROR');
      setManifestMessage(result.reason || 'Failed to restore archived trip.');
      showActionToast(result.reason || 'Failed to restore archived trip.', 'ERROR');
      return;
    }

    setManifestState('DONE');
    setManifestMessage(`Archived trip ${tripLabel} restored to active Mission Log.`);
    showActionToast(`Archived trip ${tripLabel} restored to active log.`);
  };

  const handleReopenCompletedTrip = (trip: Trip) => {
    const reopenedTrip: Trip = {
      ...trip,
      status: TripStatus.CONFIRMED,
    };
    updateFullTrip(reopenedTrip);
    setManifestState('DONE');
    setManifestMessage(`Completed trip #${trip.id.toString().slice(-4)} reopened to active missions.`);
    showActionToast(`Trip #${trip.id.toString().slice(-4)} reopened to active missions.`);
  };

  const handleAssignLocationFromTrip = (
    trip: Trip,
    target: 'HOME' | 'BUSINESS' | 'FREQUENT' | 'SMART_PICKUP',
    source: 'PICKUP' | 'DROPOFF'
  ): string => {
    const normalizedPhone = customerPhoneKey(trip.customerPhone);
    const normalizedName = (trip.customerName || '').trim();

    if (!normalizedPhone || !normalizedName) {
      return 'Customer name/phone is required before assigning places.';
    }

    const isPickup = target === 'SMART_PICKUP' ? true : source === 'PICKUP';
    const selectedAddress = isPickup ? trip.pickupText : trip.destinationText;
    const selectedMapsLink = isPickup ? trip.pickupOriginalLink : trip.destinationOriginalLink;
    const selectedLat = isPickup ? trip.pickupLat : trip.destLat;
    const selectedLng = isPickup ? trip.pickupLng : trip.destLng;

    if (!selectedAddress) {
      return 'Trip location text is missing for this assignment.';
    }

    const existing = customers.find(entry => customerPhoneKey(entry.phone) === normalizedPhone);
    const nextLocation: CustomerLocation = {
      label: target === 'HOME' ? 'Home' : target === 'BUSINESS' ? 'Business' : 'Place',
      address: selectedAddress,
      ...(selectedMapsLink ? { mapsLink: selectedMapsLink } : {}),
      ...(typeof selectedLat === 'number' ? { lat: selectedLat } : {}),
      ...(typeof selectedLng === 'number' ? { lng: selectedLng } : {}),
    };

    const existingFrequent = Array.isArray(existing?.frequentLocations) ? existing!.frequentLocations : [];
    const shouldAppendFrequent = target === 'FREQUENT' || target === 'SMART_PICKUP';
    const nextFrequent = shouldAppendFrequent
      ? [...existingFrequent, nextLocation].filter((entry, index, collection) => {
          const key = `${entry.address.toLowerCase()}|${String(entry.mapsLink || '').toLowerCase()}|${entry.lat ?? ''}|${entry.lng ?? ''}`;
          return collection.findIndex(candidate => `${candidate.address.toLowerCase()}|${String(candidate.mapsLink || '').toLowerCase()}|${candidate.lat ?? ''}|${candidate.lng ?? ''}` === key) === index;
        })
      : existingFrequent;

    const patch: Customer = {
      id: existing?.id || `${Date.now()}-${Math.random()}`,
      name: existing?.name || normalizedName,
      phone: normalizedPhone,
      source: existing?.source || 'MANUAL',
      createdAt: existing?.createdAt || new Date().toISOString(),
      ...(existing?.notes ? { notes: existing.notes } : {}),
      ...(existing?.profileTimeline ? { profileTimeline: existing.profileTimeline } : {}),
      ...(existing?.lastEnrichedAt ? { lastEnrichedAt: existing.lastEnrichedAt } : {}),
      ...(existing?.isInternational ? { isInternational: existing.isInternational } : {}),
      ...(existing?.marketSegments ? { marketSegments: existing.marketSegments } : {}),
      ...(existing?.gender ? { gender: existing.gender } : {}),
      ...(existing?.entityType ? { entityType: existing.entityType } : {}),
      ...(existing?.profession ? { profession: existing.profession } : {}),
      ...(target === 'HOME' ? { homeLocation: nextLocation } : (existing?.homeLocation ? { homeLocation: existing.homeLocation } : {})),
      ...(target === 'BUSINESS' ? { businessLocation: nextLocation } : (existing?.businessLocation ? { businessLocation: existing.businessLocation } : {})),
      frequentLocations: nextFrequent,
    };

    addCustomers([patch]);
    if (target === 'SMART_PICKUP') {
      return 'Pickup added to Frequent places.';
    }
    return target === 'HOME'
      ? `${source === 'PICKUP' ? 'Pickup' : 'Dropoff'} saved as Home.`
      : target === 'BUSINESS'
        ? `${source === 'PICKUP' ? 'Pickup' : 'Dropoff'} saved as Business.`
        : `${source === 'PICKUP' ? 'Pickup' : 'Dropoff'} added to Frequent places.`;
  };

  const handleSetCustomerPriorityFromTrip = (trip: Trip, tier: 'VIP' | 'VVIP'): string => {
    const normalizedPhone = customerPhoneKey(trip.customerPhone);
    const normalizedName = (trip.customerName || '').trim();

    if (!normalizedPhone || !normalizedName) {
      return 'Customer name/phone is required before designation.';
    }

    const existing = customers.find(entry => customerPhoneKey(entry.phone) === normalizedPhone);
    const existingNotes = (existing?.notes || '').replace(/\bVVIP\b|\bVIP\b/gi, '').replace(/\s{2,}/g, ' ').trim();
    const nextNotes = `[${tier}]${existingNotes ? ` ${existingNotes}` : ''}`;

    const patch: Customer = {
      id: existing?.id || `${Date.now()}-${Math.random()}`,
      name: existing?.name || normalizedName,
      phone: normalizedPhone,
      source: existing?.source || 'MANUAL',
      createdAt: existing?.createdAt || new Date().toISOString(),
      notes: nextNotes,
      ...(existing?.profileTimeline ? { profileTimeline: existing.profileTimeline } : {}),
      ...(existing?.lastEnrichedAt ? { lastEnrichedAt: existing.lastEnrichedAt } : {}),
      ...(existing?.isInternational ? { isInternational: existing.isInternational } : {}),
      ...(existing?.marketSegments ? { marketSegments: existing.marketSegments } : {}),
      ...(existing?.gender ? { gender: existing.gender } : {}),
      ...(existing?.entityType ? { entityType: existing.entityType } : {}),
      ...(existing?.profession ? { profession: existing.profession } : {}),
      ...(existing?.homeLocation ? { homeLocation: existing.homeLocation } : {}),
      ...(existing?.businessLocation ? { businessLocation: existing.businessLocation } : {}),
      ...(existing?.frequentLocations ? { frequentLocations: existing.frequentLocations } : {}),
    };

    addCustomers([patch]);
    return `Customer designated as ${tier}.`;
  };

  return (
    <div className="flex flex-col h-full bg-slate-50 dark:bg-brand-950 transition-colors duration-300">
      
      {/* Dynamic Summary Bar */}
      <div className="trip-summary-bar px-4 md:px-8 py-6 grid grid-cols-2 lg:grid-cols-4 gap-4 bg-white dark:bg-brand-900 border-b border-slate-200 dark:border-brand-800 sticky top-0 z-20">
        {[
          { label: 'Today Missions', val: pulseStats.todayCount, icon: Calendar, color: 'text-blue-600' },
          { label: 'Assignment Gap', val: pulseStats.pendingAssignment, icon: AlertTriangle, color: pulseStats.pendingAssignment > 0 ? 'text-amber-500 animate-pulse' : 'text-slate-400' },
          { label: 'Mission Success', val: `${pulseStats.successRate}%`, icon: CheckCircle2, color: 'text-emerald-500' },
          { label: 'Daily Yield', val: `$${pulseStats.projectedRevenue}`, icon: DollarSign, color: 'text-gold-600' }
        ].map((s, i) => (
          <div key={i} className="flex items-center space-x-3 group cursor-default">
            <div className={`p-2.5 rounded-xl bg-slate-50 dark:bg-brand-950 border border-slate-100 dark:border-white/5 transition-all group-hover:scale-110 ${s.color}`}><s.icon size={16}/></div>
            <div>
              <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">{s.label}</p>
              <p className={`text-sm md:text-lg font-black leading-none ${s.color}`}>{s.val}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="app-page-shell p-4 md:p-8 flex-1 overflow-auto space-y-6">
        {/* Filter Controls */}
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
          <div className="flex items-center space-x-4">
             <div>
                <h2 className="text-2xl font-black text-brand-900 dark:text-white uppercase tracking-tight">Mission Log</h2>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-0.5">Vector Lifecycle Audit</p>
             </div>
             <div className="hidden sm:flex bg-slate-200 dark:bg-brand-900 rounded-lg p-1 border border-slate-300 dark:border-white/5">
                <button onClick={() => setViewMode('TABLE')} className={`p-1.5 rounded-md transition-all ${viewMode === 'TABLE' ? 'bg-white dark:bg-brand-800 text-brand-900 dark:text-gold-400 shadow-sm' : 'text-slate-400'}`}><ListIcon size={16}/></button>
                <button onClick={() => setViewMode('CARD')} className={`p-1.5 rounded-md transition-all ${viewMode === 'CARD' ? 'bg-white dark:bg-brand-800 text-brand-900 dark:text-gold-400 shadow-sm' : 'text-slate-400'}`}><LayoutGrid size={16}/></button>
                {viewMode === 'TABLE' && (
                  <button
                    type="button"
                    onClick={() => setIsTableFullView(prev => !prev)}
                    title={isTableFullView ? 'Exit full view (Esc)' : 'Open full view'}
                    className={`p-1.5 rounded-md transition-all ${isTableFullView ? 'bg-white dark:bg-brand-800 text-brand-900 dark:text-gold-400 shadow-sm' : 'text-slate-400 hover:text-brand-900 dark:hover:text-gold-400'}`}
                  >
                    {isTableFullView ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                  </button>
                )}
             </div>
          </div>

          <div className="flex flex-col gap-1.5 w-full lg:flex-1 lg:min-w-0">
          <div className="w-full flex flex-nowrap items-center gap-0.5 overflow-x-auto rounded-lg border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 px-1.5 py-1 pb-1.5 snap-x snap-mandatory scroll-px-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>button]:shrink-0 [&>button]:snap-start [&>span]:shrink-0 [&>span]:snap-start">
            <button
              type="button"
              onClick={() => togglePaymentModeFilter('CASH')}
              title="Cash payment"
              aria-label={`Cash payment filter, ${filterOptionCounts.payment.CASH} missions`}
              className={`inline-flex items-center h-5 px-2 rounded-md border text-[7px] font-black tracking-[0.06em] leading-none transition-colors whitespace-nowrap ${paymentModeFilters.includes('CASH')
                ? 'border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10'
                : 'border-slate-300 text-slate-400 bg-slate-50 dark:border-slate-700 dark:text-slate-500 dark:bg-slate-900/20'}`}
            >
              <DollarSign size={10} className="mr-1 opacity-90" aria-hidden="true" />
              <span>Cash</span>
              <span className="ml-1 tabular-nums">{filterOptionCounts.payment.CASH}</span>
            </button>
            <button
              type="button"
              onClick={() => togglePaymentModeFilter('CREDIT')}
              title="Credit account payment"
              aria-label={`Credit payment filter, ${filterOptionCounts.payment.CREDIT} missions`}
              className={`inline-flex items-center h-5 px-2 rounded-md border text-[7px] font-black tracking-[0.06em] leading-none transition-colors whitespace-nowrap ${paymentModeFilters.includes('CREDIT')
                ? 'border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10'
                : 'border-slate-300 text-slate-400 bg-slate-50 dark:border-slate-700 dark:text-slate-500 dark:bg-slate-900/20'}`}
            >
              <ArrowRightLeft size={10} className="mr-1 opacity-90" aria-hidden="true" />
              <span>Credit</span>
              <span className="ml-1 tabular-nums">{filterOptionCounts.payment.CREDIT}</span>
            </button>
            <button
              type="button"
              onClick={() => toggleSettlementFilter('PENDING')}
              title="Not settled yet"
              aria-label={`Pending settlement filter, ${filterOptionCounts.settlement.PENDING} missions`}
              className={`inline-flex items-center h-5 px-2 rounded-md border text-[7px] font-black tracking-[0.06em] leading-none transition-colors whitespace-nowrap ${settlementFilters.includes('PENDING')
                ? 'border-slate-300 text-slate-600 bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:bg-slate-900/20'
                : 'border-slate-300 text-slate-400 bg-slate-50 dark:border-slate-700 dark:text-slate-500 dark:bg-slate-900/20'}`}
            >
              <Clock size={10} className="mr-1 opacity-90" aria-hidden="true" />
              <span>Pending</span>
              <span className="ml-1 tabular-nums">{filterOptionCounts.settlement.PENDING}</span>
            </button>
            <button
              type="button"
              onClick={() => toggleSettlementFilter('SETTLED')}
              title="Paid and settled"
              aria-label={`Settled filter, ${filterOptionCounts.settlement.SETTLED} missions`}
              className={`inline-flex items-center h-5 px-2 rounded-md border text-[7px] font-black tracking-[0.06em] leading-none transition-colors whitespace-nowrap ${settlementFilters.includes('SETTLED')
                ? 'border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-900/40 dark:text-amber-300 dark:bg-amber-900/10'
                : 'border-slate-300 text-slate-400 bg-slate-50 dark:border-slate-700 dark:text-slate-500 dark:bg-slate-900/20'}`}
            >
              <CheckCircle2 size={10} className="mr-1 opacity-90" aria-hidden="true" />
              <span>Settled</span>
              <span className="ml-1 tabular-nums">{filterOptionCounts.settlement.SETTLED}</span>
            </button>
            <button
              type="button"
              onClick={() => toggleSettlementFilter('RECEIPTED')}
              title="Receipt issued"
              aria-label={`Receipted filter, ${filterOptionCounts.settlement.RECEIPTED} missions`}
              className={`inline-flex items-center h-5 px-2 rounded-md border text-[7px] font-black tracking-[0.06em] leading-none transition-colors whitespace-nowrap ${settlementFilters.includes('RECEIPTED')
                ? 'border-indigo-300 text-indigo-700 bg-indigo-50 dark:border-indigo-900/40 dark:text-indigo-300 dark:bg-indigo-900/10'
                : 'border-slate-300 text-slate-400 bg-slate-50 dark:border-slate-700 dark:text-slate-500 dark:bg-slate-900/20'}`}
            >
              <FileText size={10} className="mr-1 opacity-90" aria-hidden="true" />
              <span>Receipted</span>
              <span className="ml-1 tabular-nums">{filterOptionCounts.settlement.RECEIPTED}</span>
            </button>
            <span className="mx-0.5 h-3 w-px bg-slate-200 dark:bg-brand-800" />
            <button
              type="button"
              onClick={() => toggleStatusFilter(TripStatus.QUOTED)}
              title="Quote stage"
              aria-label={`Quoted status filter, ${filterOptionCounts.status[TripStatus.QUOTED]} missions`}
              className={`inline-flex items-center h-5 px-2 rounded-md border text-[7px] font-black tracking-[0.06em] leading-none transition-colors whitespace-nowrap ${statusFilters.includes(TripStatus.QUOTED)
                ? 'border-slate-400 text-slate-700 bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:bg-slate-900/30'
                : 'border-slate-300 text-slate-400 bg-slate-50 dark:border-slate-700 dark:text-slate-500 dark:bg-slate-900/20'}`}
            >
              <FileText size={10} className="mr-1 opacity-90" aria-hidden="true" />
              <span>Quoted</span>
              <span className="ml-1 tabular-nums">{filterOptionCounts.status[TripStatus.QUOTED]}</span>
            </button>
            <button
              type="button"
              onClick={() => toggleStatusFilter(TripStatus.CONFIRMED)}
              title="Confirmed and planned"
              aria-label={`Confirmed status filter, ${filterOptionCounts.status[TripStatus.CONFIRMED]} missions`}
              className={`inline-flex items-center h-5 px-2 rounded-md border text-[7px] font-black tracking-[0.06em] leading-none transition-colors whitespace-nowrap ${statusFilters.includes(TripStatus.CONFIRMED)
                ? 'border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10'
                : 'border-slate-300 text-slate-400 bg-slate-50 dark:border-slate-700 dark:text-slate-500 dark:bg-slate-900/20'}`}
            >
              <CheckCircle2 size={10} className="mr-1 opacity-90" aria-hidden="true" />
              <span>Confirmed</span>
              <span className="ml-1 tabular-nums">{filterOptionCounts.status[TripStatus.CONFIRMED]}</span>
            </button>
            <button
              type="button"
              onClick={() => toggleStatusFilter(TripStatus.COMPLETED)}
              title="Mission completed"
              aria-label={`Completed status filter, ${filterOptionCounts.status[TripStatus.COMPLETED]} missions`}
              className={`inline-flex items-center h-5 px-2 rounded-md border text-[7px] font-black tracking-[0.06em] leading-none transition-colors whitespace-nowrap ${statusFilters.includes(TripStatus.COMPLETED)
                ? 'border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10'
                : 'border-slate-300 text-slate-400 bg-slate-50 dark:border-slate-700 dark:text-slate-500 dark:bg-slate-900/20'}`}
            >
              <Check size={10} className="mr-1 opacity-90" aria-hidden="true" />
              <span>Completed</span>
              <span className="ml-1 tabular-nums">{filterOptionCounts.status[TripStatus.COMPLETED]}</span>
            </button>
            <button
              type="button"
              onClick={() => toggleStatusFilter(TripStatus.CANCELLED)}
              title="Cancelled mission"
              aria-label={`Cancelled status filter, ${filterOptionCounts.status[TripStatus.CANCELLED]} missions`}
              className={`inline-flex items-center h-5 px-2 rounded-md border text-[7px] font-black tracking-[0.06em] leading-none transition-colors whitespace-nowrap ${statusFilters.includes(TripStatus.CANCELLED)
                ? 'border-red-300 text-red-700 bg-red-50 dark:border-red-900/40 dark:text-red-300 dark:bg-red-900/10'
                : 'border-slate-300 text-slate-400 bg-slate-50 dark:border-slate-700 dark:text-slate-500 dark:bg-slate-900/20'}`}
            >
              <XCircle size={10} className="mr-1 opacity-90" aria-hidden="true" />
              <span>Cancelled</span>
              <span className="ml-1 tabular-nums">{filterOptionCounts.status[TripStatus.CANCELLED]}</span>
            </button>
            <span className="mx-0.5 h-3 w-px bg-slate-200 dark:bg-brand-800" />
            <span className="inline-flex items-center h-5 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-[7px] font-black tracking-[0.06em] leading-none whitespace-nowrap text-slate-500 dark:text-slate-300">
              Active <span className="ml-1 tabular-nums">{activeTrips.length}</span>
            </span>
            <span className="inline-flex items-center h-5 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-[7px] font-black tracking-[0.06em] leading-none whitespace-nowrap text-slate-500 dark:text-slate-300">
              Completed <span className="ml-1 tabular-nums">{completedTrips.length}</span>
            </span>
            <span className="inline-flex items-center h-5 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-[7px] font-black tracking-[0.06em] leading-none whitespace-nowrap text-slate-500 dark:text-slate-300">
              Deleted <span className="ml-1 tabular-nums">{filteredDeletedTrips.length}</span>
            </span>
            {hasActiveFilters && (
              <span className="inline-flex items-center h-5 px-2 rounded-md border border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 text-[7px] font-black tracking-[0.06em] leading-none whitespace-nowrap text-blue-700 dark:text-blue-300">Filtered View</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5 w-full lg:justify-end">
            <div className="relative flex-1 lg:w-64">
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input type="text" placeholder="Search missions, customer profile, route..." aria-label="Search missions" className="w-full bg-white dark:bg-brand-900 border border-slate-200 dark:border-brand-800 rounded-xl h-10 pl-10 pr-3 text-[10px] md:text-[11px] font-bold uppercase tracking-[0.06em]" value={filterText} onChange={e => setFilterText(e.target.value)} />
            </div>
            <div className="relative">
              <Calendar size={11} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <select value={timeFilter} onChange={e => setTimeFilter(e.target.value as any)} className="appearance-none bg-white dark:bg-brand-900 border border-slate-200 dark:border-brand-800 rounded-xl h-9 pl-7 pr-7 text-[8px] font-black uppercase tracking-[0.08em] outline-none">
                <option value="ALL">Historical</option>
                <option value="TODAY">Immediate</option>
                <option value="UPCOMING">Forecast</option>
                <option value="PAST">Archived</option>
              </select>
              <ChevronDown size={11} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            </div>
          </div>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-1.5 w-full lg:justify-end">
            <Button variant="outline" className="h-9 text-[8px] font-black w-full sm:w-auto sm:shrink-0" onClick={() => handleManifestDownload('FILTERED')}><Download size={13} className="mr-1.5" /> Manifest</Button>
            <Button variant="outline" className="h-9 text-[8px] font-black w-full sm:w-auto sm:shrink-0" onClick={() => handleManifestDownload('ALL')}><Download size={13} className="mr-1.5" /> Manifest (All)</Button>
            {hasActiveFilters && (
              <Button variant="outline" className="h-9 text-[8px] font-black w-full sm:w-auto sm:shrink-0" onClick={clearAllFilters}>Clear Filters</Button>
            )}
          </div>
          </div>
        </div>

        {manifestMessage && (
          <div className={`rounded-xl border px-4 py-3 text-[9px] font-black uppercase tracking-widest ${manifestState === 'DONE' ? 'bg-emerald-50 border-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:border-emerald-800/40 dark:text-emerald-400' : 'bg-red-50 border-red-100 text-red-700 dark:bg-red-900/20 dark:border-red-800/40 dark:text-red-400'}`}>
            {manifestMessage}
          </div>
        )}

        {whatsAppError && (
          <div className="rounded-xl border px-4 py-3 text-[9px] font-black uppercase tracking-widest bg-red-50 border-red-100 text-red-700 dark:bg-red-900/20 dark:border-red-800/40 dark:text-red-400">
            {whatsAppError}
          </div>
        )}

        {/* No Missions Identified State */}
          {activeTrips.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 bg-white dark:bg-brand-900 rounded-[3rem] border border-slate-200 dark:border-brand-800 shadow-sm animate-in fade-in duration-500">
             <div className="w-24 h-24 bg-slate-50 dark:bg-brand-950 rounded-full flex items-center justify-center mb-6">
                <ClipboardX size={48} className="text-slate-300 dark:text-brand-800" />
             </div>
             <h3 className="text-xl font-black text-brand-900 dark:text-white uppercase tracking-tight">No Active Missions</h3>
             <p className="text-[10px] font-black uppercase text-slate-400 tracking-[0.3em] mt-2">Completed missions are auto-archived below</p>
             <Button variant="outline" className="mt-8 h-10 text-[9px]" onClick={clearAllFilters}>Reset Filter Archive</Button>
          </div>
        )}

        {/* Responsive Table/Card Engine */}
        {activeTrips.length > 0 && viewMode === 'TABLE' ? (
          <div className={isTableFullView ? 'fixed top-0 right-0 bottom-0 left-0 z-[9999] bg-slate-50 dark:bg-brand-950 p-0' : ''}>
            {isTableFullView && (
              <div className="px-4 md:px-6 pt-4 md:pt-5 pb-3 flex items-center justify-between border-b border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500 dark:text-slate-300">Mission Log · Full View</p>
                <button
                  type="button"
                  onClick={() => setIsTableFullView(false)}
                  className="h-8 px-3 rounded-lg border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 inline-flex items-center gap-1.5"
                >
                  <Minimize2 size={12} />
                  Exit Full View
                </button>
              </div>
            )}
          <HorizontalScrollArea
            className={`${isTableFullView ? 'block h-[calc(100dvh-4.25rem)] bg-white dark:bg-brand-900 border-t border-slate-200 dark:border-brand-800 shadow-none rounded-none' : 'hidden md:block bg-white dark:bg-brand-900 rounded-[2rem] border border-slate-200 dark:border-brand-800 shadow-xl'}`}
            viewportClassName={isTableFullView ? 'h-full' : 'rounded-[2rem]'}
          >
            <table className="w-full min-w-[760px] text-left border-separate border-spacing-0">
              <thead>
                <tr className="bg-slate-50 dark:bg-brand-950 border-b border-slate-100 dark:border-brand-800">
                  <th className="pl-0 pr-0.5 py-2.5 text-center text-[8px] font-black text-slate-400 uppercase tracking-[0.16em]">ID</th>
                  <th className="w-[78px] pl-0 pr-0 py-2.5 text-[8px] font-black text-slate-400 uppercase tracking-[0.14em]">Date</th>
                  <th className="w-[126px] pl-0 pr-0 py-2.5 text-[8px] font-black text-slate-400 uppercase tracking-[0.14em]">Client</th>
                  <th className="w-[120px] pl-0.5 pr-0.5 py-2.5 text-[8px] font-black text-slate-400 uppercase tracking-[0.14em]">Vector</th>
                  <th className="w-[96px] pl-0.5 pr-0 py-2.5 text-[8px] font-black text-slate-400 uppercase tracking-[0.14em]">Metrics</th>
                  <th className="w-[100px] px-0.5 py-2.5 text-center text-[8px] font-black text-slate-400 uppercase tracking-[0.14em]">Unit</th>
                  <th className="px-0.5 py-2.5 text-[8px] font-black text-slate-400 uppercase tracking-[0.14em]">Comms</th>
                  <th className="sticky right-0 z-20 w-[56px] px-0.5 py-2.5 text-right text-[8px] font-black text-slate-400 uppercase tracking-[0.14em] bg-slate-50 dark:bg-brand-950 border-l border-slate-100 dark:border-brand-800">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-brand-800/50">
                {activeTrips.map(trip => {
                  const driver = drivers.find(d => d.id === trip.driverId);
                  const clientNameParts = trip.customerName
                    .split(' ')
                    .filter(Boolean)
                    .slice(0, 2);
                  const unitNameParts = driver
                    ? driver.name
                        .split(' ')
                        .filter(Boolean)
                        .slice(0, 2)
                    : [];
                  const unitCarModel = driver?.carModel?.trim() || '';
                  const unitFuelTag = driver
                    ? driver.fuelCostResponsibility === 'COMPANY'
                      ? 'Fuel Co'
                      : driver.fuelCostResponsibility === 'DRIVER'
                        ? 'Fuel Drv'
                        : 'Fuel Shr'
                    : '';
                  const unitOwnershipTag = driver
                    ? driver.vehicleOwnership === 'COMPANY_FLEET'
                      ? 'Fleet'
                      : driver.vehicleOwnership === 'OWNER_DRIVER'
                        ? 'Owner'
                        : 'Rental'
                    : '';
                  const tripDate = parseISO(trip.tripDate || trip.createdAt);
                  const indexMarkers = getTripIndexMarkers(trip);
                  const stopPreview = getTripStopPreview(trip);
                  const trafficMetrics = getTripTrafficMetrics(trip);
                  const traffic = describeTraffic(trafficMetrics.trafficIndex);
                  return (
                    <tr key={trip.id} className="hover:bg-slate-50/50 dark:hover:bg-brand-800/20 transition-colors group">
                       <td className="pl-0 pr-0.5 py-3 text-center">
                         <div className="flex flex-col items-center gap-1.5">
                           <div className="flex items-center justify-center space-x-1">
                              <button
                                onClick={() => copyToClipboard(getTripExtractTemplate(trip), 'extract', trip.id)}
                                className={`w-8 h-8 rounded-lg flex items-center justify-center border transition-all ${copiedType === `extract-${trip.id}` ? 'bg-emerald-500 text-white border-emerald-400' : statusConfig[trip.status].className}`}
                                title={copiedType === `extract-${trip.id}` ? 'Extract copied' : 'Copy trip extract'}
                                aria-label={copiedType === `extract-${trip.id}` ? 'Extract copied' : 'Copy trip extract'}
                              >
                                 {copiedType === `extract-${trip.id}` ? <Check size={14}/> : React.createElement(statusConfig[trip.status].icon, { size: 14 })}
                              </button>
                              <button
                                onClick={() => openWhatsAppMessage(settings.operatorWhatsApp, getTripExtractTemplate(trip))}
                                className="w-8 h-8 rounded-lg flex items-center justify-center border border-emerald-200 bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800/50 transition-all"
                                title="Send extract to operator WhatsApp"
                                aria-label="Send extract to operator WhatsApp"
                                disabled={!settings.operatorWhatsApp.trim()}
                              >
                                <MessageCircle size={14} />
                              </button>
                            </div>
                             <span className="text-[10px] font-black text-slate-300 tracking-widest text-center">#{trip.id.toString().slice(-4)}</span>
                         </div>
                      </td>
                       <td className="w-[78px] pl-0 pr-0 py-3 whitespace-nowrap relative overflow-visible">
                          <button
                            type="button"
                            onClick={() => openInlineScheduleEditor(trip)}
                            className={`text-left transition-colors ${inlineScheduleTripId === trip.id ? 'opacity-40 pointer-events-none' : 'hover:text-blue-700 dark:hover:text-blue-300'}`}
                            title="Edit scheduled pickup time"
                            aria-label={`Edit schedule for trip ${trip.id}`}
                          >
                            <div className="text-[10px] font-black text-brand-900 dark:text-white uppercase">{format(tripDate, 'MMM d')}</div>
                            <div className="text-[10px] font-bold text-slate-400 mt-0.5">{format(tripDate, 'h:mm a')}</div>
                          </button>

                         {inlineScheduleTripId === trip.id && (
                          <div className="absolute left-0 top-1/2 -translate-y-1/2 z-30 w-[182px] rounded-lg border border-blue-200 dark:border-blue-900/40 bg-white dark:bg-brand-900 shadow-lg shadow-blue-200/40 dark:shadow-black/30 p-1.5 space-y-1">
                            <input
                              type="datetime-local"
                              value={inlineScheduleDraft}
                              onChange={event => setInlineScheduleDraft(event.target.value)}
                              onKeyDown={event => {
                                if (event.key === 'Enter') {
                                  event.preventDefault();
                                  handleInlineScheduleSave(trip);
                                }

                                if (event.key === 'Escape') {
                                  event.preventDefault();
                                  closeInlineScheduleEditor();
                                }
                              }}
                              className="h-8 w-full rounded-md border border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 px-1.5 text-[8px] font-black text-blue-700 dark:text-blue-300 outline-none"
                              aria-label="Edit scheduled pickup time"
                              autoFocus
                            />
                            <div className="inline-flex items-center justify-end gap-1 w-full">
                              <button
                                type="button"
                                onClick={closeInlineScheduleEditor}
                                className="h-5 px-1.5 rounded-md border border-slate-200 dark:border-brand-700 bg-white dark:bg-brand-900 text-[7px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => handleInlineScheduleSave(trip)}
                                className="h-5 px-1.5 rounded-md border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[7px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300"
                              >
                                Save
                              </button>
                            </div>
                          </div>
                         )}
                      </td>
                       <td className="w-[126px] pl-0 pr-0 py-3 max-w-[126px]">
                         <button
                           type="button"
                           onClick={() => setSnapshotPreviewTrip(trip)}
                           className="inline-flex h-7 max-w-[124px] flex-col justify-center leading-none text-[10px] font-black text-brand-900 dark:text-white uppercase text-left hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
                           title="Open customer snapshot"
                           aria-label={`Open customer snapshot for ${trip.customerName}`}
                         >
                          <span className="truncate max-w-[124px]">{clientNameParts[0] || trip.customerName}</span>
                          <span className="truncate max-w-[124px] mt-0.5">{clientNameParts[1] || ''}</span>
                         </button>
                         <div className="text-[9px] font-bold text-slate-400 mt-0.5 truncate">{trip.customerPhone}</div>
                         {indexMarkers.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {indexMarkers.map(marker => (
                              <span
                                key={`${trip.id}-table-marker-${marker}`}
                                className="inline-flex items-center h-4 px-1.5 rounded-md border border-slate-300 dark:border-brand-700 bg-slate-50 dark:bg-brand-950 text-[7px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300"
                              >
                                {marker}
                              </span>
                            ))}
                          </div>
                         )}
                      </td>
                       <td className="w-[120px] pl-0.5 pr-0.5 py-3 max-w-[120px]">
                         <button
                           type="button"
                           onClick={() => openModal(trip, 'REQUOTE')}
                           className="w-full text-left"
                           title="Open destination override and requote"
                           aria-label={`Open destination override and requote for trip ${trip.id}`}
                         >
                         <div className="flex items-center text-[9px] font-bold text-slate-600 dark:text-slate-300">
                           <MapPin size={10} className="text-gold-600 mr-1 flex-shrink-0" />
                            <span className="truncate">{trip.pickupText.split(',')[0]}</span>
                         </div>
                         <div className="flex items-center text-[9px] font-bold text-slate-400 mt-1 ml-1.5">
                           <Navigation size={10} className="text-blue-500 mr-1 flex-shrink-0" />
                            <span className="truncate">{trip.destinationText.split(',')[0]}</span>
                         </div>
                         {(trip.stops?.length || 0) > 0 && (
                          <div className="mt-1 ml-1.5 space-y-0.5">
                            <p className="text-[8px] font-black uppercase tracking-widest text-amber-600 dark:text-amber-400">
                              {trip.stops!.length} stop(s)
                            </p>
                            {stopPreview && (
                              <p className="text-[8px] font-bold text-slate-500 dark:text-slate-300 truncate max-w-[220px]">
                                {stopPreview}
                              </p>
                            )}
                          </div>
                         )}
                           </button>
                      </td>
                      <td className="w-[96px] pl-0.5 pr-0 py-3 max-w-[96px]">
                         <div className="inline-flex items-center gap-1.5">
                           <div className="text-[10px] font-black text-brand-900 dark:text-white">${trip.fareUsd}</div>
                           <div className="text-[10px] font-black text-brand-900 dark:text-white">+{trafficMetrics.surplusMin}m</div>
                         </div>
                         <div className="mt-0.5 text-[7px] font-bold text-slate-500 dark:text-slate-300 uppercase tracking-[0.06em]">
                           {trip.distanceText} · ETA {trafficMetrics.etaText}
                         </div>
                         <div className="mt-0.5 inline-flex items-center gap-1">
                           <span className={`inline-flex items-center h-3 px-1 rounded border text-[6px] font-black uppercase tracking-[0.06em] border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/20 ${traffic.tone}`}>
                             {traffic.label}
                           </span>
                           <span className="inline-flex items-center h-3 px-1 rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/20 text-[6px] font-black uppercase tracking-[0.06em] text-slate-600 dark:text-slate-300">
                             TI {trafficMetrics.trafficIndex}
                           </span>
                         </div>
                         <div className="mt-1 inline-flex items-center gap-1">
                           <button
                             type="button"
                             disabled={isTripPaymentLocked(trip)}
                             onClick={() => handleTripPaymentModeUpdate(trip)}
                             title={isTripPaymentLocked(trip)
                               ? 'Payment mode locked after receipting'
                               : `Toggle payment mode (${getTripPaymentMode(trip)} → ${getTripPaymentMode(trip) === 'CREDIT' ? 'CASH' : 'CREDIT'})`}
                             className={`inline-flex items-center h-3.5 px-1 rounded-md border text-[6px] font-black uppercase tracking-[0.06em] transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${trip.paymentMode === 'CREDIT' ? 'border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10 hover:bg-blue-100 dark:hover:bg-blue-900/20' : 'border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10 hover:bg-emerald-100 dark:hover:bg-emerald-900/20'}`}
                           >
                             {getTripPaymentMode(trip)}
                           </button>
                           <span className={`inline-flex items-center h-3.5 px-1 rounded-md border text-[6px] font-black uppercase tracking-[0.06em] ${trip.settlementStatus === 'RECEIPTED' ? 'border-indigo-300 text-indigo-700 bg-indigo-50 dark:border-indigo-900/40 dark:text-indigo-300 dark:bg-indigo-900/10' : trip.settlementStatus === 'SETTLED' ? 'border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-900/40 dark:text-amber-300 dark:bg-amber-900/10' : 'border-slate-300 text-slate-600 bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:bg-slate-900/20'}`}>
                             {trip.settlementStatus || 'PENDING'}
                           </span>
                         </div>
                      </td>
                       <td className="w-[100px] px-0.5 py-3 max-w-[100px] text-center">
                         <div className="flex w-full items-center justify-center">
                           {driver ? (
                            <button
                              type="button"
                              onClick={() => setUnitSnapshotDriverId(driver.id)}
                              className="inline-flex w-[90px] flex-col items-center gap-0.5 text-left hover:opacity-85 transition-opacity"
                              title={`Open unit snapshot for ${driver.name}`}
                              aria-label={`Open unit snapshot for ${driver.name}`}
                            >
                              <div className="inline-flex h-7 flex-col justify-center items-center leading-none text-[8px] font-black tracking-[0.06em] text-slate-700 dark:text-slate-200 uppercase">
                                <span className="truncate max-w-[90px]">{unitNameParts[0] || ''}</span>
                                <span className="truncate max-w-[90px] mt-0.5">{unitNameParts[1] || ''}</span>
                              </div>
                              <span className="max-w-[90px] truncate text-[7px] font-bold uppercase tracking-[0.06em] text-slate-500 dark:text-slate-400">
                                {unitCarModel}
                              </span>
                              <div className="inline-flex flex-col items-center gap-0.5">
                                <span className="inline-flex items-center h-3.5 px-1 rounded border border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-900/40 dark:text-amber-300 dark:bg-amber-900/10 text-[7px] font-black uppercase tracking-[0.06em]">
                                  {unitFuelTag}
                                </span>
                                <span className="inline-flex items-center h-3.5 px-1 rounded border border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10 text-[7px] font-black uppercase tracking-[0.06em]">
                                  {unitOwnershipTag}
                                </span>
                              </div>
                            </button>
                           ) : (
                            <div className="inline-flex w-[90px] items-center justify-center">
                              {inlineAssignTripId === trip.id ? (
                                <div className="relative w-[88px]">
                                  <input
                                    autoFocus
                                    value={inlineAssignQuery}
                                    onFocus={() => setShowInlineAssignSuggestions(true)}
                                    onChange={event => {
                                      setInlineAssignQuery(event.target.value);
                                      setShowInlineAssignSuggestions(true);
                                      setInlineAssignHighlightedIndex(0);
                                    }}
                                    onBlur={() => {
                                      setTimeout(() => {
                                        setShowInlineAssignSuggestions(false);
                                        setInlineAssignTripId(null);
                                        setInlineAssignQuery('');
                                        setInlineAssignHighlightedIndex(0);
                                      }, 120);
                                    }}
                                    onKeyDown={event => {
                                      if (event.key === 'Escape') {
                                        setShowInlineAssignSuggestions(false);
                                        setInlineAssignTripId(null);
                                        setInlineAssignQuery('');
                                        setInlineAssignHighlightedIndex(0);
                                      }

                                      if (event.key === 'ArrowDown') {
                                        event.preventDefault();
                                        if (inlineAssignSuggestions.length === 0) return;
                                        setShowInlineAssignSuggestions(true);
                                        setInlineAssignHighlightedIndex(prev =>
                                          prev >= inlineAssignSuggestions.length - 1 ? 0 : prev + 1
                                        );
                                      }

                                      if (event.key === 'ArrowUp') {
                                        event.preventDefault();
                                        if (inlineAssignSuggestions.length === 0) return;
                                        setShowInlineAssignSuggestions(true);
                                        setInlineAssignHighlightedIndex(prev =>
                                          prev <= 0 ? inlineAssignSuggestions.length - 1 : prev - 1
                                        );
                                      }

                                      if (event.key === 'Enter') {
                                        const highlightedSuggestion = inlineAssignSuggestions[inlineAssignHighlightedIndex];
                                        if (highlightedSuggestion) {
                                          event.preventDefault();
                                          handleInlineDriverAssign(trip, highlightedSuggestion.id);
                                          return;
                                        }

                                        if (inlineAssignSuggestions.length === 1) {
                                          event.preventDefault();
                                          handleInlineDriverAssign(trip, inlineAssignSuggestions[0].id);
                                        }
                                      }
                                    }}
                                    placeholder="Find driver"
                                    className="h-7 w-[88px] rounded-md border border-amber-200 dark:border-amber-700/40 bg-amber-50 dark:bg-amber-500/10 text-[7px] font-black tracking-[0.06em] text-amber-700 dark:text-amber-300 px-1 outline-none placeholder:text-amber-500/70 dark:placeholder:text-amber-400/70"
                                    aria-label="Find driver"
                                  />
                                  {showInlineAssignSuggestions && (
                                    <div className="absolute left-0 right-0 top-[calc(100%+2px)] z-30 max-h-28 overflow-y-auto rounded-md border border-amber-200 dark:border-amber-700/40 bg-white dark:bg-brand-900 shadow-lg shadow-amber-200/40 dark:shadow-black/30">
                                      {inlineAssignSuggestions.length > 0 ? (
                                        inlineAssignSuggestions.map(driverOption => (
                                          <button
                                            key={`inline-assign-${trip.id}-${driverOption.id}`}
                                            type="button"
                                            onMouseDown={event => event.preventDefault()}
                                            onMouseEnter={() => setInlineAssignHighlightedIndex(inlineAssignSuggestions.findIndex(candidate => candidate.id === driverOption.id))}
                                            onClick={() => handleInlineDriverAssign(trip, driverOption.id)}
                                            className={`w-full px-1.5 py-1 text-left text-[7px] font-black tracking-[0.06em] text-slate-700 dark:text-slate-200 ${inlineAssignSuggestions[inlineAssignHighlightedIndex]?.id === driverOption.id ? 'bg-amber-50 dark:bg-amber-500/10' : 'hover:bg-amber-50 dark:hover:bg-amber-500/10'}`}
                                          >
                                            <span className="block truncate uppercase">{driverOption.name}</span>
                                            <span className="block truncate text-[6px] font-bold text-slate-500 dark:text-slate-400">{driverOption.plateNumber}</span>
                                          </button>
                                        ))
                                      ) : (
                                        <p className="px-1.5 py-1 text-[7px] font-black uppercase tracking-[0.06em] text-slate-500 dark:text-slate-400">
                                          No drivers
                                        </p>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    closeInlineScheduleEditor();
                                    setInlineAssignTripId(trip.id);
                                    setInlineAssignQuery('');
                                    setShowInlineAssignSuggestions(true);
                                    setInlineAssignHighlightedIndex(0);
                                  }}
                                  className="inline-flex items-center justify-center min-w-7 h-7 px-1 rounded-md border text-[7px] font-black tracking-[0.06em] border-amber-200 text-amber-600 bg-amber-50 hover:bg-amber-100 dark:border-amber-700/40 dark:text-amber-400 dark:bg-amber-500/10 dark:hover:bg-amber-500/20"
                                  title="Assign driver"
                                  aria-label="Assign driver"
                                >
                                  —
                                </button>
                              )}
                            </div>
                           )}
                         </div>
                      </td>
                       <td className="px-0.5 py-3">
                         <div className="flex items-center space-x-1">
                            <MailCheck size={13} className={trip.confirmation_sent_at ? 'text-emerald-500' : 'text-slate-200 dark:text-brand-800'} />
                            <MessageCircle size={13} className={trip.feedback_request_sent_at ? 'text-blue-500' : 'text-slate-200 dark:text-brand-800'} />
                            <HeartHandshake size={13} className={trip.thank_you_sent_at ? 'text-gold-500' : 'text-slate-200 dark:text-brand-800'} />
                         </div>
                      </td>
                       <td className="sticky right-0 z-10 w-[56px] px-0.5 py-3 text-right bg-white dark:bg-brand-900 group-hover:bg-slate-50 dark:group-hover:bg-brand-800 border-l border-slate-100 dark:border-brand-800">
                         <div className="flex items-center justify-end gap-0.5">
                            <button
                              onClick={() => copyToClipboard(getDriverTemplate(trip), 'driver', trip.id)}
                              className={`p-1 rounded-md transition-all ${copiedType === `driver-${trip.id}` ? 'bg-emerald-500 text-white' : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-brand-800'}`}
                              title={copiedType === `driver-${trip.id}` ? 'Driver message copied' : 'Copy driver dispatch message'}
                              aria-label={copiedType === `driver-${trip.id}` ? 'Driver message copied' : 'Copy driver dispatch message'}
                            >
                               {copiedType === `driver-${trip.id}` ? <Check size={13}/> : <Car size={13}/>} 
                            </button>
                            <button
                              onClick={() => openModal(trip)}
                              className={`h-6 w-6 rounded-md border transition-all inline-flex items-center justify-center ${!driver
                                ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-700/40'
                                : 'bg-slate-50 text-brand-900 border-slate-200 dark:bg-brand-950 dark:text-gold-500 dark:border-brand-800'}`}
                              title={!driver ? 'Assign Driver / Edit Trip' : 'Edit Trip'}
                            >
                              <Settings size={11}/>
                            </button>
                         </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </HorizontalScrollArea>
          </div>
        ) : null}

        {/* Card View (Always on Mobile, Toggleable on Desktop) */}
        {activeTrips.length > 0 && (viewMode === 'CARD' || viewMode === 'TABLE') && (
          <div className={`${viewMode === 'TABLE' ? 'md:hidden' : ''} grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pb-4 md:pb-20`}>
            {activeTrips.map(trip => {
              const tripDate = parseISO(trip.tripDate || trip.createdAt);
              const driver = drivers.find(d => d.id === trip.driverId);
              const indexMarkers = getTripIndexMarkers(trip);
              const stopPreview = getTripStopPreview(trip);
              const trafficMetrics = getTripTrafficMetrics(trip);
              const traffic = describeTraffic(trafficMetrics.trafficIndex);
              return (
                <div key={trip.id} className="bg-white dark:bg-brand-900 rounded-[2rem] border border-slate-200 dark:border-brand-800 shadow-sm p-6 hover:shadow-xl transition-all group relative overflow-hidden">
                  {/* Visual Accent */}
                  <div className={`absolute top-0 left-0 w-full h-1 ${trip.status === TripStatus.COMPLETED ? 'bg-emerald-500' : 'bg-gold-500 opacity-20'}`} />
                  
                  <div className="flex justify-between items-start mb-6">
                     <div className="flex items-center space-x-3">
                        <div className="flex items-center space-x-1.5">
                          <button
                            onClick={() => copyToClipboard(getTripExtractTemplate(trip), 'extract', trip.id)}
                            className={`w-10 h-10 rounded-xl flex items-center justify-center border shadow-sm transition-all ${copiedType === `extract-${trip.id}` ? 'bg-emerald-500 text-white border-emerald-400' : statusConfig[trip.status].className}`}
                            title={copiedType === `extract-${trip.id}` ? 'Extract copied' : 'Copy trip extract'}
                            aria-label={copiedType === `extract-${trip.id}` ? 'Extract copied' : 'Copy trip extract'}
                          >
                            {copiedType === `extract-${trip.id}` ? <Check size={18}/> : React.createElement(statusConfig[trip.status].icon, { size: 18 })}
                          </button>
                          <button
                            onClick={() => openWhatsAppMessage(settings.operatorWhatsApp, getTripExtractTemplate(trip))}
                            className="w-10 h-10 rounded-xl flex items-center justify-center border shadow-sm border-emerald-200 bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800/50 transition-all"
                            title="Send extract to operator WhatsApp"
                            aria-label="Send extract to operator WhatsApp"
                            disabled={!settings.operatorWhatsApp.trim()}
                          >
                            <MessageCircle size={18} />
                          </button>
                        </div>
                        <div>
                          <p className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em] mb-0.5">Vector Index</p>
                          <h4 className="text-sm font-black text-brand-900 dark:text-white uppercase leading-none">#{trip.id.toString().slice(-4)}</h4>
                        </div>
                     </div>
                     <div className="text-right relative">
                        <button
                          type="button"
                          onClick={() => openInlineScheduleEditor(trip)}
                          className={`text-right transition-colors ${inlineScheduleTripId === trip.id ? 'opacity-40 pointer-events-none' : 'hover:text-blue-700 dark:hover:text-blue-300'}`}
                          title="Edit scheduled pickup time"
                          aria-label={`Edit schedule for trip ${trip.id}`}
                        >
                          <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">{format(tripDate, 'MMM d')}</p>
                          <p className="text-xs font-black text-brand-900 dark:text-gold-400">{format(tripDate, 'h:mm a')}</p>
                        </button>
                        {inlineScheduleTripId === trip.id && (
                          <div className="absolute right-0 top-[calc(100%+0.35rem)] z-20 w-[188px] rounded-lg border border-blue-200 dark:border-blue-900/40 bg-white dark:bg-brand-900 shadow-lg shadow-blue-200/40 dark:shadow-black/30 p-1.5 space-y-1 text-left">
                            <input
                              type="datetime-local"
                              value={inlineScheduleDraft}
                              onChange={event => setInlineScheduleDraft(event.target.value)}
                              onKeyDown={event => {
                                if (event.key === 'Enter') {
                                  event.preventDefault();
                                  handleInlineScheduleSave(trip);
                                }

                                if (event.key === 'Escape') {
                                  event.preventDefault();
                                  closeInlineScheduleEditor();
                                }
                              }}
                              className="h-8 w-full rounded-md border border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 px-1.5 text-[8px] font-black text-blue-700 dark:text-blue-300 outline-none"
                              aria-label="Edit scheduled pickup time"
                              autoFocus
                            />
                            <div className="inline-flex items-center justify-end gap-1 w-full">
                              <button
                                type="button"
                                onClick={closeInlineScheduleEditor}
                                className="h-5 px-1.5 rounded-md border border-slate-200 dark:border-brand-700 bg-white dark:bg-brand-900 text-[7px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => handleInlineScheduleSave(trip)}
                                className="h-5 px-1.5 rounded-md border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[7px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300"
                              >
                                Save
                              </button>
                            </div>
                          </div>
                        )}
                     </div>
                  </div>

                  <div className="space-y-4 mb-8">
                     <div className="bg-slate-50 dark:bg-brand-950/50 p-4 rounded-2xl border border-slate-100 dark:border-brand-800 space-y-3 relative">
                        <div className="flex items-start space-x-3">
                           <div className="mt-1 w-1.5 h-1.5 rounded-full bg-gold-600 flex-shrink-0" />
                           <p className="text-[10px] font-black text-brand-900 dark:text-slate-300 uppercase leading-tight line-clamp-1">{trip.pickupText.split(',')[0]}</p>
                        </div>
                        <div className="h-4 w-px bg-slate-200 dark:bg-brand-800 ml-[2.5px]" />
                        <div className="flex items-start space-x-3">
                           <div className="mt-1 w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />
                           <p className="text-[10px] font-black text-brand-900 dark:text-slate-300 uppercase leading-tight line-clamp-1">{trip.destinationText.split(',')[0]}</p>
                        </div>
                      {(trip.stops?.length || 0) > 0 && (
                        <div className="pt-1">
                         <p className="text-[8px] font-black uppercase tracking-widest text-amber-600 dark:text-amber-400">{trip.stops!.length} stop(s)</p>
                         {stopPreview && (
                           <p className="text-[8px] font-bold text-slate-500 dark:text-slate-300 mt-0.5 line-clamp-1">{stopPreview}</p>
                         )}
                        </div>
                      )}
                     </div>
                     
                     <div className="flex justify-between items-end bg-white dark:bg-brand-900 px-2">
                        <div>
                           <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Identity</p>
                           <button
                             type="button"
                             onClick={() => setSnapshotPreviewTrip(trip)}
                             className="text-xs font-black text-brand-900 dark:text-white uppercase truncate max-w-[150px] hover:text-blue-700 dark:hover:text-blue-300 transition-colors text-left"
                             title="Open customer snapshot"
                             aria-label={`Open customer snapshot for ${trip.customerName}`}
                           >
                             {trip.customerName}
                           </button>
                           {indexMarkers.length > 0 && (
                             <div className="mt-1.5 flex flex-wrap gap-1">
                               {indexMarkers.map(marker => (
                                 <span
                                   key={`${trip.id}-card-marker-${marker}`}
                                   className="inline-flex items-center h-4 px-1.5 rounded-md border border-slate-300 dark:border-brand-700 bg-slate-50 dark:bg-brand-950 text-[7px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300"
                                 >
                                   {marker}
                                 </span>
                               ))}
                             </div>
                           )}
                        </div>
                        <div className="text-right">
                          <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Traffic / Unit</p>
                          <p className="text-[8px] font-black text-slate-500 dark:text-slate-300 uppercase tracking-widest">ETA {trafficMetrics.etaText}</p>
                          <p className={`text-[8px] font-black uppercase tracking-widest ${traffic.tone}`}>{traffic.label} · TI {trafficMetrics.trafficIndex}</p>
                           {driver ? (
                            <button
                              type="button"
                              onClick={() => setUnitSnapshotDriverId(driver.id)}
                              className="text-xs font-black uppercase text-slate-900 dark:text-slate-300 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
                              title={`Open unit snapshot for ${driver.name}`}
                              aria-label={`Open unit snapshot for ${driver.name}`}
                            >
                              {driver.name.split(' ')[0]}
                            </button>
                           ) : (
                            <p className="text-xs font-black uppercase text-amber-500 animate-pulse">Awaiting</p>
                           )}
                        </div>
                     </div>
                  </div>

                  <div className="flex justify-between items-center pt-6 border-t border-slate-50 dark:border-brand-800">
                     <div className="space-y-1">
                       <div className="flex items-center space-x-2 text-brand-900 dark:text-white">
                          <span className="text-[10px] font-black">$</span>
                          <span className="text-lg font-black tracking-tighter">{trip.fareUsd}</span>
                       </div>
                       <div className="flex flex-wrap gap-1">
                         <button
                           type="button"
                           disabled={isTripPaymentLocked(trip)}
                           onClick={() => handleTripPaymentModeUpdate(trip)}
                           title={isTripPaymentLocked(trip)
                             ? 'Payment mode locked after receipting'
                             : `Toggle payment mode (${getTripPaymentMode(trip)} → ${getTripPaymentMode(trip) === 'CREDIT' ? 'CASH' : 'CREDIT'})`}
                           className={`inline-flex items-center h-4 px-1.5 rounded-md border text-[7px] font-black uppercase tracking-widest transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${trip.paymentMode === 'CREDIT' ? 'border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10 hover:bg-blue-100 dark:hover:bg-blue-900/20' : 'border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10 hover:bg-emerald-100 dark:hover:bg-emerald-900/20'}`}
                         >
                           {getTripPaymentMode(trip)}
                         </button>
                         <span className={`inline-flex items-center h-4 px-1.5 rounded-md border text-[7px] font-black uppercase tracking-widest ${trip.settlementStatus === 'RECEIPTED' ? 'border-indigo-300 text-indigo-700 bg-indigo-50 dark:border-indigo-900/40 dark:text-indigo-300 dark:bg-indigo-900/10' : trip.settlementStatus === 'SETTLED' ? 'border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-900/40 dark:text-amber-300 dark:bg-amber-900/10' : 'border-slate-300 text-slate-600 bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:bg-slate-900/20'}`}>
                           {trip.settlementStatus || 'PENDING'}
                         </span>
                       </div>
                     </div>
                     <div className="flex items-center space-x-2">
                        <button onClick={() => copyToClipboard(getCustomerTemplate(trip), 'customer', trip.id)} className={`p-2.5 rounded-xl transition-all ${copiedType === `customer-${trip.id}` ? 'bg-emerald-500 text-white' : 'bg-slate-50 dark:bg-brand-950 text-slate-400 border border-slate-100 dark:border-white/5'}`}>
                           {copiedType === `customer-${trip.id}` ? <Check size={14}/> : <UserCheck size={14}/>}
                        </button>
                        <button onClick={() => openModal(trip)} className="p-2.5 bg-brand-900 text-gold-400 rounded-xl shadow-lg shadow-brand-900/10 hover:scale-105 active:scale-95 transition-all"><Settings size={18}/></button>
                     </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className={`${completedTripsCollapsed ? 'bg-slate-50/50 dark:bg-brand-950/40 border-slate-200/60 dark:border-brand-800/50 shadow-none' : 'bg-white dark:bg-brand-900 border-slate-200 dark:border-brand-800 shadow-sm'} rounded-[2rem] border ${completedTripsCollapsed ? 'p-2.5 md:p-3' : 'p-6 md:p-8'} space-y-4 transition-colors`}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className={`${completedTripsCollapsed ? 'text-[10px] font-bold text-slate-400 dark:text-slate-500 tracking-wider' : 'text-xl font-black text-brand-900 dark:text-white tracking-tight'} uppercase`}>{completedTripsCollapsed ? 'Completed' : 'Completed Archive'}</h3>
              {!completedTripsCollapsed && (
                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-1">Completed missions leave active board automatically and remain reviewable</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[8px] font-black uppercase tracking-widest ${completedTripsCollapsed ? 'border-transparent bg-transparent text-slate-400/80 dark:text-slate-500/80' : 'border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-slate-500 dark:text-slate-300'}`}>
                <CheckCircle2 size={12} />
                {completedTripsCollapsed ? completedTrips.length : `${completedTrips.length} Archived`}
              </div>
              <button
                type="button"
                onClick={() => setCompletedTripsCollapsed(prev => !prev)}
                className={`h-8 ${completedTripsCollapsed ? 'w-8 px-0 justify-center' : 'px-2.5'} rounded-lg border text-[8px] font-black uppercase tracking-widest inline-flex items-center gap-1 ${completedTripsCollapsed ? 'border-transparent bg-transparent text-slate-400 dark:text-slate-500' : 'border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-slate-600 dark:text-slate-300'}`}
              >
                {completedTripsCollapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
                {!completedTripsCollapsed && 'Minimize'}
              </button>
            </div>
          </div>

          {!completedTripsCollapsed && completedTrips.length === 0 ? (
            <div className="rounded-xl border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 px-4 py-4 text-[9px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">
              No completed trips in this filter window.
            </div>
          ) : !completedTripsCollapsed ? (
            <div className="space-y-3">
              {completedTrips.map(trip => {
                const driver = drivers.find(d => d.id === trip.driverId);
                const completedStamp = parseISO(trip.completedAt || trip.tripDate || trip.createdAt);
                return (
                  <div key={`completed-${trip.id}`} className="rounded-2xl border border-slate-200 dark:border-brand-800 bg-slate-50/80 dark:bg-brand-950 p-4 md:p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-brand-900 dark:text-white">#{trip.id.toString().slice(-4)} · {trip.customerName}</p>
                        <p className="text-[9px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-300 mt-1">{trip.customerPhone} · {driver?.name || 'Unassigned'}</p>
                        <p className="text-[9px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-300 mt-1">{trip.pickupText} → {trip.destinationText}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <p className="text-[8px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">Fare ${trip.fareUsd}</p>
                          <button
                            type="button"
                            disabled={isTripPaymentLocked(trip)}
                            onClick={() => handleTripPaymentModeUpdate(trip)}
                            title={isTripPaymentLocked(trip)
                              ? 'Payment mode locked after receipting'
                              : `Toggle payment mode (${getTripPaymentMode(trip)} → ${getTripPaymentMode(trip) === 'CREDIT' ? 'CASH' : 'CREDIT'})`}
                            className={`inline-flex items-center h-4 px-1.5 rounded-md border text-[7px] font-black uppercase tracking-widest transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${trip.paymentMode === 'CREDIT' ? 'border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10 hover:bg-blue-100 dark:hover:bg-blue-900/20' : 'border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10 hover:bg-emerald-100 dark:hover:bg-emerald-900/20'}`}
                          >
                            {getTripPaymentMode(trip)}
                          </button>
                          <span className={`inline-flex items-center h-4 px-1.5 rounded-md border text-[7px] font-black uppercase tracking-widest ${trip.settlementStatus === 'RECEIPTED' ? 'border-indigo-300 text-indigo-700 bg-indigo-50 dark:border-indigo-900/40 dark:text-indigo-300 dark:bg-indigo-900/10' : trip.settlementStatus === 'SETTLED' ? 'border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-900/40 dark:text-amber-300 dark:bg-amber-900/10' : 'border-slate-300 text-slate-600 bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:bg-slate-900/20'}`}>
                            {trip.settlementStatus || 'PENDING'}
                          </span>
                        </div>
                      </div>
                      <div className="text-right">
                        <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-400">
                          <CheckCircle2 size={10} /> Completed
                        </span>
                        <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 mt-2">{Number.isNaN(completedStamp.getTime()) ? (trip.completedAt || trip.tripDate || trip.createdAt) : format(completedStamp, 'MMM d, h:mm a')}</p>
                        <div className="mt-2 flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => openModal(trip)}
                            className="h-7 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-900 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300"
                          >
                            View
                          </button>
                          <button
                            type="button"
                            onClick={() => handleReopenCompletedTrip(trip)}
                            className="h-7 px-2 rounded-md border border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 text-[8px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300"
                          >
                            Reopen
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className={`${deletedTripsCollapsed ? 'bg-slate-50/50 dark:bg-brand-950/40 border-slate-200/60 dark:border-brand-800/50 shadow-none' : 'bg-white dark:bg-brand-900 border-slate-200 dark:border-brand-800 shadow-sm'} rounded-[2rem] border ${deletedTripsCollapsed ? 'p-2.5 md:p-3' : 'p-6 md:p-8'} space-y-4 transition-colors`}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className={`${deletedTripsCollapsed ? 'text-[10px] font-bold text-slate-400 dark:text-slate-500 tracking-wider' : 'text-xl font-black text-brand-900 dark:text-white tracking-tight'} uppercase`}>{deletedTripsCollapsed ? 'Deleted' : 'Deleted Trips'}</h3>
              {!deletedTripsCollapsed && (
                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-1">Cancelled trips removed from active log and archived</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[8px] font-black uppercase tracking-widest ${deletedTripsCollapsed ? 'border-transparent bg-transparent text-slate-400/80 dark:text-slate-500/80' : 'border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-slate-500 dark:text-slate-300'}`}>
                <Archive size={12} />
                {deletedTripsCollapsed ? filteredDeletedTrips.length : `${filteredDeletedTrips.length} Archived`}
              </div>
              <button
                type="button"
                onClick={() => setDeletedTripsCollapsed(prev => !prev)}
                className={`h-8 ${deletedTripsCollapsed ? 'w-8 px-0 justify-center' : 'px-2.5'} rounded-lg border text-[8px] font-black uppercase tracking-widest inline-flex items-center gap-1 ${deletedTripsCollapsed ? 'border-transparent bg-transparent text-slate-400 dark:text-slate-500' : 'border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-slate-600 dark:text-slate-300'}`}
              >
                {deletedTripsCollapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
                {!deletedTripsCollapsed && 'Minimize'}
              </button>
            </div>
          </div>

          {!deletedTripsCollapsed && filteredDeletedTrips.length === 0 ? (
            <div className="rounded-xl border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 px-4 py-4 text-[9px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">
              No deleted cancelled trips in this filter window.
            </div>
          ) : !deletedTripsCollapsed ? (
            <div className="space-y-3">
              {filteredDeletedTrips.map(record => {
                const archivedTrip = record.trip;
                const driver = drivers.find(d => d.id === archivedTrip.driverId);
                const archivedAt = parseISO(record.deletedAt);
                return (
                  <div key={record.archiveId} className="rounded-2xl border border-slate-200 dark:border-brand-800 bg-slate-50/80 dark:bg-brand-950 p-4 md:p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-brand-900 dark:text-white">#{archivedTrip.id.toString().slice(-4)} · {archivedTrip.customerName}</p>
                        <p className="text-[9px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-300 mt-1">{archivedTrip.customerPhone} · {driver?.name || 'Unassigned'}</p>
                        <p className="text-[9px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-300 mt-1">{archivedTrip.pickupText} → {archivedTrip.destinationText}</p>
                        {(archivedTrip.stops?.length || 0) > 0 && (
                          <p className="text-[8px] font-black uppercase tracking-widest text-amber-600 dark:text-amber-400 mt-1">{archivedTrip.stops!.length} stop(s)</p>
                        )}
                      </div>
                      <div className="text-right">
                        <span className="inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-800/50 bg-red-50 dark:bg-red-900/20 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest text-red-700 dark:text-red-400">
                          <Trash2 size={10} /> Deleted
                        </span>
                        <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 mt-2">{Number.isNaN(archivedAt.getTime()) ? record.deletedAt : format(archivedAt, 'MMM d, h:mm a')}</p>
                        <button
                          type="button"
                          onClick={() => handleRestoreDeletedTrip(record.archiveId, `#${archivedTrip.id.toString().slice(-4)}`)}
                          className="mt-2 h-7 px-2 rounded-md border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[8px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300"
                        >
                          Restore
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>

      {snapshotPreviewTrip && (
        <div
          className="fixed inset-0 z-[95] bg-brand-950/55 backdrop-blur-sm p-3 md:p-4 flex items-center justify-center"
          onClick={() => setSnapshotPreviewTrip(null)}
        >
          <div
            className="w-full max-w-xl rounded-[1.75rem] border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 shadow-2xl overflow-hidden"
            onClick={event => event.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 flex items-center justify-between">
              <div>
                <p className="text-[8px] font-black uppercase tracking-[0.18em] text-slate-400">Customer Snapshot</p>
                <p className="text-[11px] font-black uppercase tracking-tight text-brand-900 dark:text-white mt-1">{snapshotPreviewTrip.customerName}</p>
                <p className="text-[8px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-300 mt-0.5">{snapshotPreviewTrip.customerPhone}</p>
              </div>
              <button
                type="button"
                onClick={() => setSnapshotPreviewTrip(null)}
                className="h-8 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300"
              >
                Close
              </button>
            </div>
            <div className="p-4 max-h-[70vh] overflow-y-auto">
              {snapshotPreviewData ? (
                <CustomerSnapshotCard snapshot={snapshotPreviewData} />
              ) : (
                <div className="rounded-xl border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 px-4 py-3 text-[9px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">
                  Snapshot unavailable for this customer.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {unitSnapshotDriver && unitSnapshotMetrics && (
        <div
          className="fixed inset-0 z-[95] bg-brand-950/55 backdrop-blur-sm p-3 md:p-4 flex items-center justify-center"
          onClick={() => setUnitSnapshotDriverId(null)}
        >
          <div
            className="w-full max-w-xl rounded-[1.75rem] border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 shadow-2xl overflow-hidden"
            onClick={event => event.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 flex items-center justify-between">
              <div>
                <p className="text-[8px] font-black uppercase tracking-[0.18em] text-slate-400">Unit Snapshot</p>
                <p className="text-[11px] font-black uppercase tracking-tight text-brand-900 dark:text-white mt-1">{unitSnapshotDriver.name}</p>
                <p className="text-[8px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-300 mt-0.5">{unitSnapshotDriver.carModel} · {unitSnapshotDriver.plateNumber}</p>
              </div>
              <button
                type="button"
                onClick={() => setUnitSnapshotDriverId(null)}
                className="h-8 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300"
              >
                Close
              </button>
            </div>
            <div className="p-4 max-h-[70vh] overflow-y-auto">
              <UnitSnapshotCard driver={unitSnapshotDriver} metrics={unitSnapshotMetrics} />
            </div>
          </div>
        </div>
      )}

      {isModalOpen && selectedTrip && (
         <TripUpdateModal 
            trip={selectedTrip} 
            drivers={activeDrivers} 
            onClose={() => {
              setIsModalOpen(false);
              setModalFocusTarget('DEFAULT');
            }}
            onSave={handleCommitPhase}
            onCopy={copyToClipboard}
            onWhatsApp={openWhatsAppMessage}
            customerPhone={selectedTrip.customerPhone}
          operatorPhone={settings.operatorWhatsApp}
            buildDriverTemplate={getDriverTemplate}
            buildCustomerTemplate={getCustomerTemplate}
          buildOperatorTemplate={getTripExtractTemplate}
            copiedType={copiedType}
            customerSnapshot={selectedTripSnapshot || undefined}
            mapsApiKey={settings.googleMapsApiKey}
            onAssignLocation={handleAssignLocationFromTrip}
            onSetCustomerPriority={handleSetCustomerPriorityFromTrip}
            onRequoteDestination={handleRequoteDestination}
            onApplyRequote={handleApplyRequote}
            onDeleteCancelled={handleDeleteCancelled}
            initialFocusTarget={modalFocusTarget}
         />
      )}

      {messagingContext && (
        <MessageModal 
          isOpen={true}
          onClose={() => setMessagingContext(null)}
          title={messagingContext.type === 'FEEDBACK_REQ' ? "Request Customer Feedback" : "Send Thank-You Message"}
          recipientPhone={messagingContext.trip.customerPhone}
          operatorPhone={settings.operatorWhatsApp}
          customerSnapshot={messagingSnapshot || undefined}
          initialMessage={messagingInitialMessage}
          onMarkSent={(finalMsg) => {
            const field = messagingContext.type === 'FEEDBACK_REQ' ? 'feedback_request_sent_at' : 'thank_you_sent_at';
            updateFullTrip({ ...messagingContext.trip, [field]: new Date().toISOString() });
            setMessagingContext(null);
          }}
        />
      )}

      {actionToast && (
        <div className={`fixed bottom-4 right-4 z-[120] rounded-xl border px-4 py-2.5 text-[9px] font-black uppercase tracking-widest shadow-xl ${actionToast.tone === 'SUCCESS' ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-900/25 dark:border-emerald-800/40 dark:text-emerald-300' : 'bg-red-50 border-red-200 text-red-700 dark:bg-red-900/25 dark:border-red-800/40 dark:text-red-300'}`}>
          {actionToast.message}
        </div>
      )}
    </div>
  );
};

const TripUpdateModal: React.FC<{ 
  trip: Trip; 
  drivers: Driver[]; 
  initialFocusTarget?: TripModalFocusTarget;
  onClose: () => void;
  onSave: (trip: Trip) => void;
  onCopy: (text: string, type: string, id: number) => void;
  onWhatsApp: (phone: string | undefined, text: string) => void;
  customerPhone?: string;
  operatorPhone?: string;
  mapsApiKey: string;
  buildDriverTemplate: (trip: Trip) => string;
  buildCustomerTemplate: (trip: Trip) => string;
  buildOperatorTemplate: (trip: Trip) => string;
  copiedType: string | null;
  customerSnapshot?: CustomerSnapshot;
  onAssignLocation: (trip: Trip, target: 'HOME' | 'BUSINESS' | 'FREQUENT' | 'SMART_PICKUP', source: 'PICKUP' | 'DROPOFF') => string;
  onSetCustomerPriority: (trip: Trip, tier: 'VIP' | 'VVIP') => string;
  onRequoteDestination: (trip: Trip, destinationInput: string, stopInputs: string[]) => Promise<{ ok: true; updatedTrip: Trip } | { ok: false; reason: string }>;
  onApplyRequote: (trip: Trip) => void;
  onDeleteCancelled: (trip: Trip) => void;
}> = ({ trip, drivers, initialFocusTarget = 'DEFAULT', onClose, onSave, onCopy, onWhatsApp, customerPhone, operatorPhone, mapsApiKey, buildDriverTemplate, buildCustomerTemplate, buildOperatorTemplate, copiedType, customerSnapshot, onAssignLocation, onSetCustomerPriority, onRequoteDestination, onApplyRequote, onDeleteCancelled }) => {
  const [status, setStatus] = useState<TripStatus>(trip.status);
  const [driverId, setDriverId] = useState<string>(trip.driverId || '');
  const [driverSearchQuery, setDriverSearchQuery] = useState('');
  const [showDriverSuggestions, setShowDriverSuggestions] = useState(false);
  const [paymentMode, setPaymentMode] = useState<TripPaymentMode>(trip.paymentMode === 'CREDIT' ? 'CREDIT' : 'CASH');
  const [settlementStatus, setSettlementStatus] = useState<TripSettlementStatus>(trip.settlementStatus || 'PENDING');
  const [notes, setNotes] = useState<string>(trip.notes || '');
  const [rating, setRating] = useState<number | undefined>(trip.rating);
  const [feedback, setFeedback] = useState<string>(trip.feedback || '');
  const [locationActionMessage, setLocationActionMessage] = useState('');
  const [priorityActionMessage, setPriorityActionMessage] = useState('');
  const [destinationDraft, setDestinationDraft] = useState<string>(trip.destinationOriginalLink || trip.destinationText);
  const [destinationCandidate, setDestinationCandidate] = useState<TripStop | null>(() => {
    if (Number.isFinite(trip.destLat) && Number.isFinite(trip.destLng)) {
      return {
        text: trip.destinationText,
        placeId: trip.destinationPlaceId || 'GEOCODED_DESTINATION',
        originalLink: trip.destinationOriginalLink,
        lat: Number(trip.destLat),
        lng: Number(trip.destLng),
      };
    }
    return null;
  });
  const [stopsDraft, setStopsDraft] = useState<string[]>((trip.stops || []).map(stop => stop.originalLink || stop.text).filter(Boolean));
  const [stopCandidates, setStopCandidates] = useState<Array<TripStop | null>>((trip.stops || []).map(stop => ({ ...stop })));
  const [quotePatch, setQuotePatch] = useState<Partial<Trip>>({});
  const [requoteMessage, setRequoteMessage] = useState('');
  const [requoteBusy, setRequoteBusy] = useState(false);
  const destinationInputRef = useRef<HTMLInputElement>(null);
  const requoteSectionRef = useRef<HTMLDivElement>(null);
  const stopInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const driverSearchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialFocusTarget !== 'REQUOTE') return;

    const timerId = window.setTimeout(() => {
      requoteSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      destinationInputRef.current?.focus();
      destinationInputRef.current?.select();
    }, 120);

    return () => window.clearTimeout(timerId);
  }, [initialFocusTarget, trip.id]);

  useEffect(() => {
    setStatus(trip.status);
    setDriverId(trip.driverId || '');
    setPaymentMode(trip.paymentMode === 'CREDIT' ? 'CREDIT' : 'CASH');
    setSettlementStatus(trip.settlementStatus || 'PENDING');
    setNotes(trip.notes || '');
    setRating(trip.rating);
    setFeedback(trip.feedback || '');
    setDestinationDraft(trip.destinationOriginalLink || trip.destinationText);
    setDestinationCandidate(
      Number.isFinite(trip.destLat) && Number.isFinite(trip.destLng)
        ? {
            text: trip.destinationText,
            placeId: trip.destinationPlaceId || 'GEOCODED_DESTINATION',
            originalLink: trip.destinationOriginalLink,
            lat: Number(trip.destLat),
            lng: Number(trip.destLng),
          }
        : null
    );
    setStopsDraft((trip.stops || []).map(stop => stop.originalLink || stop.text).filter(Boolean));
    setStopCandidates((trip.stops || []).map(stop => ({ ...stop })));
    setQuotePatch({});
    setRequoteMessage('');
    setLocationActionMessage('');
    setPriorityActionMessage('');
    setRequoteBusy(false);
  }, [trip]);

  const recommendedDrivers = useMemo(() => {
    return [...drivers]
      .sort((a, b) => {
        const availabilityDelta = (a.currentStatus === 'AVAILABLE' ? 1 : 0) - (b.currentStatus === 'AVAILABLE' ? 1 : 0);
        if (availabilityDelta !== 0) return -availabilityDelta;
        const assignedDelta = Number(b.id === (driverId || trip.driverId || '')) - Number(a.id === (driverId || trip.driverId || ''));
        if (assignedDelta !== 0) return assignedDelta;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 5);
  }, [drivers, driverId, trip.driverId]);

  const driverSuggestions = useMemo(() => {
    const query = driverSearchQuery.trim().toLowerCase();
    const source = query
      ? drivers.filter(driver => (
          driver.name.toLowerCase().includes(query) ||
          driver.plateNumber.toLowerCase().includes(query) ||
          driver.currentStatus.toLowerCase().includes(query)
        ))
      : drivers;

    return [...source]
      .sort((a, b) => {
        const aAssigned = a.id === (driverId || trip.driverId || '');
        const bAssigned = b.id === (driverId || trip.driverId || '');
        if (aAssigned !== bAssigned) return Number(bAssigned) - Number(aAssigned);
        if (a.currentStatus !== b.currentStatus) {
          if (a.currentStatus === 'AVAILABLE') return -1;
          if (b.currentStatus === 'AVAILABLE') return 1;
        }
        return a.name.localeCompare(b.name);
      })
      .slice(0, 10);
  }, [drivers, driverSearchQuery, driverId, trip.driverId]);

  useEffect(() => {
    const selectedDriver = drivers.find(d => d.id === driverId);
    if (!selectedDriver) {
      setDriverSearchQuery('');
      return;
    }
    setDriverSearchQuery(`${selectedDriver.name} (${selectedDriver.plateNumber})`);
  }, [driverId, drivers]);

  const handleSelectDriverSuggestion = (driver: Driver) => {
    setDriverId(driver.id);
    setDriverSearchQuery(`${driver.name} (${driver.plateNumber})`);
    setShowDriverSuggestions(false);
  };

  const liveTrip: Trip = {
    ...trip,
    ...quotePatch,
    status,
    driverId: driverId || undefined,
    paymentMode,
    settlementStatus,
    notes,
    rating,
    feedback,
  };

  const minimumFareInfo = useMemo(() => {
    const minimumFareUsd = Math.max(0, MIN_RIDE_FARE_USD);
    const distanceKm = Number.isFinite(liveTrip.distanceKm) ? liveTrip.distanceKm : 0;
    const distanceFactor = liveTrip.isRoundTrip ? 2 : 1;
    const ratePerKm = Number.isFinite(liveTrip.ratePerKmSnapshot) ? liveTrip.ratePerKmSnapshot : 0;
    const waitTimeHours = Number.isFinite(liveTrip.waitTimeHours) ? liveTrip.waitTimeHours : 0;
    const hourlyWaitRate = Number.isFinite(liveTrip.hourlyWaitRateSnapshot) ? liveTrip.hourlyWaitRateSnapshot : 0;
    const computedFareUsd = Math.ceil(distanceKm * distanceFactor * ratePerKm) + Math.ceil(waitTimeHours * hourlyWaitRate);
    const minimumFareApplied = computedFareUsd > 0 && computedFareUsd < minimumFareUsd && liveTrip.fareUsd === minimumFareUsd;

    return {
      minimumFareUsd,
      minimumFareApplied,
    };
  }, [
    liveTrip.distanceKm,
    liveTrip.isRoundTrip,
    liveTrip.ratePerKmSnapshot,
    liveTrip.waitTimeHours,
    liveTrip.hourlyWaitRateSnapshot,
    liveTrip.fareUsd,
  ]);

  const driverPhone = drivers.find(d => d.id === driverId)?.phone;
  const driverTemplate = buildDriverTemplate(liveTrip);
  const customerTemplate = buildCustomerTemplate(liveTrip);
  const operatorTemplate = buildOperatorTemplate(liveTrip);

  const runAssignLocation = (target: 'HOME' | 'BUSINESS' | 'FREQUENT' | 'SMART_PICKUP', source: 'PICKUP' | 'DROPOFF') => {
    const response = onAssignLocation(trip, target, source);
    setLocationActionMessage(response);
    window.setTimeout(() => setLocationActionMessage(''), 2200);
  };

  const runSetPriority = (tier: 'VIP' | 'VVIP') => {
    const response = onSetCustomerPriority(trip, tier);
    setPriorityActionMessage(response);
    window.setTimeout(() => setPriorityActionMessage(''), 2200);
  };

  const handleRequote = async () => {
    const candidateDestinationText = destinationDraft.trim();
    const isValidDestinationCandidate = Boolean(
      destinationCandidate &&
      Number.isFinite(destinationCandidate.lat) &&
      Number.isFinite(destinationCandidate.lng) &&
      destinationCandidate.text.trim().toLowerCase() === candidateDestinationText.toLowerCase()
    );

    const candidateDestination = isValidDestinationCandidate
      ? `${Number(destinationCandidate!.lat).toFixed(6)},${Number(destinationCandidate!.lng).toFixed(6)}`
      : candidateDestinationText;

    const normalizedResolvedStops: TripStop[] = [];
    for (let index = 0; index < stopsDraft.length; index += 1) {
      const stopText = stopsDraft[index].trim();
      if (!stopText) continue;
      const candidate = stopCandidates[index];
      const isValidCandidate = Boolean(
        candidate &&
        Number.isFinite(candidate.lat) &&
        Number.isFinite(candidate.lng) &&
        candidate.text.trim().toLowerCase() === stopText.toLowerCase()
      );
      if (!isValidCandidate) {
        setRequoteMessage(`Select stop ${index + 1} from autocomplete before requote.`);
        return;
      }
      normalizedResolvedStops.push(candidate as TripStop);
    }

    const stopInputsForRequote = normalizedResolvedStops.map(stop => `${Number(stop.lat).toFixed(6)},${Number(stop.lng).toFixed(6)}`);

    setRequoteBusy(true);
    const result = await onRequoteDestination(liveTrip, candidateDestination, stopInputsForRequote);
    setRequoteBusy(false);

    if (!result.ok) {
      setRequoteMessage(result.reason);
      return;
    }

    setQuotePatch(result.updatedTrip);
    onApplyRequote(result.updatedTrip);
    setDestinationDraft(result.updatedTrip.destinationOriginalLink || result.updatedTrip.destinationText);
    setDestinationCandidate(
      Number.isFinite(result.updatedTrip.destLat) && Number.isFinite(result.updatedTrip.destLng)
        ? {
            text: result.updatedTrip.destinationText,
            placeId: result.updatedTrip.destinationPlaceId || 'GEOCODED_DESTINATION',
            originalLink: result.updatedTrip.destinationOriginalLink,
            lat: Number(result.updatedTrip.destLat),
            lng: Number(result.updatedTrip.destLng),
          }
        : null
    );
    setStopsDraft((result.updatedTrip.stops || []).map(stop => stop.originalLink || stop.text).filter(Boolean));
    setStopCandidates((result.updatedTrip.stops || []).map(stop => ({ ...stop })));
    const minimumFareUsd = Math.max(0, MIN_RIDE_FARE_USD);
    const requoteComputedFareUsd = Math.ceil(result.updatedTrip.distanceKm * (result.updatedTrip.isRoundTrip ? 2 : 1) * result.updatedTrip.ratePerKmSnapshot)
      + Math.ceil(result.updatedTrip.waitTimeHours * result.updatedTrip.hourlyWaitRateSnapshot);
    const minimumFareApplied = requoteComputedFareUsd > 0 && requoteComputedFareUsd < minimumFareUsd && result.updatedTrip.fareUsd === minimumFareUsd;
    setRequoteMessage(
      minimumFareApplied
        ? `New quote ready: $${result.updatedTrip.fareUsd} · ${result.updatedTrip.distanceText} · ${result.updatedTrip.stops?.length || 0} stop(s) · minimum fare applied ($${minimumFareUsd})`
        : `New quote ready: $${result.updatedTrip.fareUsd} · ${result.updatedTrip.distanceText} · ${result.updatedTrip.stops?.length || 0} stop(s)`
    );
  };

  const addStopField = () => {
    setStopsDraft(prev => [...prev, '']);
    setStopCandidates(prev => [...prev, null]);
  };

  const removeStopField = (index: number) => {
    setStopsDraft(prev => prev.filter((_, i) => i !== index));
    setStopCandidates(prev => prev.filter((_, i) => i !== index));
  };

  const updateStopField = (index: number, value: string) => {
    setStopsDraft(prev => prev.map((entry, i) => i === index ? value : entry));
    setStopCandidates(prev => prev.map((entry, i) => {
      if (i !== index) return entry;
      if (!entry) return null;
      return entry.text.trim().toLowerCase() === value.trim().toLowerCase() ? entry : null;
    }));
  };

  const hasPendingStopChanges = useMemo(() => {
    const draftStops = stopsDraft.map(value => value.trim()).filter(Boolean);
    const currentStops = (liveTrip.stops || []).map(stop => (stop.originalLink || stop.text || '').trim()).filter(Boolean);
    if (draftStops.length !== currentStops.length) return true;
    for (let index = 0; index < draftStops.length; index += 1) {
      if (draftStops[index].toLowerCase() !== currentStops[index].toLowerCase()) {
        return true;
      }
    }
    return false;
  }, [stopsDraft, liveTrip.stops]);

  const handleCommitPhase = () => {
    if (hasPendingStopChanges) {
      setRequoteMessage('Requote after editing stops before committing the mission.');
      return;
    }
    onSave(liveTrip);
  };

  return (
    <div className="fixed inset-0 bg-brand-950/90 backdrop-blur-md z-[100] flex items-center justify-center p-3 md:p-4 overflow-y-auto">
      <div className="bg-white dark:bg-brand-900 rounded-[2rem] md:rounded-[2.5rem] shadow-2xl w-full max-w-lg max-h-[calc(100dvh-1.5rem)] md:max-h-[calc(100dvh-2rem)] overflow-hidden border border-slate-200 dark:border-brand-800 animate-in zoom-in-95 duration-300 flex flex-col">
        <div className="px-8 py-6 bg-slate-50 dark:bg-brand-950 border-b dark:border-brand-800 flex justify-between items-center">
          <div><h3 className="font-black text-brand-900 dark:text-slate-100 uppercase tracking-tight text-lg">Mission Command</h3><p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">Vector Index #{trip.id}</p></div>
          <button onClick={onClose} className="p-2 text-slate-400 hover:text-red-500 transition-colors"><X size={28}/></button>
        </div>
        <div className="p-6 md:p-8 space-y-6 overflow-y-auto scrollbar-hide min-h-0 flex-1 pb-[calc(1.5rem+env(safe-area-inset-bottom))] md:pb-8">
          {customerSnapshot && <CustomerSnapshotCard snapshot={customerSnapshot} />}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
             <div><label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-2 px-1">Phase Status</label><select value={status} onChange={e => setStatus(e.target.value as TripStatus)} className="w-full border border-slate-200 dark:border-brand-800 rounded-xl h-12 px-4 bg-slate-50 dark:bg-brand-950 text-brand-900 dark:text-white text-[11px] font-black uppercase outline-none focus:ring-2 focus:ring-gold-500 transition-all">
               {Object.values(TripStatus).map(s => <option key={s} value={s} className="text-brand-900">{s}</option>)}
             </select></div>
             <div>
               <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-2 px-1">Active Unit</label>
               <div className="relative">
                 <input
                   ref={driverSearchInputRef}
                   value={driverSearchQuery}
                   onFocus={() => setShowDriverSuggestions(true)}
                   onClick={() => {
                     const isAlreadyFocused = driverSearchInputRef.current === document.activeElement;
                     if (isAlreadyFocused && showDriverSuggestions) {
                       setShowDriverSuggestions(false);
                       return;
                     }
                     setShowDriverSuggestions(true);
                   }}
                   onBlur={() => setTimeout(() => setShowDriverSuggestions(false), 120)}
                   onChange={event => {
                     setDriverSearchQuery(event.target.value);
                     setShowDriverSuggestions(true);
                     if (driverId) setDriverId('');
                   }}
                   placeholder="Assign unit (type name/plate/status)"
                   className="w-full border border-slate-200 dark:border-brand-800 rounded-xl h-12 pl-4 pr-10 bg-slate-50 dark:bg-brand-950 text-brand-900 dark:text-white text-[10px] font-black uppercase outline-none focus:ring-2 focus:ring-gold-500 transition-all"
                 />
                 {driverSearchQuery.trim().length > 0 && (
                   <button
                     type="button"
                     onMouseDown={event => event.preventDefault()}
                     onClick={() => {
                       setDriverSearchQuery('');
                       setDriverId('');
                       setShowDriverSuggestions(false);
                     }}
                     className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-md border border-slate-200 dark:border-brand-700 bg-white dark:bg-brand-900 text-slate-500 dark:text-slate-300 inline-flex items-center justify-center"
                     title="Clear assigned unit"
                     aria-label="Clear assigned unit"
                   >
                     <X size={11} />
                   </button>
                 )}

                 {showDriverSuggestions && (
                   <div className="absolute left-0 right-0 top-[calc(100%+0.35rem)] z-30 rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 shadow-xl max-h-64 overflow-y-auto">
                     {!driverSearchQuery.trim() && recommendedDrivers.length > 0 && (
                       <div className="px-2.5 pt-2 pb-1 border-b border-slate-100 dark:border-brand-800">
                         <p className="text-[7px] font-black uppercase tracking-widest text-slate-400">Recommended</p>
                         <div className="mt-1 grid grid-cols-1 gap-1">
                           {recommendedDrivers.map(driver => (
                             <button
                               key={`modal-recommended-${driver.id}`}
                               type="button"
                               onMouseDown={event => event.preventDefault()}
                               onClick={() => handleSelectDriverSuggestion(driver)}
                               className="h-7 px-2 rounded-lg border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[8px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300 inline-flex items-center justify-between"
                             >
                               <span className="truncate">{driver.name} ({driver.plateNumber})</span>
                               <span className="ml-2 text-[7px]">{driver.currentStatus}</span>
                             </button>
                           ))}
                         </div>
                       </div>
                     )}
                     <div className="p-2 space-y-1">
                       <button
                         type="button"
                         onMouseDown={event => event.preventDefault()}
                         onClick={() => {
                           setDriverId('');
                           setDriverSearchQuery('');
                           setShowDriverSuggestions(false);
                         }}
                         className="w-full h-8 px-2 rounded-lg border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 inline-flex items-center"
                       >
                         Unassigned
                       </button>
                       {driverSuggestions.length > 0 ? driverSuggestions.map(driver => (
                         <button
                           key={`modal-suggestion-${driver.id}`}
                           type="button"
                           onMouseDown={event => event.preventDefault()}
                           onClick={() => handleSelectDriverSuggestion(driver)}
                           className="w-full h-8 px-2 rounded-lg border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-[8px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-200 inline-flex items-center justify-between"
                         >
                           <span className="truncate">{driver.name} ({driver.plateNumber})</span>
                           <span className="ml-2 text-[7px] text-slate-500 dark:text-slate-300">{driver.currentStatus}</span>
                         </button>
                       )) : (
                         <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 px-1 py-2">No matching units</p>
                       )}
                     </div>
                   </div>
                 )}
               </div>
             </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
            <div>
              <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-2 px-1">Payment Mode</label>
              <select value={paymentMode} onChange={e => setPaymentMode(e.target.value as TripPaymentMode)} className="w-full border border-slate-200 dark:border-brand-800 rounded-xl h-12 px-4 bg-slate-50 dark:bg-brand-950 text-brand-900 dark:text-white text-[11px] font-black uppercase outline-none focus:ring-2 focus:ring-gold-500 transition-all">
                <option value="CASH" className="text-brand-900">Cash</option>
                <option value="CREDIT" className="text-brand-900">Credit</option>
              </select>
            </div>
            <div>
              <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-2 px-1">Settlement</label>
              <select value={settlementStatus} onChange={e => setSettlementStatus(e.target.value as TripSettlementStatus)} className="w-full border border-slate-200 dark:border-brand-800 rounded-xl h-12 px-4 bg-slate-50 dark:bg-brand-950 text-brand-900 dark:text-white text-[11px] font-black uppercase outline-none focus:ring-2 focus:ring-gold-500 transition-all">
                <option value="PENDING" className="text-brand-900">Pending</option>
                <option value="SETTLED" className="text-brand-900">Settled</option>
                <option value="RECEIPTED" className="text-brand-900">Receipted</option>
              </select>
            </div>
          </div>

          <div ref={requoteSectionRef} className="pt-4 border-t border-slate-100 dark:border-brand-800 space-y-3">
            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block px-1">Destination Override + Requote</label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                ref={destinationInputRef}
                value={destinationDraft}
                onChange={event => {
                  const nextValue = event.target.value;
                  setDestinationDraft(nextValue);
                  setDestinationCandidate(prev => {
                    if (!prev) return null;
                    return prev.text.trim().toLowerCase() === nextValue.trim().toLowerCase() ? prev : null;
                  });
                }}
                onBlur={event => {
                  const trimmed = event.currentTarget.value.trim();
                  setDestinationDraft(trimmed);
                  setDestinationCandidate(prev => {
                    if (!prev) return null;
                    return prev.text.trim().toLowerCase() === trimmed.toLowerCase() ? prev : null;
                  });
                }}
                placeholder="New destination address or Google Maps link"
                className="flex-1 h-11 rounded-xl border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 px-3 text-[10px] font-bold uppercase tracking-wide outline-none focus:ring-2 focus:ring-gold-500"
              />
              <Button onClick={handleRequote} disabled={requoteBusy} className="h-11 sm:px-5 text-[9px]">
                {requoteBusy ? 'Requoting...' : 'Requote'}
              </Button>
            </div>
            <div className="space-y-2 rounded-xl border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 p-3">
              <div className="flex items-center justify-between">
                <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Stops (Optional)</p>
                <button
                  type="button"
                  onClick={addStopField}
                  className="h-6 px-2 rounded-md border border-slate-300 dark:border-brand-700 bg-white dark:bg-brand-900 text-[7px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300"
                >
                  Add Stop
                </button>
              </div>
              {stopsDraft.length > 0 ? (
                <div className="space-y-2">
                  {stopsDraft.map((stopValue, index) => (
                    <div key={`modal-stop-${index}`} className="flex items-center gap-2">
                      <input
                        ref={element => {
                          stopInputRefs.current[index] = element;
                        }}
                        value={stopValue}
                        onChange={event => updateStopField(index, event.target.value)}
                        onBlur={event => {
                          const trimmedValue = event.currentTarget.value.trim();
                          setStopsDraft(prev => prev.map((entry, i) => (i === index ? trimmedValue : entry)));
                          setStopCandidates(prev => prev.map((entry, i) => {
                            if (i !== index) return entry;
                            if (!entry) return null;
                            return entry.text.trim().toLowerCase() === trimmedValue.toLowerCase() ? entry : null;
                          }));
                        }}
                        placeholder={`Stop ${index + 1} address or maps link`}
                        className="flex-1 h-9 rounded-lg border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 px-3 text-[10px] font-bold"
                      />
                      <button
                        type="button"
                        onClick={() => removeStopField(index)}
                        className="h-9 w-9 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 text-red-600 dark:text-red-300 inline-flex items-center justify-center"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">No stops added.</p>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-xl border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 px-3 py-2">
                <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Fare</p>
                <p className="text-[11px] font-black text-brand-900 dark:text-white mt-1">${liveTrip.fareUsd}</p>
                {minimumFareInfo.minimumFareApplied && (
                  <span className="inline-flex items-center h-5 mt-1 px-2 rounded-md border border-amber-300/50 bg-amber-500/10 text-[7px] font-black uppercase tracking-widest text-amber-300">
                    Min Applied (${minimumFareInfo.minimumFareUsd})
                  </span>
                )}
              </div>
              <div className="rounded-xl border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 px-3 py-2">
                <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Distance</p>
                <p className="text-[11px] font-black text-brand-900 dark:text-white mt-1">{liveTrip.distanceText}</p>
              </div>
              <div className="rounded-xl border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 px-3 py-2">
                <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Duration</p>
                <p className="text-[11px] font-black text-brand-900 dark:text-white mt-1">{liveTrip.durationInTrafficText || liveTrip.durationText}</p>
              </div>
            </div>
            {requoteMessage && (
              <p className="text-[9px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">{requoteMessage}</p>
            )}
          </div>

          <div className="pt-4 border-t border-slate-100 dark:border-brand-800">
            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-4 px-1">Quality Assurance & Feedback</label>
            <div className="flex items-center space-x-4 mb-4">
               {[1,2,3,4,5].map(star => (
                 <button 
                  key={star} 
                  onClick={() => setRating(star)}
                  className={`p-1.5 transition-all ${rating && rating >= star ? 'text-gold-500 scale-110' : 'text-slate-200 dark:text-brand-800'}`}
                 >
                   <Star size={24} fill={rating && rating >= star ? 'currentColor' : 'none'} />
                 </button>
               ))}
               {rating && <span className="text-xs font-black text-gold-600">{rating}/5 SCORE</span>}
            </div>
            <textarea 
              value={feedback} 
              onChange={e => setFeedback(e.target.value)} 
              className="w-full border border-slate-200 dark:border-brand-800 rounded-2xl p-4 bg-slate-50 dark:bg-brand-950 text-slate-900 dark:text-slate-100 text-sm font-medium focus:ring-2 focus:ring-gold-500 outline-none transition-all" 
              placeholder="Customer feedback notes..." 
              rows={2}
            />
          </div>

          <div className="space-y-4 pt-4 border-t border-slate-100 dark:border-brand-800">
             <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block px-1">Draft Comms (Copy-Paste)</label>
             <div className="grid grid-cols-3 gap-3">
                {[
                  { id: 'driver', label: 'Driver Brief', icon: Send, text: driverTemplate, color: 'text-blue-500' },
                  { id: 'customer', label: 'Client Conf', icon: MessageCircle, text: customerTemplate, color: 'text-emerald-500' },
                  { id: 'operator', label: 'Operator Log', icon: MailCheck, text: operatorTemplate, color: 'text-gold-500' }
                ].map(opt => (
                  <button 
                    key={opt.id}
                    onClick={() => onCopy(opt.text, opt.id, trip.id)}
                    className={`p-4 rounded-2xl border flex flex-col items-center justify-center space-y-2 transition-all group ${copiedType === `${opt.id}-${trip.id}` ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-slate-50 dark:bg-brand-950 border-slate-200 dark:border-brand-800 hover:border-gold-500'}`}
                  >
                    {copiedType === `${opt.id}-${trip.id}` ? <Check size={20}/> : <opt.icon size={20} className={opt.color} />}
                    <span className="text-[8px] font-black uppercase tracking-widest text-center leading-tight">{opt.label}</span>
                  </button>
                ))}
             </div>
              <div className="grid grid-cols-3 gap-3">
                <Button variant="outline" className="h-10 text-[9px]" onClick={() => onWhatsApp(driverPhone, driverTemplate)} disabled={!driverPhone}>Driver WhatsApp</Button>
                <Button variant="outline" className="h-10 text-[9px]" onClick={() => onWhatsApp(customerPhone, customerTemplate)} disabled={!customerPhone}>Client WhatsApp</Button>
               <Button variant="outline" className="h-10 text-[9px]" onClick={() => onWhatsApp(operatorPhone, operatorTemplate)} disabled={!operatorPhone}>Operator WhatsApp</Button>
               </div>
          </div>

          <div className="pt-4 border-t border-slate-100 dark:border-brand-800">
            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-2 px-1">Dispatch Intelligence</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} className="w-full border border-slate-200 dark:border-brand-800 rounded-2xl p-4 bg-slate-50 dark:bg-brand-950 text-slate-900 dark:text-slate-100 text-sm font-medium focus:ring-2 focus:ring-gold-500 outline-none transition-all" placeholder="Enter logs..." />
          </div>

          <div className="pt-4 border-t border-slate-100 dark:border-brand-800 space-y-3">
            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block px-1">Customer Priority</label>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => runSetPriority('VIP')} className="h-10 rounded-xl border border-slate-300 dark:border-violet-700/40 bg-slate-50 dark:bg-violet-900/10 text-[9px] font-black uppercase tracking-widest text-violet-700 dark:text-violet-300">★ Mark VIP</button>
              <button type="button" onClick={() => runSetPriority('VVIP')} className="h-10 rounded-xl border border-amber-300 dark:border-pink-700/40 bg-amber-50 dark:bg-pink-900/10 text-[9px] font-black uppercase tracking-widest text-pink-700 dark:text-pink-300">★★ Mark VVIP</button>
            </div>
            {priorityActionMessage && (
              <p className="text-[9px] font-black uppercase tracking-widest text-gold-700 dark:text-gold-300">{priorityActionMessage}</p>
            )}
          </div>

          <div className="pt-4 border-t border-slate-100 dark:border-brand-800 space-y-3">
            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block px-1">Assign Places to Contact</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button type="button" onClick={() => runAssignLocation('HOME', 'PICKUP')} className="h-10 rounded-xl border border-blue-300 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 text-[9px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300">Pickup → Home</button>
              <button type="button" onClick={() => runAssignLocation('FREQUENT', 'PICKUP')} className="h-10 rounded-xl border border-cyan-300 dark:border-cyan-900/40 bg-cyan-50 dark:bg-cyan-900/10 text-[9px] font-black uppercase tracking-widest text-cyan-700 dark:text-cyan-300">Pickup → Frequent</button>
              <button type="button" onClick={() => runAssignLocation('BUSINESS', 'DROPOFF')} className="h-10 rounded-xl border border-amber-300 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 text-[9px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-300">Dropoff → Business</button>
              <button type="button" onClick={() => runAssignLocation('FREQUENT', 'DROPOFF')} className="h-10 rounded-xl border border-emerald-300 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[9px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300">Dropoff → Frequent</button>
            </div>
            {locationActionMessage && (
              <p className="text-[9px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300">{locationActionMessage}</p>
            )}
          </div>
        </div>
        <div className="px-6 md:px-8 py-5 md:py-6 bg-slate-50 dark:bg-brand-950 border-t dark:border-brand-800 flex gap-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:pb-6">
          {trip.status === TripStatus.CANCELLED && (
            <Button variant="outline" onClick={() => onDeleteCancelled(trip)} className="bg-red-50 border-red-200 text-red-700 dark:bg-red-900/20 dark:border-red-800/40 dark:text-red-300">
              Delete Cancelled
            </Button>
          )}
          <Button variant="outline" onClick={onClose} className="flex-1 bg-white">Cancel</Button>
          <Button onClick={handleCommitPhase} variant="gold" className="flex-1">Commit Phase</Button>
        </div>
      </div>
    </div>
  );
};
