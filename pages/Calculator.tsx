import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useStore } from '../context/StoreContext';
import { loadGoogleMapsScript } from '../services/googleMapsLoader';
import { parseGoogleMapsLink, parseGpsOrLatLngInput, ParsedLocation } from '../services/locationParser';
import {
  SPECIAL_REQUIREMENTS,
  MIN_RIDE_FARE_USD,
  DISPATCH_NOW_MIN_MINUTES,
  DISPATCH_NOW_MAX_MINUTES,
  DISPATCH_NOW_DEFAULT_MINUTES,
} from '../constants';
import { RouteResult, TripStatus, Customer, CustomerLocation, Trip, TripStop, TripPaymentMode } from '../types';
import { Button } from '../components/ui/Button';
import { 
  MapPin, Navigation, Copy, Check, Save, Calculator as CalcIcon, 
  Clock, Timer, Link as LinkIcon, User, Phone, FileText, DollarSign, 
  Repeat, Hourglass, ChevronDown, ChevronUp, AlertCircle,
  Calendar, Settings, Car, Crosshair, RefreshCcw, Info, InfoIcon,
  Layers, Search, X, Star, Loader2, Radar, ShieldCheck, Zap, UserX, MessageCircle,
  Gauge,
  House, Building2, ArrowRightLeft,
  VolumeX, Moon, Briefcase, Users, Baby, Bus, PawPrint, Accessibility, Cigarette, CigaretteOff,
  Smartphone, KeyRound
} from 'lucide-react';
import { format, addMinutes } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { MessageModal } from '../components/MessageModal';
import { CustomerSnapshotCard } from '../components/CustomerSnapshotCard';
import { replacePlaceholders } from '../services/placeholderService';
import {
  applyPhoneDialCode,
  buildWhatsAppLink,
  DEFAULT_PHONE_DIAL_CODE,
  detectPhoneDialCode,
  normalizePhoneForWhatsApp,
  PHONE_COUNTRY_PRESETS,
  sanitizeCommunicationText,
} from '../services/whatsapp';
import { buildCustomerSnapshot, buildCustomerSnapshotForTrip } from '../services/customerSnapshot';
import { customerPhoneKey, getCustomerPreferredPaymentMode } from '../services/customerProfile';
import { clampTrafficIndex, computeTrafficIndex } from '../services/trafficMetrics';
import { truncateUiText, UI_TAG_MAX_CHARS, UI_LOCATION_MAX_CHARS } from '../services/uiText';

declare var google: any;

const CALCULATOR_DRAFT_KEY = 'calculator_draft_v1';
const DEFAULT_ADVANCED_MARKER_MAP_ID = 'DEMO_MAP_ID';

interface LocationDraft {
  place_id?: string;
  formatted_address?: string;
  name?: string;
  lat?: number;
  lng?: number;
}

interface CalculatorDraft {
  tripDate: string;
  customerName: string;
  customerPhone: string;
  selectedDriverId: string;
  paymentMode: TripPaymentMode;
  isRoundTrip: boolean;
  addWaitTime: boolean;
  waitTimeHours: number;
  selectedRequirements: string[];
  notes: string;
  fareUsd: number;
  fareLbp: number;
  showBreakdown: boolean;
  pickupOriginalLink?: string;
  destinationOriginalLink?: string;
  stopsDraft?: string[];
  pickupPlace?: LocationDraft;
  destPlace?: LocationDraft;
  result?: RouteResult;
}

interface ContactPickerEntry {
  name?: string[];
  tel?: string[];
}

type CalculatorNavigationMode = 'SCROLL' | 'SEQUENCE';
type CalculatorSequenceStage = 'ROUTE' | 'CUSTOMER' | 'OUTPUT';

const TrafficGauge: React.FC<{ index: number }> = ({ index }) => {
  const safeIndex = clampTrafficIndex(index);
  let color = '#10b981'; // emerald-500
  let label = 'Fluid';
  let desc = 'Optimal transit';
  
  if (safeIndex > 15) { color = '#3b82f6'; label = 'Normal'; desc = 'Standard flow'; }
  if (safeIndex > 35) { color = '#eab308'; label = 'Dense'; desc = 'Moderate build-up'; }
  if (safeIndex > 60) { color = '#f97316'; label = 'Heavy'; desc = 'Significant delay'; }
  if (safeIndex > 85) { color = '#ef4444'; label = 'Gridlock'; desc = 'Severe obstruction'; }

  const width = 120;
  const fillWidth = (safeIndex / 100) * width;

  return (
    <div className="flex flex-col space-y-1.5">
      <div className="flex justify-between items-baseline w-full">
         <span className="text-[9px] font-black uppercase tracking-widest" style={{ color }}>{label}</span>
         <span className="text-[8px] font-bold text-slate-400 uppercase tracking-tighter">{desc}</span>
      </div>
      <div className="relative overflow-hidden rounded-full bg-slate-100 dark:bg-brand-950 h-[6px] w-[120px]">
         <div className="h-full rounded-full transition-all duration-700" style={{ width: `${fillWidth}px`, backgroundColor: color }} />
      </div>
    </div>
  );
};

export const CalculatorPage: React.FC = () => {
  const { settings, addTrip, theme, customers, drivers, trips, creditLedger, receipts, updateFullTrip, addCustomers } = useStore();
  const navigate = useNavigate();
  
  // Maps State
  const [mapsLoaded, setMapsLoaded] = useState(false);
  const [error, setError] = useState<React.ReactNode | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  
  const pickupInputRef = useRef<HTMLInputElement>(null);
  const destInputRef = useRef<HTMLInputElement>(null);
  const searchDirectoryInputRef = useRef<HTMLInputElement>(null);
  const driverSearchInputRef = useRef<HTMLInputElement>(null);
  const panelScrollRef = useRef<HTMLDivElement>(null);
  const workflowControlsRef = useRef<HTMLDivElement>(null);
  const saveDispatchAnchorRef = useRef<HTMLDivElement>(null);
  const sequenceDockStageButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const notesTextareaRef = useRef<HTMLTextAreaElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  
  // Maps Objects Refs
  const mapInstance = useRef<any>(null);
  const markers = useRef<{ pickup: any, dest: any }>({ pickup: null, dest: null });
  const stopMarkers = useRef<any[]>([]);
  const routePolyline = useRef<any>(null);
  const geocoder = useRef<any>(null);
  const inputResolveTokenRef = useRef(0);
  
  const stopInputRefs = useRef<Array<HTMLInputElement | null>>([]);

  // Data State
  const [pickupPlace, setPickupPlace] = useState<any>(null);
  const [destPlace, setDestPlace] = useState<any>(null);
  const [pickupOriginalLink, setPickupOriginalLink] = useState<string | undefined>(undefined);
  const [destinationOriginalLink, setDestinationOriginalLink] = useState<string | undefined>(undefined);
  const [stopsDraft, setStopsDraft] = useState<string[]>([]);
  const [stopCandidates, setStopCandidates] = useState<Array<TripStop | null>>([]);
  const [resolvedStops, setResolvedStops] = useState<TripStop[]>([]);
  const [isStopsCollapsed, setIsStopsCollapsed] = useState(true);
  const [pendingLocation, setPendingLocation] = useState<{ lat: number, lng: number } | null>(null);
  
  // Time State
  const [tripDate, setTripDate] = useState<string>('');
  const [dateRequiredError, setDateRequiredError] = useState(false);
  const [todayTimeQuickInput, setTodayTimeQuickInput] = useState('');
  const [isTodayTimeQuickCollapsed, setIsTodayTimeQuickCollapsed] = useState(true);
  const [isFareModifiersCollapsed, setIsFareModifiersCollapsed] = useState(true);
  const [isQuoteQuickPicksCollapsed, setIsQuoteQuickPicksCollapsed] = useState(true);
  const [isFrequentPlacesCollapsed, setIsFrequentPlacesCollapsed] = useState(true);
  const [isQuickMarkersCollapsed, setIsQuickMarkersCollapsed] = useState(true);
  const [isPassengerRequirementsCollapsed, setIsPassengerRequirementsCollapsed] = useState(true);
  const [isQuickSaveCollapsed, setIsQuickSaveCollapsed] = useState(true);
  const [isPaymentModeCollapsed, setIsPaymentModeCollapsed] = useState(true);
  const [isSpecificNotesCollapsed, setIsSpecificNotesCollapsed] = useState(true);
  const [isSequenceWorkflowDockCollapsed, setIsSequenceWorkflowDockCollapsed] = useState(true);
  const [isOutputReadinessPanelDismissed, setIsOutputReadinessPanelDismissed] = useState(false);
  const [navigationMode, setNavigationMode] = useState<CalculatorNavigationMode>('SEQUENCE');
  const [activeSequenceStage, setActiveSequenceStage] = useState<CalculatorSequenceStage>('ROUTE');
  const [isNavigationControlsCollapsed, setIsNavigationControlsCollapsed] = useState(true);

  // Directory / Customer State
  const [searchDirectory, setSearchDirectory] = useState('');
  const [showDirectoryResults, setShowDirectoryResults] = useState(false);
  const [selectedQuoteDirectoryCustomerId, setSelectedQuoteDirectoryCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerPhoneIntlEnabled, setCustomerPhoneIntlEnabled] = useState(false);
  const [customerPhoneDialCode, setCustomerPhoneDialCode] = useState(DEFAULT_PHONE_DIAL_CODE);
  const [customerPhoneUseCustomDialCode, setCustomerPhoneUseCustomDialCode] = useState(false);
  const [customerPhoneCustomDialCode, setCustomerPhoneCustomDialCode] = useState('');
  const [canUseMobileContactPicker, setCanUseMobileContactPicker] = useState(false);
  const [selectedDriverId, setSelectedDriverId] = useState('');
  const [driverSearchQuery, setDriverSearchQuery] = useState('');
  const [debouncedDriverSearchQuery, setDebouncedDriverSearchQuery] = useState('');
  const [showDriverSuggestions, setShowDriverSuggestions] = useState(false);
  const [paymentMode, setPaymentMode] = useState<TripPaymentMode>('CASH');
  const [result, setResult] = useState<RouteResult | null>(null);

  const customerPhonePopularPresets = PHONE_COUNTRY_PRESETS;
  const resolvedCustomerCustomDialCode = customerPhoneCustomDialCode.replace(/\D/g, '');
  const selectedCustomerIntlDialCode = customerPhoneUseCustomDialCode
    ? (resolvedCustomerCustomDialCode || customerPhoneDialCode || DEFAULT_PHONE_DIAL_CODE)
    : customerPhoneDialCode;
  const customerPhoneEffectiveDialCode = customerPhoneIntlEnabled ? selectedCustomerIntlDialCode : DEFAULT_PHONE_DIAL_CODE;

  const syncCustomerPhoneDialState = (nextPhone: string) => {
    const detectedDialCode = detectPhoneDialCode(nextPhone);
    if (!detectedDialCode) return;

    const isKnownPreset = customerPhonePopularPresets.some(option => option.dialCode === detectedDialCode);
    setCustomerPhoneIntlEnabled(detectedDialCode !== DEFAULT_PHONE_DIAL_CODE);
    if (isKnownPreset) {
      setCustomerPhoneUseCustomDialCode(false);
      setCustomerPhoneDialCode(detectedDialCode);
      setCustomerPhoneCustomDialCode('');
    } else {
      setCustomerPhoneUseCustomDialCode(true);
      setCustomerPhoneCustomDialCode(detectedDialCode);
    }
  };

  const importContactFromPhone = async () => {
    const contactsApi = (navigator as Navigator & {
      contacts?: {
        select: (properties: string[], options?: { multiple?: boolean }) => Promise<ContactPickerEntry[]>;
      };
    }).contacts;

    if (!contactsApi?.select) {
      showCalculatorActionToast('Phone contact picker is unavailable on this device.');
      return;
    }

    try {
      const selection = await contactsApi.select(['name', 'tel'], { multiple: false });
      const picked = selection?.[0];
      const nextName = Array.isArray(picked?.name) ? String(picked?.name?.[0] || '').trim() : '';
      const nextPhone = Array.isArray(picked?.tel) ? String(picked?.tel?.[0] || '').trim() : '';

      if (!nextName && !nextPhone) {
        showCalculatorActionToast('No contact details were imported.');
        return;
      }

      setSelectedQuoteDirectoryCustomerId(null);
      if (nextName) setCustomerName(nextName);
      if (nextPhone) {
        setCustomerPhone(nextPhone);
        syncCustomerPhoneDialState(nextPhone);
      }

      showCalculatorActionToast('Contact imported. You can share quote immediately without saving.');
    } catch (error: any) {
      if (error?.name === 'AbortError') return;
      showCalculatorActionToast('Could not import contact from phone.');
    }
  };

  const activeDrivers = useMemo(
    () => drivers.filter(d => d.status === 'ACTIVE'),
    [drivers]
  );

  const assignedDriver = useMemo(
    () => drivers.find(d => d.id === selectedDriverId),
    [drivers, selectedDriverId]
  );

  const normalizedQuoteCustomerPhone = customerPhoneKey(customerPhone.trim());

  const driverIntelligenceById = useMemo(() => {
    const intelligence = new Map<string, {
      overall: number;
      availabilityScore: number;
      readinessScore: number;
      tripFitScore: number;
      performanceScore: number;
      governanceScore: number;
      isGovernanceBlocked: boolean;
      customerAffinityTrips: number;
      completedTrips: number;
      totalTrips: number;
      fairnessPenalty: number;
      recentTrips30: number;
      fuelRangeKm: number;
      kmSinceOilChange: number;
      kmSinceCheckup: number;
      governanceAlerts: string[];
      readinessAlerts: string[];
      reasons: string[];
    }>();
    const customerTripCountsByDriver = new Map<string, number>();
    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const NINETY_MIN_MS = 90 * 60 * 1000;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

    const parseTripTimestamp = (trip: Trip) => {
      const sourceDate = trip.tripDate || trip.createdAt;
      const timestamp = sourceDate ? new Date(sourceDate).getTime() : Number.NaN;
      return Number.isFinite(timestamp) ? timestamp : Number.NaN;
    };

    if (normalizedQuoteCustomerPhone) {
      trips.forEach(trip => {
        if (!trip.driverId) return;
        if (customerPhoneKey(trip.customerPhone) !== normalizedQuoteCustomerPhone) return;
        customerTripCountsByDriver.set(trip.driverId, (customerTripCountsByDriver.get(trip.driverId) || 0) + 1);
      });
    }

    activeDrivers.forEach(driver => {
      const driverTrips = trips.filter(trip => trip.driverId === driver.id);
      const totalTrips = driverTrips.length;
      const completedTrips = driverTrips.filter(trip => trip.status === TripStatus.COMPLETED).length;

      const recentTrips30 = driverTrips.filter(trip => {
        const sourceDate = trip.tripDate || trip.createdAt;
        const timestamp = sourceDate ? new Date(sourceDate).getTime() : Number.NaN;
        return Number.isFinite(timestamp) && now - timestamp <= THIRTY_DAYS_MS;
      }).length;

      const customerAffinityTrips = customerTripCountsByDriver.get(driver.id) || 0;
      const customerAffinityScore = Math.min(100, customerAffinityTrips * 22);

      const availabilityScore = driver.currentStatus === 'AVAILABLE' ? 100 : driver.currentStatus === 'BUSY' ? 55 : 10;

      const kmSinceOilChange = Math.max(0, (driver.baseMileage || 0) - (driver.lastOilChangeKm || 0));
      const kmSinceCheckup = Math.max(0, (driver.baseMileage || 0) - (driver.lastCheckupKm || 0));
      const fuelRangeKm = Math.max(0, Number(driver.fuelRangeKm) || 0);

      const readinessAlerts: string[] = [];
      if (fuelRangeKm < 60) readinessAlerts.push('Critical fuel range');
      else if (fuelRangeKm < 120) readinessAlerts.push('Low fuel range');
      if (kmSinceOilChange > 7000) readinessAlerts.push('Oil service overdue');
      else if (kmSinceOilChange > 4500) readinessAlerts.push('Oil service approaching');
      if (kmSinceCheckup > 12000) readinessAlerts.push('Checkup overdue');
      else if (kmSinceCheckup > 7000) readinessAlerts.push('Checkup approaching');

      const readinessPenalty =
        (fuelRangeKm < 50 ? 38 : fuelRangeKm < 110 ? 18 : 0) +
        (kmSinceOilChange > 7000 ? 34 : kmSinceOilChange > 4500 ? 16 : 0) +
        (kmSinceCheckup > 12000 ? 34 : kmSinceCheckup > 7000 ? 16 : 0);
      const readinessScore = clamp(100 - readinessPenalty, 5, 100);

      const governanceAlerts: string[] = [];
      if (driver.currentStatus === 'OFF_DUTY') governanceAlerts.push('Driver is off duty');
      if (driver.status !== 'ACTIVE') governanceAlerts.push('Driver profile inactive');
      const isGovernanceBlocked = driver.currentStatus === 'OFF_DUTY' || driver.status !== 'ACTIVE';

      const governancePenalty =
        (driver.currentStatus === 'OFF_DUTY' ? 60 : 0) +
        (driver.status !== 'ACTIVE' ? 60 : 0);
      const governanceScore = clamp(100 - governancePenalty, 0, 100);

      const completionConsistency = totalTrips > 0 ? (completedTrips / totalTrips) * 100 : 72;
      const performanceScore = clamp(58 + Math.min(42, completionConsistency * 0.42), 58, 100);

      const trafficFitScore = result
        ? result.trafficIndex >= 70
          ? (driver.currentStatus === 'AVAILABLE' ? 86 : driver.currentStatus === 'BUSY' ? 52 : 20)
          : (driver.currentStatus === 'AVAILABLE' ? 74 : driver.currentStatus === 'BUSY' ? 57 : 25)
        : 58;
      const tripFitScore = clamp(customerAffinityScore * 0.58 + trafficFitScore * 0.42, 0, 100);

      const recentTrips90 = driverTrips.filter(trip => {
        const timestamp = parseTripTimestamp(trip);
        return Number.isFinite(timestamp) && now - timestamp <= NINETY_MIN_MS;
      }).length;

      const lastTripTimestamp = driverTrips
        .map(parseTripTimestamp)
        .filter(timestamp => Number.isFinite(timestamp))
        .sort((a, b) => b - a)[0];
      const lastTripAgeMin = Number.isFinite(lastTripTimestamp)
        ? Math.max(0, (now - lastTripTimestamp) / 60000)
        : Number.POSITIVE_INFINITY;

      let fairnessPenalty = 0;
      if (recentTrips90 >= 2) fairnessPenalty += Math.min(10, (recentTrips90 - 1) * 3);
      if (lastTripAgeMin < 30) fairnessPenalty += 6;
      else if (lastTripAgeMin < 60) fairnessPenalty += 3;
      if (customerAffinityTrips >= 3) fairnessPenalty += 2;

      const assignedBoost = selectedDriverId === driver.id ? 4 : 0;
      const weightedOverall =
        availabilityScore * 0.32 +
        readinessScore * 0.24 +
        tripFitScore * 0.16 +
        performanceScore * 0.14 +
        governanceScore * 0.14 +
        assignedBoost -
        fairnessPenalty;
      const overall = Math.round(isGovernanceBlocked ? Math.min(weightedOverall, 38) : weightedOverall);

      const reasons: string[] = [];
      if (driver.currentStatus === 'AVAILABLE') reasons.push('Available now');
      if (customerAffinityTrips > 0) reasons.push(`Handled ${customerAffinityTrips} trips for this customer`);
      if (readinessScore >= 80) reasons.push('Unit readiness healthy');
      if (performanceScore >= 80) reasons.push('Strong completion consistency');
      if (governanceScore >= 80) reasons.push('Governance profile clean');
      if (fairnessPenalty > 0) reasons.push('Rotation balancing applied');

      intelligence.set(driver.id, {
        overall,
        availabilityScore,
        readinessScore,
        tripFitScore,
        performanceScore,
        governanceScore,
        isGovernanceBlocked,
        customerAffinityTrips,
        completedTrips,
        totalTrips,
        fairnessPenalty,
        recentTrips30,
        fuelRangeKm,
        kmSinceOilChange,
        kmSinceCheckup,
        governanceAlerts,
        readinessAlerts,
        reasons: reasons.slice(0, 3),
      });
    });

    return intelligence;
  }, [activeDrivers, trips, normalizedQuoteCustomerPhone, selectedDriverId, result]);

  const driverRecommendationScoreById = useMemo(() => {
    const scores = new Map<string, number>();
    activeDrivers.forEach(driver => {
      scores.set(driver.id, driverIntelligenceById.get(driver.id)?.overall || 0);
    });
    return scores;
  }, [activeDrivers, driverIntelligenceById]);

  const recommendedDrivers = useMemo(() => {
    return [...activeDrivers]
      .sort((a, b) => {
        const scoreDelta = (driverRecommendationScoreById.get(b.id) || 0) - (driverRecommendationScoreById.get(a.id) || 0);
        if (scoreDelta !== 0) return scoreDelta;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 4);
  }, [activeDrivers, driverRecommendationScoreById]);

  const driverSuggestions = useMemo(() => {
    const query = driverSearchQuery.trim().toLowerCase();
    const source = query
      ? activeDrivers.filter(driver => {
          return (
            driver.name.toLowerCase().includes(query) ||
            driver.plateNumber.toLowerCase().includes(query) ||
            driver.currentStatus.toLowerCase().includes(query)
          );
        })
      : activeDrivers;

    return [...source]
      .sort((a, b) => {
        const scoreDelta = (driverRecommendationScoreById.get(b.id) || 0) - (driverRecommendationScoreById.get(a.id) || 0);
        if (scoreDelta !== 0) return scoreDelta;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }, [activeDrivers, driverRecommendationScoreById, driverSearchQuery]);

  useEffect(() => {
    if (!driverSearchQuery.trim()) {
      setDebouncedDriverSearchQuery('');
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setDebouncedDriverSearchQuery(driverSearchQuery);
    }, 150);

    return () => window.clearTimeout(timeoutId);
  }, [driverSearchQuery]);

  const outputDriverInsightTarget = useMemo(() => {
    if (selectedDriverId) {
      return activeDrivers.find(driver => driver.id === selectedDriverId) || null;
    }
    if (showDriverSuggestions || debouncedDriverSearchQuery.trim()) {
      return driverSuggestions[0] || recommendedDrivers[0] || null;
    }
    return null;
  }, [selectedDriverId, activeDrivers, showDriverSuggestions, debouncedDriverSearchQuery, driverSuggestions, recommendedDrivers]);

  const outputDriverInsightMode = selectedDriverId
    ? 'ASSIGNED'
    : outputDriverInsightTarget
      ? 'RECOMMENDED'
      : 'NONE';

  const outputDriverInsight = outputDriverInsightTarget
    ? driverIntelligenceById.get(outputDriverInsightTarget.id) || null
    : null;

  useEffect(() => {
    if (!selectedDriverId) return;
    const stillAssignable = drivers.some(
      d => d.id === selectedDriverId && d.status === 'ACTIVE'
    );
    if (!stillAssignable) {
      setSelectedDriverId('');
    }
  }, [drivers, selectedDriverId]);

  useEffect(() => {
    if (!assignedDriver) {
      setDriverSearchQuery('');
      return;
    }
    setDriverSearchQuery(`${assignedDriver.name} (${assignedDriver.plateNumber})`);
  }, [assignedDriver]);

  useEffect(() => {
    const contactsApi = (navigator as Navigator & { contacts?: { select?: unknown } }).contacts;
    const hasContactPicker = typeof contactsApi?.select === 'function';
    const mobileMediaMatch = window.matchMedia('(max-width: 1024px), (pointer: coarse)').matches;
    const mobileUserAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
    setCanUseMobileContactPicker(Boolean(window.isSecureContext && hasContactPicker && (mobileMediaMatch || mobileUserAgent)));
  }, []);

  const customerTripSearchIndex = useMemo(() => {
    const index = new Map<string, string>();
    trips.forEach(trip => {
      const current = index.get(trip.customerPhone) || '';
      index.set(trip.customerPhone, `${current} ${trip.pickupText} ${trip.destinationText}`.trim().toLowerCase());
    });
    return index;
  }, [trips]);

  const directoryMatches = useMemo(() => {
    if (!searchDirectory || searchDirectory.length < 2) return [];
    const lower = searchDirectory.toLowerCase();
    
    return customers.filter(c => {
      const basicMatch = c.name.toLowerCase().includes(lower) || c.phone.includes(searchDirectory);
      if (basicMatch) return true;

      const customerSearchText = customerTripSearchIndex.get(c.phone);
      return customerSearchText ? customerSearchText.includes(lower) : false;
    }).slice(0, 5);
  }, [searchDirectory, customers, customerTripSearchIndex]);

  const quickCustomerPicks = useMemo(() => {
    const normalizeLocationText = (value?: string) =>
      String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const pickupContext = normalizeLocationText(pickupPlace?.formatted_address || '');
    const destinationContext = normalizeLocationText(destPlace?.formatted_address || '');

    const routeAffinityScore = (customer?: Customer): number => {
      if (!customer) return 0;
      const candidateTexts: string[] = [
        customer.homeLocation?.address || '',
        customer.homeLocation?.mapsLink || '',
        customer.businessLocation?.address || '',
        customer.businessLocation?.mapsLink || '',
        ...(Array.isArray(customer.frequentLocations)
          ? customer.frequentLocations.flatMap(location => [location.address || '', location.mapsLink || ''])
          : []),
      ].map(normalizeLocationText).filter(Boolean);

      if (candidateTexts.length === 0) return 0;

      const matchesContext = (context: string) => {
        if (!context) return false;
        return candidateTexts.some(candidate =>
          candidate.includes(context) || context.includes(candidate)
        );
      };

      const pickupMatch = matchesContext(pickupContext);
      const destinationMatch = matchesContext(destinationContext);
      if (pickupMatch && destinationMatch) return 2;
      if (pickupMatch || destinationMatch) return 1;
      return 0;
    };

    const byPhone = new Map<string, Customer>();
    customers.forEach(customer => {
      const key = customerPhoneKey(customer.phone);
      if (!key) return;
      byPhone.set(key, customer);
    });

    const seen = new Set<string>();
    const ranked = [...trips].sort((a, b) => {
      const dateA = new Date(a.tripDate || a.createdAt).getTime();
      const dateB = new Date(b.tripDate || b.createdAt).getTime();
      return dateB - dateA;
    });

    const priorityFromNotes = (notes?: string): number => {
      const text = String(notes || '').toUpperCase();
      if (text.includes('[VVIP]')) return 0;
      if (text.includes('[VIP]')) return 1;
      return 2;
    };

    const picks: Array<{ id: string; name: string; phone: string; fromDirectory: boolean; priority: number; affinity: number; recencyRank: number; tier: 'VVIP' | 'VIP' | null }> = [];
    let recencyRank = 0;
    for (const trip of ranked) {
      const key = customerPhoneKey(trip.customerPhone) || trip.customerPhone.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const directoryCustomer = byPhone.get(customerPhoneKey(trip.customerPhone) || '');
      picks.push({
        id: key,
        name: directoryCustomer?.name || trip.customerName || 'Client',
        phone: directoryCustomer?.phone || trip.customerPhone,
        fromDirectory: Boolean(directoryCustomer),
        priority: priorityFromNotes(directoryCustomer?.notes),
        affinity: routeAffinityScore(directoryCustomer),
        recencyRank,
        tier: priorityFromNotes(directoryCustomer?.notes) === 0
          ? 'VVIP'
          : priorityFromNotes(directoryCustomer?.notes) === 1
            ? 'VIP'
            : null,
      });
      recencyRank += 1;

      if (picks.length >= 8) break;
    }

    return picks
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        if (a.affinity !== b.affinity) return b.affinity - a.affinity;
        return a.recencyRank - b.recencyRank;
      })
      .slice(0, 4)
      .map(({ id, name, phone, fromDirectory, tier, affinity }) => ({ id, name, phone, fromDirectory, tier, affinity }));
  }, [trips, customers, pickupPlace, destPlace]);

  const quoteCustomerSnapshot = useMemo(() => {
    const name = customerName.trim();
    const phone = customerPhone.trim();
    if (!name && !phone) return null;
    return buildCustomerSnapshot(name, phone, customers, trips, drivers, creditLedger, receipts, { driverContextId: selectedDriverId || undefined });
  }, [customerName, customerPhone, customers, trips, drivers, creditLedger, receipts, selectedDriverId]);

  const hasExistingCustomerSnapshotInfo = useMemo(() => {
    if (!quoteCustomerSnapshot) return false;
    return (
      quoteCustomerSnapshot.totalTrips > 0 ||
      quoteCustomerSnapshot.receiptCount > 0 ||
      quoteCustomerSnapshot.frequentPlacesCount > 0 ||
      quoteCustomerSnapshot.recentTimeline.length > 0 ||
      quoteCustomerSnapshot.commonDestinations.length > 0 ||
      Boolean(quoteCustomerSnapshot.lastContactAt) ||
      Boolean(quoteCustomerSnapshot.homeAddress) ||
      Boolean(quoteCustomerSnapshot.businessAddress) ||
      quoteCustomerSnapshot.openCreditUsd > 0 ||
      quoteCustomerSnapshot.paidCreditUsd > 0
    );
  }, [quoteCustomerSnapshot]);

  const quoteDirectoryCustomer = useMemo(() => {
    const normalizedPhone = customerPhoneKey(customerPhone.trim());
    if (normalizedPhone) {
      const byPhone = customers.find(c => customerPhoneKey(c.phone) === normalizedPhone);
      if (byPhone) return byPhone;
    }

    const normalizedName = customerName.trim().toLowerCase();
    if (!normalizedName) return null;
    return customers.find(c => c.name.trim().toLowerCase() === normalizedName) || null;
  }, [customerPhone, customerName, customers]);

  const quotePreferredPaymentMode = useMemo(
    () => getCustomerPreferredPaymentMode(quoteDirectoryCustomer, trips),
    [quoteDirectoryCustomer, trips]
  );

  const isQuoteDirectorySelectionActive = Boolean(
    selectedQuoteDirectoryCustomerId &&
    quoteDirectoryCustomer?.id === selectedQuoteDirectoryCustomerId
  );

  const operatorIndexMarkers = ['NEW', 'CORP', 'AIRPORT', 'PRIORITY', 'FOLLOWUP', 'VIP', 'VVIP'] as const;

  const hasOperatorMarker = (marker: string) => {
    return new RegExp(`\\[${marker}\\](?:\\s|$)`, 'i').test(notes);
  };

  const syncOperatorMarkersToDirectory = (nextNotes: string) => {
    const normalizedPhone = customerPhoneKey(customerPhone.trim());
    const fallbackPhone = quoteDirectoryCustomer ? customerPhoneKey(quoteDirectoryCustomer.phone) : '';
    const targetPhone = normalizedPhone || fallbackPhone;
    if (!targetPhone) return;

    const existing = quoteDirectoryCustomer || customers.find(entry => customerPhoneKey(entry.phone) === targetPhone) || null;
    const targetName = customerName.trim() || existing?.name || 'Unknown Client';

    addCustomers([{
      id: existing?.id || `${Date.now()}-${Math.random()}`,
      name: targetName,
      phone: targetPhone,
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
    }]);
  };

  const toggleOperatorMarker = (marker: string) => {
    setNotes(prev => {
      const markerTestPattern = new RegExp(`\\[${marker}\\](?:\\s|$)`, 'i');
      const pattern = new RegExp(`\\[${marker}\\]\\s*`, 'ig');
      const wasPresent = markerTestPattern.test(prev);
      const stripped = prev.replace(pattern, '').replace(/\s{2,}/g, ' ').trim();
      const nextNotes = wasPresent ? stripped : `[${marker}]${stripped ? ` ${stripped}` : ''}`;
      syncOperatorMarkersToDirectory(nextNotes);
      return nextNotes;
    });
  };

  const frequentPlaceSuggestions = useMemo(() => {
    if (!quoteDirectoryCustomer) return [];

    const combined: Array<CustomerLocation & { quickTagOrder: number; helperText: string }> = [];
    if (quoteDirectoryCustomer.homeLocation) {
      combined.push({
        ...quoteDirectoryCustomer.homeLocation,
        label: 'Home',
        quickTagOrder: 1,
        helperText: 'Saved Home location from CRM directory.',
      });
    }
    if (quoteDirectoryCustomer.businessLocation) {
      combined.push({
        ...quoteDirectoryCustomer.businessLocation,
        label: 'Business',
        quickTagOrder: 2,
        helperText: 'Saved Business location from CRM directory.',
      });
    }
    if (Array.isArray(quoteDirectoryCustomer.frequentLocations)) {
      quoteDirectoryCustomer.frequentLocations.forEach((location, index) => {
        combined.push({
          ...location,
          label: (location.label || '').trim() || `Frequent ${index + 1}`,
          quickTagOrder: 3,
          helperText: `Saved frequent place #${index + 1} from CRM directory.`,
        });
      });
    }

    const seen = new Set<string>();
    const deduped = combined.filter(location => {
      const key = `${(location.address || '').toLowerCase()}|${String(location.mapsLink || '').toLowerCase()}|${location.lat ?? ''}|${location.lng ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return deduped.sort((a, b) => a.quickTagOrder - b.quickTagOrder);
  }, [quoteDirectoryCustomer]);

  // Options State
  const [isRoundTrip, setIsRoundTrip] = useState(false);
  const [addWaitTime, setAddWaitTime] = useState(false);
  const [waitTimeHours, setWaitTimeHours] = useState(0);
  const [waitTimeInput, setWaitTimeInput] = useState('');
  const [selectedRequirements, setSelectedRequirements] = useState<string[]>([]);

  // Calculation State
  const [calculating, setCalculating] = useState(false);
  const [fareUsd, setFareUsd] = useState(0);
  const [fareLbp, setFareLbp] = useState(0);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [routesApiBlocked, setRoutesApiBlocked] = useState(false);

  // Form State
  const [notes, setNotes] = useState('');
  const [tripSaved, setTripSaved] = useState(false);
  const [lastSavedTrip, setLastSavedTrip] = useState<Trip | null>(null);
  const [showMessageModal, setShowMessageModal] = useState(false);
  const [quickCopied, setQuickCopied] = useState(false);
  const [locationStatusMessage, setLocationStatusMessage] = useState('');
  const [calcActionToast, setCalcActionToast] = useState<string | null>(null);
  const draftHydrated = useRef(false);
  const calculationStartedAtRef = useRef(0);
  const calculationRequestIdRef = useRef(0);
  const MIN_CALC_LOADING_MS = 800;

  const resizeNotesTextarea = (el?: HTMLTextAreaElement | null) => {
    const target = el || notesTextareaRef.current;
    if (!target) return;
    target.style.height = 'auto';
    const minHeight = 32;
    const maxHeight = 128;
    const nextHeight = Math.min(maxHeight, Math.max(minHeight, target.scrollHeight));
    target.style.height = `${nextHeight}px`;
    target.style.overflowY = target.scrollHeight > maxHeight ? 'auto' : 'hidden';
  };

  const hasAnyOperatorMarker = operatorIndexMarkers.some(marker => hasOperatorMarker(marker));
  const shouldShowQuickMarkers =
    Boolean(customerName.trim() || customerPhone.trim()) &&
    (!quoteDirectoryCustomer || hasAnyOperatorMarker);

  const savedTripSnapshot = useMemo(() => {
    if (!lastSavedTrip) return null;
    return buildCustomerSnapshotForTrip(lastSavedTrip, customers, trips, drivers, creditLedger, receipts);
  }, [lastSavedTrip, customers, trips, drivers, creditLedger, receipts]);

  const setMarkerPosition = (marker: any, position: any) => {
    if (!marker) return;
    if (typeof marker.setPosition === 'function') {
      marker.setPosition(position);
      return;
    }
    marker.position = position;
  };

  const getMarkerPosition = (marker: any) => {
    if (!marker) return null;
    if (typeof marker.getPosition === 'function') {
      return marker.getPosition();
    }
    return marker.position;
  };

  const setMarkerMap = (marker: any, map: any | null) => {
    if (!marker) return;
    if (typeof marker.setMap === 'function') {
      marker.setMap(map);
      return;
    }
    marker.map = map;
  };

  const createMapMarker = (label: string, color: string, position: any, draggable = false, onDragEnd?: () => void) => {
    if (!mapInstance.current) return null;

    if (google.maps.marker?.AdvancedMarkerElement && google.maps.marker?.PinElement) {
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map: mapInstance.current,
        position,
        content: new google.maps.marker.PinElement({ glyphText: label, background: color, borderColor: 'white' }),
        gmpDraggable: draggable,
      });
      if (onDragEnd) marker.addListener('dragend', onDragEnd);
      return marker;
    }

    return null;
  };

  const styleMapMarker = (marker: any, label: string, color: string) => {
    if (!marker) return;

    if (google.maps.marker?.PinElement && marker.content !== undefined) {
      marker.content = new google.maps.marker.PinElement({ glyphText: label, background: color, borderColor: 'white' });
      return;
    }
  };

  const clearStopMarkers = () => {
    stopMarkers.current.forEach(marker => setMarkerMap(marker, null));
    stopMarkers.current = [];
  };

  const toRouteLabel = (index: number) => {
    const code = 65 + index;
    if (code <= 90) return String.fromCharCode(code);
    const primary = String.fromCharCode(65 + Math.floor((index - 26) / 26));
    const secondary = String.fromCharCode(65 + ((index - 26) % 26));
    return `${primary}${secondary}`;
  };

  const clearRoutePath = () => {
    if (routePolyline.current) {
      routePolyline.current.setMap(null);
      routePolyline.current = null;
    }
  };

  const decodePolyline = (encoded: string): Array<{ lat: number; lng: number }> => {
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

  const readCoordinateFromLocation = (location: any, axis: 'lat' | 'lng'): number => {
    const value = location?.[axis];
    if (typeof value === 'function') {
      try {
        return Number((value as () => unknown).call(location));
      } catch {
        return Number.NaN;
      }
    }
    return Number(value);
  };

  const getPlaceCoordinates = (place: any) => {
    const location = place?.geometry?.location;
    const latValue = readCoordinateFromLocation(location, 'lat');
    const lngValue = readCoordinateFromLocation(location, 'lng');
    return { lat: latValue, lng: lngValue };
  };

  const parseDurationToMinutes = (duration?: string) => {
    const seconds = duration ? parseFloat(duration.replace('s', '')) : 0;
    return Math.ceil((Number.isFinite(seconds) ? seconds : 0) / 60);
  };

  const startCalculationLoading = () => {
    calculationRequestIdRef.current += 1;
    calculationStartedAtRef.current = Date.now();
    setCalculating(true);
    return calculationRequestIdRef.current;
  };

  const stopCalculationLoading = (requestId: number) => {
    if (requestId !== calculationRequestIdRef.current) return;

    const elapsed = Date.now() - calculationStartedAtRef.current;
    const remaining = Math.max(0, MIN_CALC_LOADING_MS - elapsed);

    if (remaining === 0) {
      setCalculating(false);
      return;
    }

    window.setTimeout(() => {
      if (requestId === calculationRequestIdRef.current) {
        setCalculating(false);
      }
    }, remaining);
  };

  const serializePlace = (place: any): LocationDraft | undefined => {
    if (!place) return undefined;
    const location = place?.geometry?.location;
    const lat = readCoordinateFromLocation(location, 'lat');
    const lng = readCoordinateFromLocation(location, 'lng');
    return {
      place_id: place?.place_id,
      formatted_address: place?.formatted_address,
      name: place?.name,
      lat: Number.isFinite(lat) ? lat : undefined,
      lng: Number.isFinite(lng) ? lng : undefined,
    };
  };

  const deserializePlace = (draft?: LocationDraft) => {
    if (!draft || !Number.isFinite(draft.lat) || !Number.isFinite(draft.lng)) return null;
    return {
      place_id: draft.place_id || 'GPS',
      formatted_address: draft.formatted_address || draft.name || `${draft.lat}, ${draft.lng}`,
      name: draft.name || draft.formatted_address || `${draft.lat}, ${draft.lng}`,
      geometry: {
        location: {
          lat: draft.lat,
          lng: draft.lng,
        },
      },
    };
  };

  const resolveParsedMapsLocation = (
    type: 'pickup' | 'dest',
    parsed: ParsedLocation,
    requestToken: number = inputResolveTokenRef.current
  ) => {
    const latLng = new google.maps.LatLng(parsed.lat, parsed.lng);
    const applyPlaceResult = (addr: string, placeId?: string) => {
      if (requestToken !== inputResolveTokenRef.current) return;

      const placeRes = {
        place_id: placeId || 'GPS',
        geometry: { location: latLng },
        formatted_address: addr,
        name: addr,
      };

      if (type === 'pickup') {
        setPickupPlace(placeRes);
        setPickupOriginalLink(parsed.originalUrl);
        setMarkerPosition(markers.current.pickup, latLng);
        if (pickupInputRef.current) pickupInputRef.current.value = addr;
      } else {
        setDestPlace(placeRes);
        setDestinationOriginalLink(parsed.originalUrl);
        setMarkerPosition(markers.current.dest, latLng);
        if (destInputRef.current) destInputRef.current.value = addr;
      }

      mapInstance.current?.panTo(latLng);
    };

    if (!geocoder.current) {
      applyPlaceResult(`${parsed.lat.toFixed(6)}, ${parsed.lng.toFixed(6)}`);
      return;
    }

    geocoder.current.geocode({ location: latLng }, (results: any, status: any) => {
      if (requestToken !== inputResolveTokenRef.current) return;

      if (status === 'OK' && results?.[0]) {
        applyPlaceResult(results[0].formatted_address, results[0].place_id);
      } else {
        applyPlaceResult(`${parsed.lat.toFixed(6)}, ${parsed.lng.toFixed(6)}`);
      }
    });
  };

  const tryResolveGoogleMapsInput = (type: 'pickup' | 'dest', rawValue: string): boolean => {
    const value = (rawValue || '').trim();
    if (!value) return false;
    const requestToken = inputResolveTokenRef.current;

    const parsed = parseGoogleMapsLink(value) || parseGpsOrLatLngInput(value);
    if (parsed) {
      resolveParsedMapsLocation(type, parsed, requestToken);
      return true;
    }

    if (!geocoder.current) return false;
    geocoder.current.geocode(
      { address: value, componentRestrictions: { country: 'LB' } },
      (results: any, status: any) => {
        if (requestToken !== inputResolveTokenRef.current) return;

        if (status === 'OK' && results?.[0]) {
          const loc = results[0].geometry?.location;
          if (!loc) return;
          const asParsed: ParsedLocation = {
            lat: loc.lat(),
            lng: loc.lng(),
            originalUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}`,
          };
          resolveParsedMapsLocation(type, asParsed, requestToken);
        }
      }
    );

    return false;
  };

  const buildSafeDepartureTime = () => {
    const now = new Date();
    const minimumFutureMs = DISPATCH_NOW_MIN_MINUTES * 60 * 1000;
    const minimumFutureTime = new Date(now.getTime() + minimumFutureMs);
    const requested = tripDate ? new Date(tripDate) : now;

    if (!Number.isFinite(requested.getTime()) || requested.getTime() <= minimumFutureTime.getTime()) {
      return minimumFutureTime.toISOString();
    }

    return requested.toISOString();
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
        placeId: String(first.place_id || 'GEOCODED_STOP'),
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
        placeId: String(candidate.place_id || 'GEOCODED_STOP'),
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

  useEffect(() => {
    (window as any).gm_authFailure = () => {
      setError(<div className="p-4 bg-red-50 text-red-600 rounded-2xl border border-red-100 text-xs font-black uppercase">Auth Failed: Key Restriction</div>);
    };
    return () => { (window as any).gm_authFailure = null; };
  }, []);

  useEffect(() => {
    if (settings.googleMapsApiKey) {
      setRoutesApiBlocked(false);
      loadGoogleMapsScript(settings.googleMapsApiKey).then(() => setMapsLoaded(true)).catch(() => setError("Engine load error."));
    } else {
      setError("Engine configuration required.");
    }
  }, [settings.googleMapsApiKey]);

  useEffect(() => {
    resizeNotesTextarea();
  }, [notes]);

  useEffect(() => {
    if (draftHydrated.current) return;
    try {
      const raw = localStorage.getItem(CALCULATOR_DRAFT_KEY);
      if (!raw) {
        draftHydrated.current = true;
        return;
      }
      const draft = JSON.parse(raw) as Partial<CalculatorDraft>;

      if (typeof draft.tripDate === 'string') setTripDate(draft.tripDate);
      if (typeof draft.customerName === 'string') setCustomerName(draft.customerName);
      if (typeof draft.customerPhone === 'string') {
        setCustomerPhone(draft.customerPhone);
        const detectedDialCode = detectPhoneDialCode(draft.customerPhone) || DEFAULT_PHONE_DIAL_CODE;
        const isKnownPreset = customerPhonePopularPresets.some(option => option.dialCode === detectedDialCode);
        setCustomerPhoneIntlEnabled(detectedDialCode !== DEFAULT_PHONE_DIAL_CODE);
        if (isKnownPreset) {
          setCustomerPhoneDialCode(detectedDialCode);
          setCustomerPhoneUseCustomDialCode(false);
          setCustomerPhoneCustomDialCode('');
        } else {
          setCustomerPhoneDialCode(DEFAULT_PHONE_DIAL_CODE);
          setCustomerPhoneUseCustomDialCode(true);
          setCustomerPhoneCustomDialCode(detectedDialCode);
        }
      }
      if (typeof draft.selectedDriverId === 'string') setSelectedDriverId(draft.selectedDriverId);
      if (draft.paymentMode === 'CASH' || draft.paymentMode === 'CREDIT') setPaymentMode(draft.paymentMode);
      if (typeof draft.isRoundTrip === 'boolean') setIsRoundTrip(draft.isRoundTrip);
      if (typeof draft.addWaitTime === 'boolean') setAddWaitTime(draft.addWaitTime);
      if (typeof draft.waitTimeHours === 'number') {
        setWaitTimeHours(draft.waitTimeHours);
        setWaitTimeInput(draft.waitTimeHours > 0 ? String(draft.waitTimeHours) : '');
      }
      if (Array.isArray(draft.selectedRequirements)) setSelectedRequirements(draft.selectedRequirements.filter((x): x is string => typeof x === 'string'));
      if (typeof draft.notes === 'string') setNotes(draft.notes);
      if (typeof draft.fareUsd === 'number') setFareUsd(draft.fareUsd);
      if (typeof draft.fareLbp === 'number') setFareLbp(draft.fareLbp);
      if (typeof draft.showBreakdown === 'boolean') setShowBreakdown(draft.showBreakdown);
      if (typeof draft.pickupOriginalLink === 'string') setPickupOriginalLink(draft.pickupOriginalLink);
      if (typeof draft.destinationOriginalLink === 'string') setDestinationOriginalLink(draft.destinationOriginalLink);
      if (Array.isArray(draft.stopsDraft)) {
        const normalizedStops = draft.stopsDraft.filter((value): value is string => typeof value === 'string');
        setStopsDraft(normalizedStops);
        setStopCandidates(normalizedStops.map(() => null));
      }
      if (draft.result) setResult(draft.result as RouteResult);

      const restoredPickup = deserializePlace(draft.pickupPlace);
      const restoredDest = deserializePlace(draft.destPlace);
      if (restoredPickup) setPickupPlace(restoredPickup);
      if (restoredDest) setDestPlace(restoredDest);
    } catch {
      localStorage.removeItem(CALCULATOR_DRAFT_KEY);
    } finally {
      draftHydrated.current = true;
    }
  }, []);

  useEffect(() => {
    if (!mapsLoaded) return;

    if (pickupPlace?.formatted_address && pickupInputRef.current) {
      pickupInputRef.current.value = pickupPlace.formatted_address;
    }
    if (destPlace?.formatted_address && destInputRef.current) {
      destInputRef.current.value = destPlace.formatted_address;
    }

    const pickupLat = readCoordinateFromLocation(pickupPlace?.geometry?.location, 'lat');
    const pickupLng = readCoordinateFromLocation(pickupPlace?.geometry?.location, 'lng');
    if (Number.isFinite(pickupLat) && Number.isFinite(pickupLng)) {
      setMarkerPosition(markers.current.pickup, { lat: pickupLat, lng: pickupLng });
    }

    const destLat = readCoordinateFromLocation(destPlace?.geometry?.location, 'lat');
    const destLng = readCoordinateFromLocation(destPlace?.geometry?.location, 'lng');
    if (Number.isFinite(destLat) && Number.isFinite(destLng)) {
      setMarkerPosition(markers.current.dest, { lat: destLat, lng: destLng });
    }
  }, [mapsLoaded, pickupPlace, destPlace]);

  useEffect(() => {
    if (!draftHydrated.current) return;

    const hasMeaningfulDraft =
      Boolean(result) ||
      Boolean(customerName.trim()) ||
      Boolean(customerPhone.trim()) ||
      Boolean(selectedDriverId) ||
      paymentMode === 'CREDIT' ||
      Boolean(notes.trim()) ||
      Boolean(tripDate) ||
      Boolean(pickupPlace) ||
      Boolean(destPlace) ||
      stopsDraft.some(value => value.trim().length > 0);

    if (!hasMeaningfulDraft) {
      localStorage.removeItem(CALCULATOR_DRAFT_KEY);
      return;
    }

    const draft: CalculatorDraft = {
      tripDate,
      customerName,
      customerPhone,
      selectedDriverId,
      paymentMode,
      isRoundTrip,
      addWaitTime,
      waitTimeHours,
      selectedRequirements,
      notes,
      fareUsd,
      fareLbp,
      showBreakdown,
      pickupOriginalLink,
      destinationOriginalLink,
      stopsDraft,
      pickupPlace: serializePlace(pickupPlace),
      destPlace: serializePlace(destPlace),
      result: result || undefined,
    };

    localStorage.setItem(CALCULATOR_DRAFT_KEY, JSON.stringify(draft));
  }, [
    tripDate,
    customerName,
    customerPhone,
    selectedDriverId,
    paymentMode,
    isRoundTrip,
    addWaitTime,
    waitTimeHours,
    selectedRequirements,
    notes,
    fareUsd,
    fareLbp,
    showBreakdown,
    pickupOriginalLink,
    destinationOriginalLink,
    stopsDraft,
    pickupPlace,
    destPlace,
    result,
  ]);

  useEffect(() => {
    if (mapsLoaded && window.google?.maps?.Map && mapRef.current && !mapInstance.current) {
        const selectedMapId = ((theme === 'dark' ? settings.googleMapsMapIdDark : settings.googleMapsMapId) || settings.googleMapsMapId || '').trim();
        const activeMapId = selectedMapId || DEFAULT_ADVANCED_MARKER_MAP_ID;
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
        mapOptions.mapId = activeMapId;

        mapInstance.current = new google.maps.Map(mapRef.current, {
          ...mapOptions
        });
        geocoder.current = new google.maps.Geocoder();
        mapInstance.current.addListener("click", (e: any) => e.latLng && setPendingLocation({ lat: e.latLng.lat(), lng: e.latLng.lng() }));
        
        markers.current.pickup = createMapMarker('A', '#d4a017', { lat: 33.8938, lng: 35.5018 }, true, () => handleMarkerDrag('pickup'));
        markers.current.dest = createMapMarker('B', '#2563eb', { lat: 33.8938, lng: 35.5018 }, true, () => handleMarkerDrag('dest'));
    }
  }, [mapsLoaded, theme, settings.googleMapsMapId, settings.googleMapsMapIdDark]);

  const handleMarkerDrag = (type: 'pickup' | 'dest') => {
    const marker = markers.current[type];
    const pos = getMarkerPosition(marker);
    if (!pos) return;
    geocoder.current.geocode({ location: pos }, (results: any, status: any) => {
      if (status === 'OK' && results[0]) {
        const addr = results[0].formatted_address;
        const placeRes = { place_id: results[0].place_id, geometry: { location: pos }, formatted_address: addr, name: addr };
        if (type === 'pickup') { setPickupPlace(placeRes); setPickupOriginalLink(undefined); if (pickupInputRef.current) pickupInputRef.current.value = addr; }
        else { setDestPlace(placeRes); setDestinationOriginalLink(undefined); if (destInputRef.current) destInputRef.current.value = addr; }
      }
    });
  };

  useEffect(() => {
    const hasUnresolvedStop = stopsDraft.some((value, index) => {
      const stopValue = value.trim();
      if (!stopValue) return false;
      const candidate = stopCandidates[index];
      if (!candidate) return true;
      if (!Number.isFinite(candidate.lat) || !Number.isFinite(candidate.lng)) return true;
      return candidate.text.trim().toLowerCase() !== stopValue.toLowerCase();
    });

    if (hasUnresolvedStop) return;

    if (pickupPlace && destPlace && !routesApiBlocked) fetchRoute(pickupPlace, destPlace, stopsDraft);
  }, [pickupPlace, destPlace, stopsDraft, stopCandidates, tripDate, routesApiBlocked]);

  useEffect(() => {
    if (!mapsLoaded || !mapInstance.current) return;

    const activeStops = stopsDraft
      .map((value, index) => {
        const text = value.trim();
        if (!text) return null;
        const candidate = stopCandidates[index];
        if (!candidate) return null;
        if (!Number.isFinite(candidate.lat) || !Number.isFinite(candidate.lng)) return null;
        if (candidate.text.trim().toLowerCase() !== text.toLowerCase()) return null;
        return candidate;
      })
      .filter((entry): entry is TripStop => Boolean(entry));

    styleMapMarker(markers.current.pickup, toRouteLabel(0), '#d4a017');
    styleMapMarker(markers.current.dest, toRouteLabel(activeStops.length + 1), '#2563eb');

    while (stopMarkers.current.length > activeStops.length) {
      const marker = stopMarkers.current.pop();
      setMarkerMap(marker, null);
    }

    activeStops.forEach((stop, index) => {
      const label = toRouteLabel(index + 1);
      const color = '#0ea5e9';
      const position = { lat: Number(stop.lat), lng: Number(stop.lng) };

      if (!stopMarkers.current[index]) {
        stopMarkers.current[index] = createMapMarker(label, color, position, false);
      } else {
        styleMapMarker(stopMarkers.current[index], label, color);
        setMarkerPosition(stopMarkers.current[index], position);
      }
    });
  }, [mapsLoaded, stopsDraft, stopCandidates]);

  useEffect(() => {
    if (result) calculateFare(result);
  }, [result, isRoundTrip, addWaitTime, waitTimeHours, settings]);

  const fetchRoute = async (origin: any, destination: any, stopInputs: string[] = []) => {
    const requestId = startCalculationLoading();
    try {
      const originCoords = getPlaceCoordinates(origin);
      const destinationCoords = getPlaceCoordinates(destination);

      if (!Number.isFinite(originCoords.lat) || !Number.isFinite(originCoords.lng) || !Number.isFinite(destinationCoords.lat) || !Number.isFinite(destinationCoords.lng)) {
        throw new Error('Invalid coordinates for route computation');
      }

      const waypointStops: TripStop[] = [];

      for (let index = 0; index < stopInputs.length; index += 1) {
        const stopInput = stopInputs[index].trim();
        if (!stopInput) continue;
        const candidate = stopCandidates[index];
        const useCandidate = Boolean(
          candidate &&
          Number.isFinite(candidate.lat) &&
          Number.isFinite(candidate.lng) &&
          candidate.text.trim().toLowerCase() === stopInput.trim().toLowerCase()
        );

        const resolvedStop = useCandidate ? candidate : await resolveStopInput(stopInput);
        if (!resolvedStop || !Number.isFinite(resolvedStop.lat) || !Number.isFinite(resolvedStop.lng)) {
          setResult(null);
          setFareUsd(0);
          setFareLbp(0);
          setResolvedStops([]);
          setError(`Resolve stop before quoting: ${stopInput}`);
          stopCalculationLoading(requestId);
          return;
        }
        waypointStops.push(resolvedStop);
      }

      const intermediates = waypointStops.map(stop => ({
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
          'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.staticDuration,routes.polyline.encodedPolyline'
        },
        body: JSON.stringify({
          origin: {
            location: {
              latLng: {
                latitude: originCoords.lat,
                longitude: originCoords.lng
              }
            }
          },
          destination: {
            location: {
              latLng: {
                latitude: destinationCoords.lat,
                longitude: destinationCoords.lng
              }
            }
          },
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_AWARE',
          languageCode: 'en-US',
          units: 'METRIC',
          departureTime: buildSafeDepartureTime(),
          ...(intermediates.length > 0 ? { intermediates } : {}),
        })
      });

      if (!response.ok) {
        const contentType = response.headers.get('content-type') || '';
        let details = '';

        if (contentType.includes('application/json')) {
          const errorPayload = await response.json();
          details = errorPayload?.error?.message || JSON.stringify(errorPayload);
        } else {
          details = await response.text();
        }

        const errorWithStatus = new Error(details || `Routes API error (${response.status})`) as Error & { status?: number };
        errorWithStatus.status = response.status;
        throw errorWithStatus;
      }

      const payload = await response.json();
      const route = payload?.routes?.[0];
      if (!route) {
        throw new Error('No route returned from Routes API');
      }

      clearRoutePath();
      const encodedPolyline = route.polyline?.encodedPolyline;
      if (encodedPolyline && mapInstance.current) {
        const path = decodePolyline(encodedPolyline);
        routePolyline.current = new google.maps.Polyline({
          path,
          map: mapInstance.current,
          strokeColor: '#d4a017',
          strokeOpacity: 0.9,
          strokeWeight: 4,
        });

        const bounds = new google.maps.LatLngBounds();
        path.forEach(point => bounds.extend(point));
        if (!bounds.isEmpty()) {
          mapInstance.current.fitBounds(bounds, 60);
        }
      }

      const distanceMeters = Number(route.distanceMeters || 0);
      const durationInTrafficMin = parseDurationToMinutes(route.duration);
      const baselineDurationMin = parseDurationToMinutes(route.staticDuration || route.duration);
      const surplusMin = Math.max(0, durationInTrafficMin - baselineDurationMin);

      setResult({
        distanceKm: distanceMeters / 1000,
        distanceText: `${(distanceMeters / 1000).toFixed(1)} km`,
        durationMin: baselineDurationMin,
        durationText: `${baselineDurationMin} min`,
        pickupAddress: origin?.formatted_address || origin?.name || pickupInputRef.current?.value || 'Pickup',
        destinationAddress: destination?.formatted_address || destination?.name || destInputRef.current?.value || 'Destination',
        durationInTrafficMin,
        durationInTrafficText: `${durationInTrafficMin} min`,
        trafficIndex: computeTrafficIndex(durationInTrafficMin, baselineDurationMin),
        surplusMin
      });
      setResolvedStops(waypointStops);
    } catch (routeError: any) {
      const message = String(routeError?.message || 'Routing error');
      const statusCode = Number(routeError?.status || 0);
      if (statusCode === 403 || message.includes('PERMISSION_DENIED') || message.includes('API_KEY') || message.includes('REQUEST_DENIED')) {
        setRoutesApiBlocked(true);
        setError('Routes API returned 403 (Forbidden). Enable Routes API, attach billing, and allow your localhost referrer in key restrictions.');
      } else if (statusCode === 400 || message.includes('INVALID_ARGUMENT')) {
        setError(`Routes API returned 400 (Bad Request): ${message}`);
      } else {
        setError(`Routing error. ${message}`);
      }
      setResolvedStops([]);
    } finally {
      stopCalculationLoading(requestId);
    }
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

  const calculateFare = (route: RouteResult) => {
    const base = Math.ceil(route.distanceKm * (isRoundTrip ? 2 : 1) * settings.ratePerKm);
    const wait = addWaitTime ? Math.ceil(waitTimeHours * settings.hourlyWaitRate) : 0;
    const computedFare = base + wait;
    const minimumFare = Number.isFinite(MIN_RIDE_FARE_USD) ? Math.max(0, MIN_RIDE_FARE_USD) : 7;
    const finalFare = Math.max(minimumFare, computedFare);
    setFareUsd(finalFare);
    setFareLbp(finalFare * settings.exchangeRate);
  };

  const toggleRequirement = (id: string) => {
    setSelectedRequirements(prev => 
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const handleSelectCustomer = (c: Customer) => {
    setSelectedQuoteDirectoryCustomerId(c.id);
    setCustomerName(c.name);
    setCustomerPhone(c.phone);
    syncCustomerPhoneDialState(c.phone);
    setPaymentMode(getCustomerPreferredPaymentMode(c, trips));
    setSearchDirectory('');
    setShowDirectoryResults(false);
  };

  const handleQuickPickCustomer = (pick: { name: string; phone: string }) => {
    const normalizedPhone = customerPhoneKey(pick.phone);
    const matchedCustomer = customers.find(entry => {
      const samePhone = normalizedPhone && customerPhoneKey(entry.phone) === normalizedPhone;
      const sameName = entry.name.trim().toLowerCase() === pick.name.trim().toLowerCase();
      return Boolean(samePhone || sameName);
    }) || null;

    setSelectedQuoteDirectoryCustomerId(null);
    setCustomerName(pick.name);
    setCustomerPhone(pick.phone);
    syncCustomerPhoneDialState(pick.phone);
    setPaymentMode(getCustomerPreferredPaymentMode(matchedCustomer, trips));
    setSearchDirectory('');
    setShowDirectoryResults(false);
    showCalculatorActionToast('Customer loaded from quick picks.');
  };

  const handleResetPreQuoteCustomer = () => {
    setSelectedQuoteDirectoryCustomerId(null);
    setCustomerName('');
    setCustomerPhone('');
    setCustomerPhoneIntlEnabled(false);
    setCustomerPhoneDialCode(DEFAULT_PHONE_DIAL_CODE);
    setCustomerPhoneUseCustomDialCode(false);
    setCustomerPhoneCustomDialCode('');
    setSearchDirectory('');
    setShowDirectoryResults(false);
    setLocationStatusMessage('');
  };

  const handleRefreshDirections = () => {
    inputResolveTokenRef.current += 1;
    clearRoutePath();
    clearStopMarkers();
    setPickupPlace(null);
    setDestPlace(null);
    setPickupOriginalLink(undefined);
    setDestinationOriginalLink(undefined);
    setStopsDraft([]);
    setStopCandidates([]);
    setResolvedStops([]);
    setPendingLocation(null);
    setResult(null);
    setFareUsd(0);
    setFareLbp(0);
    setShowBreakdown(false);
    setError(null);

    if (pickupInputRef.current) pickupInputRef.current.value = '';
    if (destInputRef.current) destInputRef.current.value = '';

    if (mapInstance.current) {
      mapInstance.current.panTo({ lat: 33.8938, lng: 35.5018 });
      mapInstance.current.setZoom(12);
    }

    if (markers.current.pickup) {
      setMarkerPosition(markers.current.pickup, { lat: 33.8938, lng: 35.5018 });
    }
    if (markers.current.dest) {
      setMarkerPosition(markers.current.dest, { lat: 33.8938, lng: 35.5018 });
    }

    showCalculatorActionToast('Directions refreshed. Customer profile kept.');
  };

  const handleSelectDriverFromSuggestions = (driver: Driver) => {
    setSelectedDriverId(driver.id);
    setDriverSearchQuery(`${driver.name} (${driver.plateNumber})`);
    setShowDriverSuggestions(false);
  };

  const handleSetCustomerPriority = (tier: 'VIP' | 'VVIP') => {
    const normalizedPhone = customerPhoneKey(customerPhone.trim());
    const normalizedName = customerName.trim();

    if (!normalizedPhone || !normalizedName) {
      showLocationStatus('Select or enter customer name and phone first.');
      return;
    }

    const existing = customers.find(entry => customerPhoneKey(entry.phone) === normalizedPhone);
    const PRIORITY_MARKER_PATTERN = /\[?\s*(?:v\.?\s*v\.?\s*i\.?\s*p|v\.?\s*i\.?\s*p)\s*\]?/gi;
    const existingNotes = (existing?.notes || '')
      .replace(PRIORITY_MARKER_PATTERN, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
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
    showLocationStatus(`Customer designated as ${tier}.`);
  };

  const applyFrequentPlaceToRoute = (type: 'pickup' | 'dest', location: CustomerLocation) => {
    const candidate = location.mapsLink || location.address;
    const resolved = tryResolveGoogleMapsInput(type, candidate);
    if (!resolved && location.mapsLink && location.address) {
      tryResolveGoogleMapsInput(type, location.address);
    }
    showLocationStatus(`${type === 'pickup' ? 'Pickup' : 'Dropoff'} set from frequent place.`);
  };

  const showLocationStatus = (message: string) => {
    setLocationStatusMessage(message);
    window.setTimeout(() => setLocationStatusMessage(''), 2200);
  };

  const showCalculatorActionToast = (message: string) => {
    setCalcActionToast(message);
    window.setTimeout(() => setCalcActionToast(null), 2200);
  };

  const upsertCustomerLocation = (
    target: 'HOME' | 'BUSINESS' | 'FREQUENT' | 'SMART_PICKUP',
    place: {
      address?: string;
      mapsLink?: string;
      lat?: number;
      lng?: number;
    }
  ) => {
    const normalizedPhone = customerPhoneKey(customerPhone.trim());
    const normalizedName = customerName.trim();
    const normalizedAddress = String(place.address || '').trim();

    if (!normalizedPhone || !normalizedName || !normalizedAddress) {
      showLocationStatus('Set customer name, phone, and location first.');
      return;
    }

    const existing = customers.find(entry => customerPhoneKey(entry.phone) === normalizedPhone);
    const nextLocation: CustomerLocation = {
      label: target === 'HOME' ? 'Home' : target === 'BUSINESS' ? 'Business' : 'Place',
      address: normalizedAddress,
      ...(place.mapsLink ? { mapsLink: place.mapsLink } : {}),
      ...(typeof place.lat === 'number' ? { lat: place.lat } : {}),
      ...(typeof place.lng === 'number' ? { lng: place.lng } : {}),
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
    showLocationStatus(
      target === 'HOME'
        ? 'Pickup saved as Home.'
        : target === 'BUSINESS'
          ? 'Destination saved as Business.'
          : target === 'SMART_PICKUP'
            ? 'Pickup added to Frequent places.'
            : 'Location added to Frequent places.'
    );
  };

  const buildCurrentTripData = (resolvedStopsOverride?: TripStop[]): Trip => {
    const effectiveResolvedStops = resolvedStopsOverride ?? resolvedStops;
    const normalizedCustomerPhone = normalizePhoneForWhatsApp(customerPhone, { defaultDialCode: customerPhoneEffectiveDialCode });
    const pickupLat = readCoordinateFromLocation(pickupPlace?.geometry?.location, 'lat');
    const pickupLng = readCoordinateFromLocation(pickupPlace?.geometry?.location, 'lng');
    const destLat = readCoordinateFromLocation(destPlace?.geometry?.location, 'lat');
    const destLng = readCoordinateFromLocation(destPlace?.geometry?.location, 'lng');

    return {
      id: Date.now(),
      createdAt: new Date().toISOString(),
      customerName: customerName || 'Walk-in Client', 
      customerPhone: normalizedCustomerPhone || customerPhone || 'N/A', 
      driverId: selectedDriverId || undefined,
      paymentMode,
      settlementStatus: 'PENDING',
      pickupText: result!.pickupAddress,
      pickupPlaceId: pickupPlace.place_id || 'GPS', 
      pickupOriginalLink,
      pickupLat: Number.isFinite(pickupLat) ? pickupLat : undefined,
      pickupLng: Number.isFinite(pickupLng) ? pickupLng : undefined,
      destinationText: result!.destinationAddress,
      destinationPlaceId: destPlace.place_id || 'GPS', 
      destinationOriginalLink,
      destLat: Number.isFinite(destLat) ? destLat : undefined,
      destLng: Number.isFinite(destLng) ? destLng : undefined,
      ...(effectiveResolvedStops.length > 0 ? { stops: effectiveResolvedStops } : {}),
      distanceKm: result!.distanceKm,
      distanceText: result!.distanceText, 
      durationMin: result!.durationMin,
      durationText: result!.durationText, 
      durationInTrafficMin: result!.durationInTrafficMin,
      durationInTrafficText: result!.durationInTrafficText, 
      trafficIndex: result!.trafficIndex,
      surplusMin: result!.surplusMin, 
      isRoundTrip, 
      waitTimeHours: addWaitTime ? waitTimeHours : 0,
      fareUsd, 
      fareLbp, 
      exchangeRateSnapshot: settings.exchangeRate, 
      status: TripStatus.QUOTED,
      notes, 
      tripDate: tripDate || new Date().toISOString(),
      specialRequirements: selectedRequirements
    };
  };

  const resolveStopsForSubmission = async (): Promise<TripStop[] | null> => {
    const trimmedStops = stopsDraft.map(value => value.trim()).filter(Boolean);
    if (trimmedStops.length === 0) return [];

    const nextResolvedStops: TripStop[] = [];

    for (let index = 0; index < stopsDraft.length; index += 1) {
      const stopInput = stopsDraft[index]?.trim();
      if (!stopInput) continue;

      const candidate = stopCandidates[index];
      const useCandidate = Boolean(
        candidate &&
        Number.isFinite(candidate.lat) &&
        Number.isFinite(candidate.lng) &&
        candidate.text.trim().toLowerCase() === stopInput.toLowerCase()
      );

      const resolvedStop = useCandidate ? candidate : await resolveStopInput(stopInput);
      if (!resolvedStop || !Number.isFinite(resolvedStop.lat) || !Number.isFinite(resolvedStop.lng)) {
        return null;
      }

      nextResolvedStops.push(resolvedStop);
    }

    return nextResolvedStops;
  };

  const handleSaveTrip = async () => {
    if (!result) {
      setError('Please compute a route first before saving dispatch.');
      return;
    }

    if (selectedDriverId) {
      const assignable = drivers.some(
        d => d.id === selectedDriverId && d.status === 'ACTIVE'
      );
      if (!assignable) {
        setError('Selected driver is not currently assignable. Re-select driver or continue without assignment.');
        setSelectedDriverId('');
        return;
      }
    }

    const resolvedStopsForSave = await resolveStopsForSubmission();
    if (!resolvedStopsForSave) {
      setError('Resolve all stops before saving dispatch.');
      return;
    }

    try {
      setResolvedStops(resolvedStopsForSave);
      const resolvedTexts = resolvedStopsForSave.map(stop => stop.text);
      setStopsDraft(resolvedTexts);
      setStopCandidates(resolvedStopsForSave);

      const tripData = buildCurrentTripData(resolvedStopsForSave);
      addTrip(tripData);
      setLastSavedTrip(tripData);
      setShowMessageModal(true);
      setTripSaved(true);
      setDateRequiredError(false);
      setError(null);
      setSelectedQuoteDirectoryCustomerId(null);
      setCustomerName('');
      setCustomerPhone('');
      setCustomerPhoneIntlEnabled(false);
      setCustomerPhoneDialCode(DEFAULT_PHONE_DIAL_CODE);
      setCustomerPhoneUseCustomDialCode(false);
      setCustomerPhoneCustomDialCode('');
      setSelectedDriverId('');
      setPaymentMode('CASH');
      setTripDate('');
      setSelectedRequirements([]);
      setNotes('');
      localStorage.removeItem(CALCULATOR_DRAFT_KEY);
      setTimeout(() => setTripSaved(false), 3000);
    } catch {
      setError('Failed to save dispatch. Please retry.');
    }
  };

  const handleQuickCopyQuote = () => {
    if (!result) return;
    const trimmedStops = stopsDraft.map(value => value.trim()).filter(Boolean);
    if (trimmedStops.length > 0 && resolvedStops.length !== trimmedStops.length) {
      setError('Resolve all stops before copying quote.');
      return;
    }
    const tempTrip = buildCurrentTripData();
    const quoteMsg = replacePlaceholders(settings.templates.trip_confirmation, tempTrip, drivers, settings);
    navigator.clipboard.writeText(sanitizeCommunicationText(quoteMsg));
    setQuickCopied(true);
    setTimeout(() => setQuickCopied(false), 2000);
  };

  const handleQuickWhatsAppQuote = () => {
    if (!result) return;
    const trimmedStops = stopsDraft.map(value => value.trim()).filter(Boolean);
    if (trimmedStops.length > 0 && resolvedStops.length !== trimmedStops.length) {
      setError('Resolve all stops before sending quote.');
      return;
    }
    const tempTrip = buildCurrentTripData();
    const quoteMsg = sanitizeCommunicationText(replacePlaceholders(settings.templates.trip_confirmation, tempTrip, drivers, settings));
    const link = buildWhatsAppLink(customerPhone, quoteMsg);

    if (!link) {
      setError('Add a valid client phone to send via WhatsApp.');
      return;
    }

    window.open(link, '_blank', 'noopener,noreferrer');
  };

  const handleQuickOperatorWhatsAppQuote = () => {
    if (!result) return;
    const trimmedStops = stopsDraft.map(value => value.trim()).filter(Boolean);
    if (trimmedStops.length > 0 && resolvedStops.length !== trimmedStops.length) {
      setError('Resolve all stops before sending quote.');
      return;
    }
    const tempTrip = buildCurrentTripData();
    const quoteMsg = sanitizeCommunicationText(replacePlaceholders(settings.templates.trip_confirmation, tempTrip, drivers, settings));
    const link = buildWhatsAppLink(settings.operatorWhatsApp, quoteMsg);

    if (!link) {
      setError('Set a valid Operator WhatsApp number in Settings to use quick operator send.');
      return;
    }

    window.open(link, '_blank', 'noopener,noreferrer');
  };

  const confirmPendingStop = () => {
    if (!pendingLocation || !pickupPlace || !destPlace) return;

    const loc = new google.maps.LatLng(pendingLocation.lat, pendingLocation.lng);
    geocoder.current.geocode({ location: loc }, (res: any, status: any) => {
      const addr = (status === 'OK' && res[0])
        ? res[0].formatted_address
        : `${pendingLocation.lat.toFixed(4)}, ${pendingLocation.lng.toFixed(4)}`;

      const nextStop: TripStop = {
        text: addr,
        placeId: res?.[0]?.place_id || 'MAP_PIN_STOP',
        lat: pendingLocation.lat,
        lng: pendingLocation.lng,
      };

      setStopsDraft(prev => [...prev, addr]);
      setStopCandidates(prev => [...prev, nextStop]);
      setPendingLocation(null);
      showLocationStatus('Stop pinned from map.');
    });
  };

  const canPinStopsFromMap = Boolean(pickupPlace && destPlace);

  const requirementIcon = (requirementId: string) => {
    switch (requirementId) {
      case 'quiet':
        return <VolumeX size={11} aria-hidden="true" />;
      case 'rest':
        return <Moon size={11} aria-hidden="true" />;
      case 'luggage':
        return <Briefcase size={11} aria-hidden="true" />;
      case 'passenger4':
        return <Users size={11} aria-hidden="true" />;
      case 'child_seat':
        return <Baby size={11} aria-hidden="true" />;
      case 'suv':
        return <Car size={11} aria-hidden="true" />;
      case 'van':
        return <Bus size={11} aria-hidden="true" />;
      case 'pet':
        return <PawPrint size={11} aria-hidden="true" />;
      case 'wheelchair':
        return <Accessibility size={11} aria-hidden="true" />;
      case 'compound_access':
        return <KeyRound size={11} aria-hidden="true" />;
      case 'smoking':
        return <Cigarette size={11} aria-hidden="true" />;
      case 'no_smoking':
        return <CigaretteOff size={11} aria-hidden="true" />;
      case 'stops':
        return <MapPin size={11} aria-hidden="true" />;
      default:
        return <AlertCircle size={11} aria-hidden="true" />;
    }
  };

  const fareComputation = useMemo(() => {
    if (!result) {
      return {
        computedFareUsd: 0,
        minimumFareUsd: Math.max(0, MIN_RIDE_FARE_USD),
        minimumFareApplied: false,
      };
    }

    const base = Math.ceil(result.distanceKm * (isRoundTrip ? 2 : 1) * settings.ratePerKm);
    const wait = addWaitTime ? Math.ceil(waitTimeHours * settings.hourlyWaitRate) : 0;
    const computedFareUsd = base + wait;
    const minimumFareUsd = Math.max(0, MIN_RIDE_FARE_USD);

    return {
      computedFareUsd,
      minimumFareUsd,
      minimumFareApplied: computedFareUsd < minimumFareUsd,
    };
  }, [result, isRoundTrip, addWaitTime, waitTimeHours, settings.ratePerKm, settings.hourlyWaitRate]);

  const confirmPending = (type: 'pickup' | 'dest') => {
    const loc = new google.maps.LatLng(pendingLocation!.lat, pendingLocation!.lng);
    geocoder.current.geocode({ location: loc }, (res: any, status: any) => {
      const addr = (status === 'OK' && res[0]) ? res[0].formatted_address : `${pendingLocation!.lat.toFixed(4)}, ${pendingLocation!.lng.toFixed(4)}`;
      const pRes = { place_id: res?.[0]?.place_id, geometry: { location: loc }, formatted_address: addr, name: addr };
      if (type === 'pickup') { setPickupPlace(pRes); setPickupOriginalLink(undefined); setMarkerPosition(markers.current.pickup, loc); if (pickupInputRef.current) pickupInputRef.current.value = addr; }
      else { setDestPlace(pRes); setDestinationOriginalLink(undefined); setMarkerPosition(markers.current.dest, loc); if (destInputRef.current) destInputRef.current.value = addr; }
      setPendingLocation(null);
    });
  };

  const setMissionTimePreset = (minutesFromNow: number) => {
    const normalizedMinutes = minutesFromNow <= 0 ? DISPATCH_NOW_DEFAULT_MINUTES : minutesFromNow;
    const nextDate = format(addMinutes(new Date(), normalizedMinutes), "yyyy-MM-dd'T'HH:mm");
    setTripDate(nextDate);
    setTodayTimeQuickInput('');
    setDateRequiredError(false);
  };

  const applyTodayTimeQuickInput = () => {
    const raw = todayTimeQuickInput.trim().toLowerCase();
    if (!raw) return;

    let parsedHour: number | null = null;
    let parsedMinute = 0;
    let meridiem: 'am' | 'pm' | null = null;

    const meridiemMatch = raw.match(/(am|pm|a|p)$/i);
    if (meridiemMatch) {
      meridiem = meridiemMatch[1].toLowerCase().startsWith('p') ? 'pm' : 'am';
    }

    const cleaned = raw.replace(/\s+/g, '').replace(/(am|pm|a|p)$/i, '').replace('.', ':');
    const colonMatch = cleaned.match(/^(\d{1,2}):(\d{1,2})$/);
    const compactMatch = cleaned.match(/^(\d{3,4})$/);
    const hourOnlyMatch = cleaned.match(/^(\d{1,2})$/);

    if (colonMatch) {
      parsedHour = Number(colonMatch[1]);
      parsedMinute = Number(colonMatch[2]);
    } else if (compactMatch) {
      const digits = compactMatch[1];
      parsedHour = Number(digits.slice(0, digits.length - 2));
      parsedMinute = Number(digits.slice(-2));
    } else if (hourOnlyMatch) {
      parsedHour = Number(hourOnlyMatch[1]);
      parsedMinute = 0;
    }

    if (parsedHour === null || !Number.isFinite(parsedHour) || !Number.isFinite(parsedMinute) || parsedMinute < 0 || parsedMinute > 59) {
      showCalculatorActionToast('Time format not recognized. Try 14:30 or 2:30pm.');
      return;
    }

    if (meridiem) {
      if (parsedHour < 1 || parsedHour > 12) {
        showCalculatorActionToast('12h time should be between 1 and 12.');
        return;
      }
      if (meridiem === 'pm' && parsedHour < 12) parsedHour += 12;
      if (meridiem === 'am' && parsedHour === 12) parsedHour = 0;
    }

    if (parsedHour < 0 || parsedHour > 23) {
      showCalculatorActionToast('Hour should be between 0 and 23.');
      return;
    }

    const now = new Date();
    const minimumToday = addMinutes(now, DISPATCH_NOW_MIN_MINUTES);
    const nextDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsedHour, parsedMinute, 0, 0);

    const normalizedDate = nextDate < minimumToday ? minimumToday : nextDate;
    setTripDate(format(normalizedDate, "yyyy-MM-dd'T'HH:mm"));
    setTodayTimeQuickInput('');
    setDateRequiredError(false);
    if (nextDate < minimumToday) {
      showCalculatorActionToast(`Time adjusted to minimum dispatch window (+${DISPATCH_NOW_MIN_MINUTES}m).`);
      return;
    }
    showCalculatorActionToast('Today time applied to schedule.');
  };

  const sequenceStages = useMemo(() => ([
    { key: 'ROUTE' as const, label: 'Route + Map' },
    { key: 'CUSTOMER' as const, label: 'Customer' },
    { key: 'OUTPUT' as const, label: 'Output' },
  ]), []);

  const activeSequenceIndex = useMemo(() => {
    const index = sequenceStages.findIndex(stage => stage.key === activeSequenceStage);
    return index >= 0 ? index : 0;
  }, [activeSequenceStage, sequenceStages]);

  const activeSequenceStageLabel = useMemo(() => {
    return sequenceStages[activeSequenceIndex]?.label || 'Route + Map';
  }, [activeSequenceIndex, sequenceStages]);

  const moveSequenceStage = (direction: 'next' | 'prev') => {
    const offset = direction === 'next' ? 1 : -1;
    const nextIndex = Math.max(0, Math.min(sequenceStages.length - 1, activeSequenceIndex + offset));
    setActiveSequenceStage(sequenceStages[nextIndex].key);
  };

  const stageElementIdByKey: Record<CalculatorSequenceStage, string> = {
    ROUTE: 'calc-stage-route',
    CUSTOMER: 'calc-stage-customer',
    OUTPUT: 'calc-stage-dispatch',
  };

  const focusAndActivateSequenceDockStage = (nextIndex: number) => {
    const boundedIndex = Math.max(0, Math.min(sequenceStages.length - 1, nextIndex));
    const nextStage = sequenceStages[boundedIndex];
    if (!nextStage) return;
    setActiveSequenceStage(nextStage.key);
    sequenceDockStageButtonRefs.current[boundedIndex]?.focus();
  };

  const handleSequenceDockGridKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    const total = sequenceStages.length;
    if (total <= 0) return;

    const columns = window.matchMedia('(min-width: 640px)').matches ? Math.min(3, total) : 1;
    let nextIndex = currentIndex;

    if (event.key === 'ArrowRight') {
      nextIndex = currentIndex + 1;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = currentIndex - 1;
    } else if (event.key === 'ArrowDown') {
      nextIndex = currentIndex + columns;
    } else if (event.key === 'ArrowUp') {
      nextIndex = currentIndex - columns;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = total - 1;
    } else {
      return;
    }

    event.preventDefault();
    focusAndActivateSequenceDockStage(nextIndex);
  };

  const renderSequenceWorkflowDock = () => {
    if (navigationMode !== 'SEQUENCE') return null;

    return (
      <div className={`mt-4 rounded-2xl border border-gold-500/30 bg-brand-950/90 ring-1 ring-gold-500/15 shadow-lg shadow-brand-950/30 backdrop-blur-sm ${isSequenceWorkflowDockCollapsed ? 'p-1.5' : 'p-2.5 sm:p-3'}`}>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setIsSequenceWorkflowDockCollapsed(prev => !prev)}
            aria-expanded={!isSequenceWorkflowDockCollapsed}
            className="flex-1 min-w-0 text-left inline-flex items-center gap-1.5 text-[8px] sm:text-[9px] font-black uppercase tracking-widest text-gold-300"
            title={isSequenceWorkflowDockCollapsed ? 'Expand workflow dock' : 'Collapse workflow dock'}
          >
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-gold-400" />
            <span className="truncate">
              Workflow Dock · Step {activeSequenceIndex + 1}/{sequenceStages.length}
              {isSequenceWorkflowDockCollapsed ? ` · ${activeSequenceStageLabel}` : ''}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setIsSequenceWorkflowDockCollapsed(prev => !prev)}
            className={`${isSequenceWorkflowDockCollapsed ? 'h-5 w-5 px-0 justify-center rounded-md border-transparent bg-transparent text-slate-300 hover:bg-white/10' : 'h-6 px-2 text-[7px] rounded-full border border-gold-500/30 bg-white/10 text-gold-200 hover:border-gold-400/50'} font-black uppercase tracking-widest inline-flex items-center gap-1 transition-colors`}
            title={isSequenceWorkflowDockCollapsed ? 'Expand workflow dock' : 'Collapse workflow dock'}
          >
            {isSequenceWorkflowDockCollapsed ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
            {!isSequenceWorkflowDockCollapsed && 'Hide'}
          </button>
        </div>

        {!isSequenceWorkflowDockCollapsed && (
          <>
            <div className="mt-2 flex items-center justify-end">
              <div className="inline-flex items-center rounded-lg border border-gold-500/30 bg-brand-900/60 p-0.5">
                <button
                  type="button"
                  onClick={() => setNavigationMode('SCROLL')}
                  className={`h-7 px-2.5 rounded-md text-[8px] font-black uppercase tracking-widest transition-colors ${navigationMode === 'SCROLL' ? 'bg-gold-500/20 text-gold-300' : 'text-slate-300'}`}
                >
                  Scroll
                </button>
                <button
                  type="button"
                  onClick={() => setNavigationMode('SEQUENCE')}
                  className={`h-7 px-2.5 rounded-md text-[8px] font-black uppercase tracking-widest transition-colors ${navigationMode === 'SEQUENCE' ? 'bg-gold-500/20 text-gold-300' : 'text-slate-300'}`}
                >
                  Sequence
                </button>
              </div>
            </div>

            <div role="grid" aria-label="Workflow stages" className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-1.5">
              {sequenceStages.map((stage, index) => {
                const isActive = stage.key === activeSequenceStage;
                return (
                  <button
                    key={`dock-${stage.key}`}
                    ref={element => {
                      sequenceDockStageButtonRefs.current[index] = element;
                    }}
                    type="button"
                    onClick={() => {
                      setActiveSequenceStage(stage.key);
                      setIsSequenceWorkflowDockCollapsed(true);
                    }}
                    onKeyDown={event => handleSequenceDockGridKeyDown(event, index)}
                    aria-current={isActive ? 'step' : undefined}
                    className={`h-9 sm:h-10 w-full px-3 rounded-lg border text-[8px] sm:text-[9px] font-black uppercase tracking-widest transition-all active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-500/70 ${isActive ? 'border-gold-400 bg-gold-500/15 text-gold-200 shadow-sm shadow-gold-500/10' : 'border-brand-700 bg-brand-900/50 text-slate-300 hover:border-gold-500/30 hover:text-gold-200'}`}
                  >
                    {stage.label}
                  </button>
                );
              })}
            </div>

            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => {
                  moveSequenceStage('prev');
                  setIsSequenceWorkflowDockCollapsed(true);
                }}
                disabled={activeSequenceIndex === 0}
                className="h-8 px-3 rounded-lg border border-brand-700 bg-brand-900/50 text-[8px] font-black uppercase tracking-widest text-slate-200 hover:border-gold-500/30 hover:text-gold-200 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Previous step"
              >
                ← Prev
              </button>
              <button
                type="button"
                onClick={() => {
                  moveSequenceStage('next');
                  setIsSequenceWorkflowDockCollapsed(true);
                }}
                disabled={activeSequenceIndex >= sequenceStages.length - 1}
                className="h-8 px-3 rounded-lg border border-brand-700 bg-brand-900/50 text-[8px] font-black uppercase tracking-widest text-slate-200 hover:border-gold-500/30 hover:text-gold-200 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Next step"
              >
                Next →
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  const scrollElementIntoViewForMode = (element: HTMLElement | null, behavior: ScrollBehavior = 'smooth') => {
    const panel = panelScrollRef.current;
    const workflow = workflowControlsRef.current;
    if (!element) return;

    const spacing = 10;
    const panelCanScroll = Boolean(panel && panel.scrollHeight > panel.clientHeight + 1);
    if (panel && panelCanScroll) {
      const panelRect = panel.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const elementTopWithinPanel = elementRect.top - panelRect.top + panel.scrollTop;
      let targetScrollTop = Math.max(0, elementTopWithinPanel - spacing);

      if (navigationMode === 'SCROLL' && workflow) {
        const workflowRect = workflow.getBoundingClientRect();
        const workflowBottomWithinPanel = workflowRect.bottom - panelRect.top + panel.scrollTop;
        targetScrollTop = Math.max(0, elementTopWithinPanel - workflowBottomWithinPanel - spacing);
      }

      panel.scrollTo({ top: targetScrollTop, behavior });
      return;
    }

    const elementRect = element.getBoundingClientRect();
    let targetWindowTop = Math.max(0, window.scrollY + elementRect.top - spacing);
    if (navigationMode === 'SCROLL' && workflow) {
      const workflowRect = workflow.getBoundingClientRect();
      targetWindowTop = Math.max(0, window.scrollY + (elementRect.top - workflowRect.bottom) - spacing);
    }

    window.scrollTo({ top: targetWindowTop, behavior });
  };

  const isRouteStageVisible = navigationMode !== 'SEQUENCE' || activeSequenceStage === 'ROUTE';
  const isCustomerSequenceSnapshotPanelVisible = Boolean(
    navigationMode === 'SEQUENCE' &&
    activeSequenceStage === 'CUSTOMER' &&
    isQuoteDirectorySelectionActive &&
    quoteCustomerSnapshot &&
    hasExistingCustomerSnapshotInfo
  );
  const outputChecklist = [
    { label: 'Trip date selected', ready: Boolean(tripDate) },
    { label: 'Customer identified', ready: Boolean(customerName.trim() || customerPhone.trim()) },
    { label: 'Driver assigned', ready: Boolean(selectedDriverId) },
    { label: 'Payment mode selected', ready: paymentMode === 'CASH' || paymentMode === 'CREDIT' },
    { label: 'Route computed', ready: Boolean(result) },
  ];
  const outputBlockingChecks = outputChecklist.filter(check => !check.ready);
  const outputRiskFlags = [
    result && result.trafficIndex >= 70
      ? { key: 'traffic-index', label: `Traffic index ${Math.round(result.trafficIndex)}/100`, icon: 'TRAFFIC' as const }
      : null,
    result && result.surplusMin >= 12
      ? { key: 'traffic-surplus', label: `Traffic surplus +${Math.max(0, Math.round(result.surplusMin))} min`, icon: 'DELAY' as const }
      : null,
    fareComputation.minimumFareApplied
      ? { key: 'min-fare', label: `Minimum fare floor applied ($${fareComputation.minimumFareUsd})`, icon: 'FARE' as const }
      : null,
    paymentMode === 'CREDIT' && !customerPhone.trim()
      ? { key: 'credit-phone', label: 'Credit mode selected without customer phone', icon: 'PAYMENT' as const }
      : null,
  ].filter((flag): flag is NonNullable<typeof flag> => Boolean(flag));
  const outputNeedsAttention = outputBlockingChecks.length > 0 || outputRiskFlags.length > 0;
  const isOutputSequenceDriverInsightPanelVisible = Boolean(
    navigationMode === 'SEQUENCE' &&
    activeSequenceStage === 'OUTPUT' &&
    result &&
    Boolean(outputDriverInsightTarget) &&
    (showDriverSuggestions || Boolean(selectedDriverId) || Boolean(debouncedDriverSearchQuery.trim()))
  );
  const isOutputSequenceReadinessPanelVisible = Boolean(
    navigationMode === 'SEQUENCE' &&
    activeSequenceStage === 'OUTPUT' &&
    result &&
    outputNeedsAttention &&
    !isOutputReadinessPanelDismissed &&
    !isOutputSequenceDriverInsightPanelVisible
  );
  const hasSequenceRightCompanionPanel = Boolean(
    navigationMode === 'SEQUENCE' && (
      activeSequenceStage === 'ROUTE' ||
      isCustomerSequenceSnapshotPanelVisible ||
      isOutputSequenceDriverInsightPanelVisible ||
      isOutputSequenceReadinessPanelVisible
    )
  );
  const outputNotesPreview = notes.trim();
  const shouldRenderPreOutputStages = navigationMode === 'SCROLL' || activeSequenceStage !== 'OUTPUT';
  const calculatorPanelWidthClass = navigationMode === 'SEQUENCE'
    ? (hasSequenceRightCompanionPanel
      ? 'lg:w-[44%] xl:w-[42%] 2xl:w-[40%] lg:max-w-[44rem] border-r border-slate-200 dark:border-brand-800 min-w-0'
      : 'lg:flex-1 border-r-0 min-w-0')
    : (isRouteStageVisible ? 'lg:w-96 border-r border-slate-200 dark:border-brand-800 min-w-0' : 'lg:flex-1 border-r-0 min-w-0');

  useEffect(() => {
    if (!outputNeedsAttention) {
      setIsOutputReadinessPanelDismissed(false);
    }
  }, [outputNeedsAttention]);

  useEffect(() => {
    if (navigationMode !== 'SEQUENCE' || activeSequenceStage !== 'OUTPUT') return;
    if (outputNeedsAttention && isOutputReadinessPanelDismissed) {
      return;
    }
    if (!outputNeedsAttention) {
      setIsOutputReadinessPanelDismissed(false);
    }
  }, [navigationMode, activeSequenceStage, outputNeedsAttention, isOutputReadinessPanelDismissed]);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target.closest('[contenteditable="true"]'));
    };

    const handleSequenceArrowKeys = (event: KeyboardEvent) => {
      if (navigationMode !== 'SEQUENCE') return;
      if (isTypingTarget(event.target)) return;

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        moveSequenceStage('prev');
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        moveSequenceStage('next');
      }
    };

    window.addEventListener('keydown', handleSequenceArrowKeys);
    return () => window.removeEventListener('keydown', handleSequenceArrowKeys);
  }, [navigationMode, moveSequenceStage]);

  useEffect(() => {
    if (navigationMode === 'SEQUENCE' && activeSequenceStage === 'OUTPUT') {
      return;
    }

    let raf1 = 0;
    let raf2 = 0;

    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        const targetElement = navigationMode === 'SCROLL'
          ? workflowControlsRef.current
          : activeSequenceStage === 'OUTPUT'
            ? saveDispatchAnchorRef.current
            : document.getElementById(stageElementIdByKey[activeSequenceStage]);
        scrollElementIntoViewForMode(targetElement, 'smooth');
      });
    });

    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [navigationMode, activeSequenceStage]);

  return (
    <div className="flex flex-col lg:flex-row min-h-screen lg:min-h-0 lg:h-full lg:overflow-hidden bg-slate-50 dark:bg-brand-950 transition-all duration-300">
      <div ref={panelScrollRef} className={`${calculatorPanelWidthClass} flex flex-col h-auto lg:h-full min-h-0 bg-white dark:bg-brand-900 z-10 shadow-xl overflow-y-auto overscroll-contain scroll-smooth [scrollbar-gutter:stable] transition-all duration-300`}>
        <div className="bg-brand-950 px-4 py-2 flex justify-between items-center border-b border-brand-800">
           <div className="flex items-center space-x-2">
             <div className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
             <span className="text-[8px] font-black text-slate-400 uppercase tracking-[0.2em]">${settings.ratePerKm}/km Rate Active</span>
           </div>
           <span className="text-[8px] font-black text-slate-400 uppercase tracking-[0.2em]">{settings.exchangeRate.toLocaleString()} LBP/$</span>
        </div>

        <div className={`p-4 sm:p-5 space-y-6 ${navigationMode === 'SEQUENCE' ? 'xl:px-7 2xl:px-9' : ''}`}>
           {error && (
             <div className="p-3 rounded-xl border border-red-200 bg-red-50 text-red-700 text-[10px] font-black uppercase tracking-wide">
               {error}
             </div>
           )}
           {locationStatusMessage && (
             <div className="p-3 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 text-[10px] font-black uppercase tracking-wide">
               {locationStatusMessage}
             </div>
           )}
           {navigationMode === 'SCROLL' && (
           <div ref={workflowControlsRef} className={`rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 ${isNavigationControlsCollapsed ? 'p-1 space-y-0.5' : 'p-2.5 space-y-2'}`}>
             <div className="flex items-center justify-between gap-2">
               <button
                 type="button"
                 onClick={() => setIsNavigationControlsCollapsed(prev => !prev)}
                 aria-expanded={!isNavigationControlsCollapsed}
                 className="flex-1 min-w-0 text-left text-[9px] font-black text-slate-500 dark:text-slate-300 uppercase tracking-widest"
                 title={isNavigationControlsCollapsed ? 'Expand workflow controls' : 'Minimize workflow controls'}
               >
                 <span className="truncate inline-block max-w-full">
                   Workflow Mode{isNavigationControlsCollapsed ? ` · ${navigationMode === 'SEQUENCE' ? `Sequence${activeSequenceStageLabel ? `/${activeSequenceStageLabel}` : ''}` : 'Scroll'}` : ''}
                 </span>
               </button>
               <button
                 type="button"
                 onClick={() => setIsNavigationControlsCollapsed(prev => !prev)}
                 className={`${isNavigationControlsCollapsed ? 'h-5 px-1.5 text-[6px] rounded-md border-transparent bg-transparent text-slate-500/80 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-brand-900/60' : 'h-6 px-2 text-[7px] rounded-full border border-slate-200/80 dark:border-brand-700 bg-white/90 dark:bg-brand-900/80 text-slate-500 dark:text-slate-300 hover:border-slate-300 dark:hover:border-brand-600'} font-black uppercase tracking-widest inline-flex items-center gap-1 transition-colors`}
                 title={isNavigationControlsCollapsed ? 'Expand workflow controls' : 'Minimize workflow controls'}
               >
                 {isNavigationControlsCollapsed ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
                 {isNavigationControlsCollapsed ? 'Expand' : 'Minimize'}
               </button>
             </div>

             {!isNavigationControlsCollapsed && (
               <>
                 <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2">
                   <div className="inline-flex w-full sm:w-auto items-center rounded-lg border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 p-0.5">
                     <button
                       type="button"
                       onClick={() => setNavigationMode('SCROLL')}
                       className={`h-8 lg:h-9 flex-1 sm:flex-none px-3 lg:px-3.5 rounded-md text-[8px] lg:text-[9px] font-black uppercase tracking-widest transition-colors ${navigationMode === 'SCROLL' ? 'bg-brand-900 text-gold-400' : 'text-slate-500 dark:text-slate-300'}`}
                     >
                       Scroll
                     </button>
                     <button
                       type="button"
                       onClick={() => setNavigationMode('SEQUENCE')}
                       className={`h-8 lg:h-9 flex-1 sm:flex-none px-3 lg:px-3.5 rounded-md text-[8px] lg:text-[9px] font-black uppercase tracking-widest transition-colors ${navigationMode === 'SEQUENCE' ? 'bg-brand-900 text-gold-400' : 'text-slate-500 dark:text-slate-300'}`}
                     >
                       Sequence
                     </button>
                   </div>

                   {navigationMode === 'SEQUENCE' && (
                     <div className="inline-flex w-full lg:w-auto items-center gap-1">
                       <button
                         type="button"
                         onClick={() => moveSequenceStage('prev')}
                         disabled={activeSequenceIndex === 0}
                         className="h-8 lg:h-9 flex-1 lg:flex-none px-3 rounded-md border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-[8px] lg:text-[9px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
                         title="Previous step (←)"
                       >
                         ← Prev
                       </button>
                       <button
                         type="button"
                         onClick={() => moveSequenceStage('next')}
                         disabled={activeSequenceIndex >= sequenceStages.length - 1}
                         className="h-8 lg:h-9 flex-1 lg:flex-none px-3 rounded-md border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-[8px] lg:text-[9px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
                         title="Next step (→)"
                       >
                         Next →
                       </button>
                     </div>
                   )}
                 </div>

                 {navigationMode === 'SEQUENCE' && (
                   <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                     {sequenceStages.map(stage => {
                       const isActive = stage.key === activeSequenceStage;
                       return (
                         <button
                           key={stage.key}
                           type="button"
                           onClick={() => setActiveSequenceStage(stage.key)}
                           className={`h-8 lg:h-9 w-full px-3 rounded-md border text-[8px] lg:text-[9px] font-black uppercase tracking-widest transition-colors ${isActive ? 'border-gold-400 bg-gold-500/15 text-gold-700 dark:text-gold-300' : 'border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-slate-500 dark:text-slate-300'}`}
                         >
                           {stage.label}
                         </button>
                       );
                     })}
                   </div>
                 )}
               </>
             )}
           </div>
             )}

           {shouldRenderPreOutputStages && (
           <div className="space-y-4">
             {(navigationMode === 'SCROLL' || activeSequenceStage === 'ROUTE') && (
             <div className={`space-y-4 ${navigationMode === 'SEQUENCE' ? 'animate-in fade-in slide-in-from-right-2 duration-200' : ''}`}>
              <div id="calc-stage-route" className="space-y-3">
                 <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gold-600"><MapPin size={14} /></div>
                    <input
                      ref={pickupInputRef}
                      type="text"
                      className="pl-9 w-full h-11 rounded-xl border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-xs"
                      placeholder="Pickup Address or Google Maps Link..."
                      onBlur={(e) => {
                        tryResolveGoogleMapsInput('pickup', e.currentTarget.value);
                      }}
                      onPaste={(e) => {
                        const pasted = e.clipboardData.getData('text');
                        if (tryResolveGoogleMapsInput('pickup', pasted)) {
                          e.preventDefault();
                        }
                      }}
                    />
                 </div>
                 <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-blue-500"><Navigation size={14} /></div>
                    <input
                      ref={destInputRef}
                      type="text"
                      className="pl-9 w-full h-11 rounded-xl border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-xs"
                      placeholder="Drop-off Address or Google Maps Link..."
                      onBlur={(e) => {
                        tryResolveGoogleMapsInput('dest', e.currentTarget.value);
                      }}
                      onPaste={(e) => {
                        const pasted = e.clipboardData.getData('text');
                        if (tryResolveGoogleMapsInput('dest', pasted)) {
                          e.preventDefault();
                        }
                      }}
                    />
                 </div>
                 <div className={`space-y-2 rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 ${isStopsCollapsed ? 'p-1.5' : 'p-3'}`}>
                   <div className="flex items-center justify-between">
                     <label className="inline-flex items-center gap-1 text-[9px] font-black text-slate-500 uppercase tracking-widest">
                       <MapPin size={11} />
                       Stops (Optional){isStopsCollapsed ? ` · ${stopsDraft.length}` : ''}
                     </label>
                     <div className="flex items-center gap-1">
                       <button
                         type="button"
                         onClick={() => setIsStopsCollapsed(prev => !prev)}
                         className={`${isStopsCollapsed ? 'h-5 w-5 px-0 justify-center rounded-md border-transparent bg-transparent text-slate-500/80 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-brand-900/60' : 'h-6 px-2 text-[7px] rounded-full border border-slate-200/80 dark:border-brand-700 bg-white/90 dark:bg-brand-900/80 text-slate-500 dark:text-slate-300 hover:border-slate-300 dark:hover:border-brand-600'} font-black uppercase tracking-widest inline-flex items-center gap-1 transition-colors`}
                         title={isStopsCollapsed ? 'Expand stops' : 'Collapse stops'}
                       >
                         {isStopsCollapsed ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
                         {!isStopsCollapsed && 'Hide'}
                       </button>
                       <button
                         type="button"
                         onClick={addStopField}
                         className={`${isStopsCollapsed ? 'h-5 px-1.5 text-[6px]' : 'h-6 px-2 text-[7px]'} rounded-md border border-slate-300 dark:border-brand-700 bg-slate-50 dark:bg-brand-950 font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 inline-flex items-center gap-1`}
                       >
                         <MapPin size={10} />
                         Add Stop
                       </button>
                     </div>
                   </div>
                   {isStopsCollapsed ? null : stopsDraft.length > 0 ? (
                     <div className="space-y-2">
                       {stopsDraft.map((stopValue, index) => {
                         const isResolved = Boolean(stopCandidates[index] && Number.isFinite(stopCandidates[index]?.lat) && Number.isFinite(stopCandidates[index]?.lng));
                         return (
                         <div key={`stop-${index}`} className="flex items-center gap-2">
                           <div className="h-9 w-9 rounded-lg border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-slate-500 dark:text-slate-300 inline-flex items-center justify-center">
                             <MapPin size={11} />
                           </div>
                           <input
                             type="text"
                             ref={element => {
                               stopInputRefs.current[index] = element;
                             }}
                             value={stopValue}
                             onChange={event => updateStopField(index, event.target.value)}
                             onBlur={async event => {
                               const trimmed = event.currentTarget.value.trim();
                               let alreadyResolved = false;
                               setStopsDraft(prev => prev.map((entry, i) => (i === index ? trimmed : entry)));
                               setStopCandidates(prev => prev.map((entry, i) => {
                                 if (i !== index) return entry;
                                 const keep = Boolean(entry && entry.text.trim().toLowerCase() === trimmed.toLowerCase() && Number.isFinite(entry.lat) && Number.isFinite(entry.lng));
                                 alreadyResolved = keep;
                                 return keep ? entry : null;
                               }));
                               if (!trimmed) return;
                               if (alreadyResolved) return;

                               const resolved = await resolveStopInput(trimmed);
                               if (!resolved) return;

                               setStopsDraft(prev => prev.map((entry, i) => (i === index ? resolved.text : entry)));
                               setStopCandidates(prev => prev.map((entry, i) => (i === index ? resolved : entry)));
                             }}
                             placeholder={`Stop ${index + 1} address or maps link`}
                             className="flex-1 h-9 rounded-lg border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 px-3 text-[10px] font-bold"
                           />
                           <span
                             title={isResolved ? 'Resolved from map data' : 'Pending resolution'}
                             className={`h-9 px-2 rounded-lg border text-[7px] font-black uppercase tracking-widest inline-flex items-center gap-1 ${isResolved
                               ? 'border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10'
                               : 'border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-900/40 dark:text-amber-300 dark:bg-amber-900/10'}`}
                           >
                             {isResolved ? <Check size={10} /> : <Hourglass size={10} />}
                             {isResolved ? 'OK' : 'Pending'}
                           </span>
                           <button
                             type="button"
                             onClick={() => removeStopField(index)}
                             className="h-9 w-9 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 text-red-600 dark:text-red-300 inline-flex items-center justify-center"
                           >
                             <X size={12} />
                           </button>
                         </div>
                         );
                       })}
                     </div>
                   ) : (
                     <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 inline-flex items-center gap-1">
                       <AlertCircle size={10} />
                       No stops added.
                     </p>
                   )}
                 </div>
                 <div className="flex justify-end">
                   <button
                     type="button"
                     onClick={handleRefreshDirections}
                     className="h-8 px-3 rounded-lg border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 inline-flex items-center gap-1"
                   >
                     <RefreshCcw size={10} />
                     Refresh Directions
                   </button>
                 </div>
              </div>

                  <div id="calc-stage-schedule" className="space-y-2">
                    <div className="flex items-center justify-between gap-2 px-1">
                      <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest inline-flex items-center gap-1">
                        <Calendar size={11} />
                        Scheduled Mission
                      </label>
                      <div className={`flex items-center ${isTodayTimeQuickCollapsed
                        ? navigationMode === 'SEQUENCE'
                          ? 'flex-nowrap gap-1 overflow-x-auto px-1 pb-1 pr-1 snap-x snap-mandatory scroll-px-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
                          : 'flex-wrap gap-1'
                        : 'flex-wrap gap-1'}`}>
                        <button
                          type="button"
                          onClick={() => setMissionTimePreset(0)}
                          className={`${isTodayTimeQuickCollapsed ? 'h-6 px-2 text-[7px]' : 'h-6 px-2 text-[7px]'} rounded-md border border-slate-300 dark:border-brand-700 bg-slate-50 dark:bg-brand-950 font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 ${isTodayTimeQuickCollapsed ? 'shrink-0 snap-start' : ''}`}
                          title={`Set to now window (+${DISPATCH_NOW_MIN_MINUTES} to +${DISPATCH_NOW_MAX_MINUTES} min)`}
                        >
                          Now
                        </button>
                        <button
                          type="button"
                          onClick={() => setMissionTimePreset(15)}
                          className={`${isTodayTimeQuickCollapsed ? 'h-6 px-2 text-[7px]' : 'h-6 px-2 text-[7px]'} rounded-md border border-cyan-300 dark:border-cyan-900/40 bg-cyan-50 dark:bg-cyan-900/10 font-black uppercase tracking-widest text-cyan-700 dark:text-cyan-300 ${isTodayTimeQuickCollapsed ? 'shrink-0 snap-start' : ''}`}
                          title="Set to 15 minutes from now"
                        >
                          +15m
                        </button>
                        <button
                          type="button"
                          onClick={() => setMissionTimePreset(30)}
                          className={`${isTodayTimeQuickCollapsed ? 'h-6 px-2 text-[7px]' : 'h-6 px-2 text-[7px]'} rounded-md border border-blue-300 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 font-black uppercase tracking-widest text-blue-700 dark:text-blue-300 ${isTodayTimeQuickCollapsed ? 'shrink-0 snap-start' : ''}`}
                          title="Set to 30 minutes from now"
                        >
                          +30m
                        </button>
                        <button
                          type="button"
                          onClick={() => setMissionTimePreset(45)}
                          className={`${isTodayTimeQuickCollapsed ? 'h-6 px-2 text-[7px]' : 'h-6 px-2 text-[7px]'} rounded-md border border-sky-300 dark:border-sky-900/40 bg-sky-50 dark:bg-sky-900/10 font-black uppercase tracking-widest text-sky-700 dark:text-sky-300 ${isTodayTimeQuickCollapsed ? 'shrink-0 snap-start' : ''}`}
                          title="Set to 45 minutes from now"
                        >
                          +45m
                        </button>
                        <button
                          type="button"
                          onClick={() => setMissionTimePreset(60)}
                          className={`${isTodayTimeQuickCollapsed ? 'h-6 px-2 text-[7px]' : 'h-6 px-2 text-[7px]'} rounded-md border border-indigo-300 dark:border-indigo-900/40 bg-indigo-50 dark:bg-indigo-900/10 font-black uppercase tracking-widest text-indigo-700 dark:text-indigo-300 ${isTodayTimeQuickCollapsed ? 'shrink-0 snap-start' : ''}`}
                          title="Set to 1 hour from now"
                        >
                          +1h
                        </button>
                        <button
                          type="button"
                          onClick={() => setMissionTimePreset(120)}
                          className={`${isTodayTimeQuickCollapsed ? 'h-6 px-2 text-[7px]' : 'h-6 px-2 text-[7px]'} rounded-md border border-violet-300 dark:border-violet-900/40 bg-violet-50 dark:bg-violet-900/10 font-black uppercase tracking-widest text-violet-700 dark:text-violet-300 ${isTodayTimeQuickCollapsed ? 'shrink-0 snap-start' : ''}`}
                          title="Set to 2 hours from now"
                        >
                          +2h
                        </button>
                        <button
                          type="button"
                          onClick={() => setMissionTimePreset(90)}
                          className={`${isTodayTimeQuickCollapsed ? 'h-6 px-2 text-[7px]' : 'h-6 px-2 text-[7px]'} rounded-md border border-fuchsia-300 dark:border-fuchsia-900/40 bg-fuchsia-50 dark:bg-fuchsia-900/10 font-black uppercase tracking-widest text-fuchsia-700 dark:text-fuchsia-300 ${isTodayTimeQuickCollapsed ? 'shrink-0 snap-start' : ''}`}
                          title="Set to 1 hour 30 minutes from now"
                        >
                          +1.5h
                        </button>
                        <button
                          type="button"
                          onClick={() => setMissionTimePreset(180)}
                          className={`${isTodayTimeQuickCollapsed ? 'h-6 px-2 text-[7px]' : 'h-6 px-2 text-[7px]'} rounded-md border border-purple-300 dark:border-purple-900/40 bg-purple-50 dark:bg-purple-900/10 font-black uppercase tracking-widest text-purple-700 dark:text-purple-300 ${isTodayTimeQuickCollapsed ? 'shrink-0 snap-start' : ''}`}
                          title="Set to 3 hours from now"
                        >
                          +3h
                        </button>
                        {isTodayTimeQuickCollapsed && (
                          <>
                            <button
                              type="button"
                              onClick={() => setMissionTimePreset(240)}
                              className="h-6 px-2 text-[7px] rounded-md border border-amber-300 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 font-black uppercase tracking-widest text-amber-700 dark:text-amber-300 shrink-0 snap-start"
                              title="Set to 4 hours from now"
                            >
                              +4h
                            </button>
                            <button
                              type="button"
                              onClick={() => setMissionTimePreset(300)}
                              className="h-6 px-2 text-[7px] rounded-md border border-lime-300 dark:border-lime-900/40 bg-lime-50 dark:bg-lime-900/10 font-black uppercase tracking-widest text-lime-700 dark:text-lime-300 shrink-0 snap-start"
                              title="Set to 5 hours from now"
                            >
                              +5h
                            </button>
                            <button
                              type="button"
                              onClick={() => setMissionTimePreset(360)}
                              className="h-6 px-2 text-[7px] rounded-md border border-orange-300 dark:border-orange-900/40 bg-orange-50 dark:bg-orange-900/10 font-black uppercase tracking-widest text-orange-700 dark:text-orange-300 shrink-0 snap-start"
                              title="Set to 6 hours from now"
                            >
                              +6h
                            </button>
                            <button
                              type="button"
                              onClick={() => setMissionTimePreset(480)}
                              className="h-6 px-2 text-[7px] rounded-md border border-rose-300 dark:border-rose-900/40 bg-rose-50 dark:bg-rose-900/10 font-black uppercase tracking-widest text-rose-700 dark:text-rose-300 shrink-0 snap-start"
                              title="Set to 8 hours from now"
                            >
                              +8h
                            </button>
                            <button
                              type="button"
                              onClick={() => setMissionTimePreset(720)}
                              className="h-6 px-2 text-[7px] rounded-md border border-red-300 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 font-black uppercase tracking-widest text-red-700 dark:text-red-300 shrink-0 snap-start"
                              title="Set to 12 hours from now"
                            >
                              +12h
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500"><Clock size={13} /></div>
                      <input type="datetime-local" value={tripDate} onChange={e => {setTripDate(e.target.value); setDateRequiredError(false);}} className={`w-full h-11 pl-9 pr-3 rounded-xl border bg-slate-50 dark:bg-brand-950 text-xs font-bold transition-all ${dateRequiredError ? 'border-red-500' : 'border-slate-200 dark:border-brand-800'}`} />
                    </div>
                    <div className="flex items-center justify-between gap-2 px-1">
                      <p className="text-[8px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300 inline-flex items-center gap-1">
                        <Timer size={10} />
                        Typed Time Shortcut
                      </p>
                      <button
                        type="button"
                        onClick={() => setIsTodayTimeQuickCollapsed(prev => !prev)}
                          className={`${isTodayTimeQuickCollapsed ? 'h-5 w-5 px-0 justify-center rounded-md border-transparent bg-transparent text-slate-500/80 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-brand-900/60' : 'h-6 px-2 text-[7px] rounded-full border border-slate-200/80 dark:border-brand-700 bg-white/90 dark:bg-brand-900/80 text-slate-500 dark:text-slate-300 hover:border-slate-300 dark:hover:border-brand-600'} font-black uppercase tracking-widest inline-flex items-center gap-1 transition-colors`}
                        title={isTodayTimeQuickCollapsed ? 'Expand typed time form' : 'Collapse typed time form'}
                      >
                        {isTodayTimeQuickCollapsed ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
                          {!isTodayTimeQuickCollapsed && 'Hide'}
                      </button>
                    </div>
                    {!isTodayTimeQuickCollapsed && (
                      <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500"><Timer size={12} /></div>
                          <input
                            type="text"
                            value={todayTimeQuickInput}
                            onChange={e => setTodayTimeQuickInput(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                applyTodayTimeQuickInput();
                              }
                            }}
                            placeholder="Today time (e.g. 14:30 or 2:30pm)"
                            className="w-full h-9 pl-9 pr-3 rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-[9px] font-bold"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={applyTodayTimeQuickInput}
                          className="h-9 px-3 rounded-xl border border-emerald-300 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[8px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1"
                          title="Apply typed time for today"
                        >
                          <Check size={10} />
                          Apply
                        </button>
                      </div>
                    )}
                    {!isTodayTimeQuickCollapsed && (
                      <p className="text-[7px] font-black uppercase tracking-widest text-slate-400 px-1">Now uses a {DISPATCH_NOW_MIN_MINUTES}-{DISPATCH_NOW_MAX_MINUTES} minute operational window.</p>
                    )}
                  </div>

              <div className={`space-y-2 rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 ${isFareModifiersCollapsed ? 'p-1' : 'p-2.5'}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[8px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">
                    Fare Modifiers{isFareModifiersCollapsed ? ` · ${isRoundTrip ? 'Round Trip' : 'One Way'} · ${addWaitTime && waitTimeHours > 0 ? `Wait ${waitTimeHours}h` : 'No Wait'}` : ''}
                  </p>
                  <button
                    type="button"
                    onClick={() => setIsFareModifiersCollapsed(prev => !prev)}
                    className={`${isFareModifiersCollapsed ? 'h-5 w-5 px-0 justify-center rounded-md border-transparent bg-transparent text-slate-500/80 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-brand-900/60' : 'h-6 px-2 text-[7px] rounded-full border border-slate-200/80 dark:border-brand-700 bg-white/90 dark:bg-brand-900/80 text-slate-500 dark:text-slate-300 hover:border-slate-300 dark:hover:border-brand-600'} font-black uppercase tracking-widest inline-flex items-center gap-1 transition-colors`}
                    title={isFareModifiersCollapsed ? 'Expand fare modifiers' : 'Collapse fare modifiers'}
                  >
                    {isFareModifiersCollapsed ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
                    {!isFareModifiersCollapsed && 'Hide'}
                  </button>
                </div>

                {isFareModifiersCollapsed ? null : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button onClick={() => setIsRoundTrip(!isRoundTrip)} className={`h-11 rounded-xl text-[9px] font-black uppercase tracking-widest border-2 transition-all flex items-center justify-center ${isRoundTrip ? 'bg-brand-900 text-gold-400 border-brand-900' : 'bg-slate-50 border-slate-100 text-slate-400'}`}>
                      <Repeat size={14} className="mr-2"/> {isRoundTrip ? 'Round Trip' : 'One Way'}
                    </button>
                    <div className="flex bg-slate-50 rounded-xl p-0.5 border-2 border-slate-100 dark:bg-brand-950 dark:border-brand-800">
                      <button
                        onClick={() => {
                          setAddWaitTime(prev => {
                            const next = !prev;
                            if (!next) {
                              setWaitTimeHours(0);
                              setWaitTimeInput('');
                            }
                            if (next && waitTimeHours > 0) {
                              setWaitTimeInput(String(waitTimeHours));
                            }
                            return next;
                          });
                        }}
                        className={`h-9 w-9 rounded-lg flex items-center justify-center ${addWaitTime ? 'bg-gold-600 text-brand-950' : 'text-slate-300'}`}
                      ><Clock size={14}/></button>
                      <input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.25"
                        disabled={!addWaitTime}
                        value={waitTimeInput}
                        onChange={e => {
                          const raw = e.target.value;
                          if (!/^\d*(\.\d{0,2})?$/.test(raw)) return;
                          setWaitTimeInput(raw);
                          const parsed = Number(raw);
                          setWaitTimeHours(Number.isFinite(parsed) ? Math.max(0, parsed) : 0);
                        }}
                        onBlur={() => {
                          if (!waitTimeInput.trim()) {
                            setWaitTimeHours(0);
                            setWaitTimeInput('');
                            return;
                          }
                          const parsed = Number(waitTimeInput);
                          if (!Number.isFinite(parsed) || parsed <= 0) {
                            setWaitTimeHours(0);
                            setWaitTimeInput('');
                            return;
                          }
                          const normalized = Math.round(parsed * 100) / 100;
                          setWaitTimeHours(normalized);
                          setWaitTimeInput(String(normalized));
                        }}
                        className="flex-1 bg-transparent text-center text-[10px] font-black border-none focus:ring-0"
                        placeholder="Hrs"
                        title="Wait time in hours"
                      />
                    </div>
                  </div>
                )}
              </div>

              {renderSequenceWorkflowDock()}

                  </div>
                  )}

                  {(navigationMode === 'SCROLL' || activeSequenceStage === 'CUSTOMER') && (
                  <div className={`${navigationMode === 'SEQUENCE' ? 'animate-in fade-in slide-in-from-right-2 duration-200' : ''}`}>
              <div id="calc-stage-customer" className="space-y-2 rounded-xl border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 p-3">
                <div className="flex items-center justify-between gap-2 px-1">
                  <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest inline-flex items-center gap-1">
                    <User size={11} />
                    Customer Profile (Quote + WhatsApp)
                  </label>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        searchDirectoryInputRef.current?.focus();
                        setShowDirectoryResults(true);
                      }}
                      className="h-6 px-2 rounded-md border border-slate-300 dark:border-brand-700 bg-slate-50 dark:bg-brand-950 text-[7px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 inline-flex items-center gap-1"
                      title="Focus customer search"
                    >
                      <Search size={9} />
                      Search
                    </button>
                    <button
                      type="button"
                      onClick={handleResetPreQuoteCustomer}
                      className="h-6 px-2 rounded-md border border-slate-300 dark:border-brand-700 bg-slate-50 dark:bg-brand-950 text-[7px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 inline-flex items-center gap-1"
                      title="Clear customer fields"
                    >
                      <X size={9} />
                      Clear
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-2">
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500"><Search size={13} /></div>
                    <input
                      ref={searchDirectoryInputRef}
                      type="text"
                      placeholder="Select customer from Directory..."
                      value={searchDirectory}
                      onFocus={() => setShowDirectoryResults(true)}
                      onBlur={() => setTimeout(() => setShowDirectoryResults(false), 120)}
                      onChange={e => setSearchDirectory(e.target.value)}
                      className="w-full h-10 rounded-xl bg-white dark:bg-brand-900 border border-slate-200 dark:border-brand-800 text-brand-900 dark:text-white font-bold px-9 text-[10px] uppercase tracking-widest"
                    />
                    {showDirectoryResults && searchDirectory.length >= 2 && (
                      <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-brand-900 border border-slate-200 dark:border-brand-800 rounded-2xl shadow-2xl z-[100] overflow-hidden animate-in fade-in slide-in-from-top-2 max-h-56 overflow-y-auto">
                        {directoryMatches.length > 0 ? (
                          directoryMatches.map(c => (
                            <button
                              key={c.id}
                              type="button"
                              onMouseDown={(event) => {
                                event.preventDefault();
                                handleSelectCustomer(c);
                              }}
                              className="w-full p-3 flex items-center justify-between hover:bg-gold-50 dark:hover:bg-white/5 border-b border-slate-100 dark:border-white/5 transition-all text-left"
                            >
                              <div>
                                <p className="text-[10px] font-black text-brand-900 dark:text-white uppercase tracking-tight">{c.name}</p>
                                <p className="text-[9px] font-bold text-slate-400">{c.phone}</p>
                              </div>
                              <div className="p-1.5 bg-gold-500 rounded-lg text-brand-900"><User size={11} /></div>
                            </button>
                          ))
                        ) : (
                          <div className="p-6 text-center bg-slate-50 dark:bg-brand-950">
                            <UserX size={24} className="mx-auto text-slate-300 dark:text-brand-800 mb-2" />
                            <p className="text-[9px] font-black uppercase text-slate-400 tracking-widest">No directory match</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {quickCustomerPicks.length > 0 && (
                    <div className={`rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 ${isQuoteQuickPicksCollapsed ? 'p-0.5' : 'p-2'}`}>
                      <div className="flex items-center justify-between gap-2 px-1">
                        <p className="text-[6px] font-black uppercase tracking-[0.14em] text-slate-500 dark:text-slate-300 inline-flex items-center gap-1">
                          <Zap size={10} />
                          Quick Picks ({quickCustomerPicks.length})
                        </p>
                        <button
                          type="button"
                          onClick={() => setIsQuoteQuickPicksCollapsed(prev => !prev)}
                          className={`${isQuoteQuickPicksCollapsed ? 'h-5 w-5 px-0 justify-center rounded-md border-transparent bg-transparent text-slate-500/80 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-brand-900/60' : 'h-6 px-2 text-[7px] rounded-full border border-slate-200/80 dark:border-brand-700 bg-white/90 dark:bg-brand-900/80 text-slate-500 dark:text-slate-300 hover:border-slate-300 dark:hover:border-brand-600'} font-black uppercase tracking-widest inline-flex items-center gap-1 transition-colors`}
                          title={isQuoteQuickPicksCollapsed ? 'Expand quick picks' : 'Collapse quick picks'}
                        >
                          {isQuoteQuickPicksCollapsed ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
                          {!isQuoteQuickPicksCollapsed && 'Hide'}
                        </button>
                      </div>
                      {!isQuoteQuickPicksCollapsed && (
                        <div className={`mt-1.5 ${navigationMode === 'SEQUENCE' ? 'flex flex-nowrap gap-1.5 overflow-x-auto px-1 pb-1 snap-x snap-mandatory scroll-px-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden' : 'flex flex-wrap gap-1.5'}`}>
                          {quickCustomerPicks.map(pick => (
                            <button
                              key={pick.id}
                              type="button"
                              onClick={() => handleQuickPickCustomer(pick)}
                              title={`${pick.name} · ${pick.phone}`}
                              className={`h-7 px-2 rounded-lg border text-[7px] font-black uppercase tracking-widest inline-flex items-center ${navigationMode === 'SEQUENCE' ? 'justify-center gap-0.5 shrink-0 snap-start min-w-[9rem] max-w-[12rem]' : 'gap-1'} ${pick.fromDirectory
                                ? 'border-gold-300 bg-gold-50 text-gold-700 dark:border-gold-700/40 dark:bg-gold-900/10 dark:text-gold-300'
                                : 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-900/40 dark:bg-blue-900/10 dark:text-blue-300'}`}
                            >
                              <User size={10} />
                              {pick.affinity > 0 && (
                                <span className="inline-flex items-center px-1 rounded border text-[6px] tracking-widest border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10">
                                  Route
                                </span>
                              )}
                              {pick.tier && (
                                <span className={`inline-flex items-center px-1 rounded border text-[6px] tracking-widest ${pick.tier === 'VVIP'
                                  ? 'border-pink-300 text-pink-700 bg-pink-50 dark:border-pink-900/40 dark:text-pink-300 dark:bg-pink-900/10'
                                  : 'border-violet-300 text-violet-700 bg-violet-50 dark:border-violet-900/40 dark:text-violet-300 dark:bg-violet-900/10'}`}
                                >
                                  {pick.tier === 'VVIP' ? <ShieldCheck size={8} className="mr-0.5" /> : <Star size={8} className="mr-0.5" />}
                                  {pick.tier}
                                </span>
                              )}
                              <span className="truncate">{truncateUiText(pick.name, 14)}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="flex items-center bg-white dark:bg-brand-900 border border-slate-200 dark:border-brand-800 rounded-xl px-3 h-10">
                    <User size={13} className="text-gold-600 mr-2.5" />
                    <input type="text" placeholder="Client Name" value={customerName} onChange={e => {
                      setSelectedQuoteDirectoryCustomerId(null);
                      setCustomerName(e.target.value);
                    }} className="bg-transparent border-none focus:ring-0 text-brand-900 dark:text-white font-bold text-[10px] flex-1 h-full" />
                  </div>
                  <div className="flex items-center bg-white dark:bg-brand-900 border border-slate-200 dark:border-brand-800 rounded-xl px-3 h-10">
                    <Phone size={13} className="text-blue-500 mr-2.5" />
                    <input
                      type="text"
                      placeholder="Client Phone"
                      value={customerPhone}
                      onChange={e => {
                        const nextPhone = e.target.value;
                        setSelectedQuoteDirectoryCustomerId(null);
                        setCustomerPhone(nextPhone);
                        syncCustomerPhoneDialState(nextPhone);
                      }}
                      className="bg-transparent border-none focus:ring-0 text-brand-900 dark:text-white font-bold text-[10px] flex-1 h-full"
                    />
                  </div>
                  {canUseMobileContactPicker && (
                    <button
                      type="button"
                      onClick={importContactFromPhone}
                      className="md:hidden h-9 rounded-xl border border-violet-300 dark:border-violet-900/40 bg-violet-50 dark:bg-violet-900/10 text-[8px] font-black uppercase tracking-widest text-violet-700 dark:text-violet-300 inline-flex items-center justify-center gap-1"
                      title="Import contact from your phone"
                      aria-label="Import contact from phone"
                    >
                      <Smartphone size={11} />
                      Phone Contact
                    </button>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setCustomerPhoneIntlEnabled(prev => !prev)}
                      className={`h-8 rounded-lg border text-[8px] font-black uppercase tracking-widest transition-colors inline-flex items-center justify-center gap-1 ${customerPhoneIntlEnabled ? 'border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10' : 'border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10'}`}
                    >
                      <Phone size={10} />
                      {customerPhoneIntlEnabled ? 'INTL ON' : 'INTL OFF (LB)'}
                    </button>
                    {customerPhoneIntlEnabled ? (
                      <select
                        value={customerPhoneUseCustomDialCode ? 'OTHER' : customerPhoneDialCode}
                        onChange={event => {
                          const value = event.target.value;
                          if (value === 'OTHER') {
                            setCustomerPhoneUseCustomDialCode(true);
                            return;
                          }

                          setCustomerPhoneUseCustomDialCode(false);
                          setCustomerPhoneDialCode(value);
                          setCustomerPhone(prev => applyPhoneDialCode(prev, value));
                        }}
                        className="h-8 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-950 px-2 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300"
                        aria-label="Select international country code"
                      >
                        {customerPhonePopularPresets.map(option => (
                          <option key={option.key} value={option.dialCode}>{option.label}</option>
                        ))}
                        <option value="OTHER">Other code...</option>
                      </select>
                    ) : (
                      <div className="h-8 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-2 flex items-center gap-1 text-[8px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">
                        <Phone size={10} />
                        Default +961
                      </div>
                    )}
                  </div>
                  {customerPhoneIntlEnabled && customerPhoneUseCustomDialCode && (
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500"><Settings size={13} /></div>
                      <input
                        type="text"
                        value={customerPhoneCustomDialCode}
                        onChange={event => {
                          const digits = event.target.value.replace(/\D/g, '').slice(0, 4);
                          setCustomerPhoneCustomDialCode(digits);
                          if (digits.length > 0) {
                            setCustomerPhone(prev => applyPhoneDialCode(prev, digits));
                          }
                        }}
                        className="w-full border border-slate-200 dark:border-brand-800 rounded-xl pl-9 pr-3 h-11 bg-slate-50 dark:bg-brand-950 font-bold"
                        placeholder="Other country code (e.g. 1, 61)"
                        aria-label="Custom country code"
                      />
                    </div>
                  )}
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[8px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">
                      {quoteDirectoryCustomer ? 'Directory profile linked. Tap suggestions below.' : 'Pick a customer from Directory to load saved destinations.'}
                    </p>
                    <button
                      type="button"
                      onClick={handleResetPreQuoteCustomer}
                      className="h-6 px-2 rounded-md border border-slate-300 dark:border-brand-700 bg-slate-50 dark:bg-brand-950 text-[7px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 inline-flex items-center gap-1 whitespace-nowrap"
                    >
                      <RefreshCcw size={9} />
                      Blank
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => handleSetCustomerPriority('VIP')}
                    aria-label="Mark customer as VIP"
                    className="h-8 rounded-lg border border-slate-300 dark:border-violet-700/40 bg-slate-50 dark:bg-violet-900/10 text-[8px] font-black uppercase tracking-widest text-violet-700 dark:text-violet-300 inline-flex items-center justify-center gap-1"
                  >
                    <Star size={11} aria-hidden="true" />
                    Mark VIP
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSetCustomerPriority('VVIP')}
                    aria-label="Mark customer as VVIP"
                    className="h-8 rounded-lg border border-amber-300 dark:border-pink-700/40 bg-amber-50 dark:bg-pink-900/10 text-[8px] font-black uppercase tracking-widest text-pink-700 dark:text-pink-300 inline-flex items-center justify-center gap-1"
                  >
                    <ShieldCheck size={11} aria-hidden="true" />
                    Mark VVIP
                  </button>
                </div>
                {frequentPlaceSuggestions.length > 0 && (
                  <div className={`space-y-2 rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 ${isFrequentPlacesCollapsed ? 'p-0.5' : 'p-2'}`}>
                    <div className="flex items-center justify-between gap-2 px-1">
                      <div className="flex items-center gap-2">
                        <p className="text-[6px] font-black uppercase tracking-[0.14em] text-slate-500 dark:text-slate-300">Frequent Place Suggestions ({frequentPlaceSuggestions.length})</p>
                        <span
                          title="Saved places from CRM appear in order: Home, Business, then Frequent places. Use Set Pickup or Set Dropoff to apply instantly."
                          className="inline-flex items-center text-slate-400"
                        >
                          <Info size={11} />
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsFrequentPlacesCollapsed(prev => !prev)}
                        className={`${isFrequentPlacesCollapsed ? 'h-5 w-5 px-0 justify-center rounded-md border-transparent bg-transparent text-slate-500/80 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-brand-900/60' : 'h-6 px-2 text-[7px] rounded-full border border-slate-200/80 dark:border-brand-700 bg-white/90 dark:bg-brand-900/80 text-slate-500 dark:text-slate-300 hover:border-slate-300 dark:hover:border-brand-600'} font-black uppercase tracking-widest inline-flex items-center gap-1 transition-colors`}
                        title={isFrequentPlacesCollapsed ? 'Expand frequent places' : 'Collapse frequent places'}
                      >
                        {isFrequentPlacesCollapsed ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
                        {!isFrequentPlacesCollapsed && 'Hide'}
                      </button>
                    </div>
                    {!isFrequentPlacesCollapsed && (
                      <div className={`${navigationMode === 'SEQUENCE'
                        ? 'flex flex-nowrap items-stretch gap-2 overflow-x-auto px-1 pb-1 snap-x snap-mandatory scroll-px-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
                        : 'space-y-2 max-h-32 overflow-auto pr-1'}`}>
                      {frequentPlaceSuggestions.slice(0, 8).map((location, index) => {
                        const normalizedLabel = (location.label || '').trim().toLowerCase();
                        const isHome = normalizedLabel === 'home';
                        const isBusiness = normalizedLabel === 'business';
                        const TagIcon = isHome ? House : isBusiness ? Building2 : MapPin;
                        const visualLabel = isHome ? 'Home' : isBusiness ? 'Business' : 'Frequent';

                        return (
                          <div
                            key={`${location.address}-${location.mapsLink || ''}-${index}`}
                            title={`${location.helperText} ${location.address}`}
                            className={`rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 px-3 py-2 ${navigationMode === 'SEQUENCE' ? 'shrink-0 snap-start w-[18rem]' : ''}`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <p
                                title={location.address}
                                className="text-[10px] font-bold text-brand-900 dark:text-white truncate"
                              >
                                {truncateUiText(location.address || '', UI_LOCATION_MAX_CHARS)}
                              </p>
                              <span
                                title={location.label || visualLabel}
                                aria-label={`${visualLabel} saved location`}
                                className="inline-flex items-center gap-1 text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300"
                              >
                                <TagIcon size={10} aria-hidden="true" />
                                {truncateUiText(location.label || visualLabel, UI_TAG_MAX_CHARS)}
                              </span>
                            </div>
                            <div className="mt-2 flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => applyFrequentPlaceToRoute('pickup', location)}
                                title="Apply this saved place to Pickup field."
                                aria-label="Set as pickup"
                                className="h-7 px-2 rounded-lg border border-gold-500/30 bg-gold-500/10 text-[8px] font-black uppercase tracking-widest text-gold-700 dark:text-gold-400 inline-flex items-center gap-1"
                              >
                                <MapPin size={10} aria-hidden="true" />
                                Set Pickup
                              </button>
                              <button
                                type="button"
                                onClick={() => applyFrequentPlaceToRoute('dest', location)}
                                title="Apply this saved place to Dropoff field."
                                aria-label="Set as dropoff"
                                className="h-7 px-2 rounded-lg border border-blue-500/30 bg-blue-500/10 text-[8px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300 inline-flex items-center gap-1"
                              >
                                <Navigation size={10} aria-hidden="true" />
                                Set Dropoff
                              </button>
                            </div>
                          </div>
                        );
                      })}
                      </div>
                    )}
                  </div>
                )}

                {isQuoteDirectorySelectionActive && quoteCustomerSnapshot && hasExistingCustomerSnapshotInfo && (
                  <div className={navigationMode === 'SEQUENCE' && activeSequenceStage === 'CUSTOMER' ? 'lg:hidden' : ''}>
                    <CustomerSnapshotCard snapshot={quoteCustomerSnapshot} />
                  </div>
                )}

                {shouldShowQuickMarkers && (
                  <div className={`rounded-2xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 ${isQuickMarkersCollapsed ? 'p-0.5 space-y-0.5' : 'p-3 space-y-2'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[6px] font-black uppercase tracking-[0.14em] text-slate-400 inline-flex items-center gap-1">
                        <Layers size={10} aria-hidden="true" />
                        Quick Operator Markers
                      </p>
                      <button
                        type="button"
                        onClick={() => setIsQuickMarkersCollapsed(prev => !prev)}
                        className={`${isQuickMarkersCollapsed ? 'h-5 w-5 px-0 justify-center rounded-md border-transparent bg-transparent text-slate-500/80 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-brand-900/60' : 'h-6 px-2 text-[7px] rounded-full border border-slate-200/80 dark:border-brand-700 bg-white/90 dark:bg-brand-900/80 text-slate-500 dark:text-slate-300 hover:border-slate-300 dark:hover:border-brand-600'} font-black uppercase tracking-widest inline-flex items-center gap-1 transition-colors`}
                        title={isQuickMarkersCollapsed ? 'Expand quick markers' : 'Collapse quick markers'}
                      >
                        {isQuickMarkersCollapsed ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
                        {!isQuickMarkersCollapsed && 'Hide'}
                      </button>
                    </div>
                    {!isQuickMarkersCollapsed && (
                      <>
                    <p className="text-[9px] font-bold text-slate-500 dark:text-slate-300">New customer detected. Tag quickly for indexing.</p>
                    <div className={`${navigationMode === 'SEQUENCE' ? 'grid grid-cols-2 lg:grid-cols-4 gap-1.5' : 'flex flex-wrap gap-1.5'}`}>
                      {operatorIndexMarkers.map(marker => {
                        const active = hasOperatorMarker(marker);
                        const markerIcon = marker === 'NEW'
                          ? <Star size={10} aria-hidden="true" />
                          : marker === 'CORP'
                            ? <Building2 size={10} aria-hidden="true" />
                            : marker === 'AIRPORT'
                              ? <Navigation size={10} aria-hidden="true" />
                              : marker === 'PRIORITY'
                                ? <AlertCircle size={10} aria-hidden="true" />
                                : marker === 'VIP'
                                  ? <Star size={10} aria-hidden="true" />
                                  : marker === 'VVIP'
                                    ? <ShieldCheck size={10} aria-hidden="true" />
                                : <RefreshCcw size={10} aria-hidden="true" />;
                        return (
                          <button
                            key={marker}
                            type="button"
                            onClick={() => toggleOperatorMarker(marker)}
                            aria-label={`${marker} marker`}
                            className={`h-7 px-2.5 rounded-lg border text-[8px] font-black uppercase tracking-widest inline-flex items-center justify-center gap-1 ${active
                              ? 'bg-brand-900 text-gold-400 border-brand-900 dark:bg-gold-600 dark:text-brand-950 dark:border-gold-600'
                              : 'bg-slate-50 dark:bg-brand-950 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-brand-700'}`}
                          >
                            {markerIcon}
                            {marker}
                          </button>
                        );
                      })}
                    </div>
                      </>
                    )}
                  </div>
                )}
              </div>
                {renderSequenceWorkflowDock()}
              </div>
              )}
           </div>
           )}
        <div
          id="calc-stage-dispatch"
          className={`${navigationMode === 'SEQUENCE' && activeSequenceStage !== 'OUTPUT' ? 'hidden' : 'block'} ${navigationMode === 'SEQUENCE' ? 'animate-in fade-in slide-in-from-right-2 duration-200' : ''}`}
        >
        {result ? (
          <div className="bg-brand-900 rounded-2xl shadow-2xl p-5 border-t-4 border-gold-600 animate-fade-in relative overflow-visible">
                  <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="lg:pr-3">
                       <div className="flex items-baseline space-x-1 text-white">
                          <span className="text-gold-400 font-black text-lg">$</span>
                          <span className="text-4xl font-black tracking-tighter">{fareUsd}</span>
                       </div>
                       <p className="text-[9px] font-black text-gold-600 uppercase tracking-widest mt-1">~{fareLbp.toLocaleString()} LBP Total</p>
                        {fareComputation.minimumFareApplied && (
                         <span className="inline-flex items-center h-5 mt-2 px-2 rounded-md border border-amber-300/50 bg-amber-500/10 text-[8px] font-black uppercase tracking-widest text-amber-300">
                          Minimum Fare Applied (${fareComputation.minimumFareUsd})
                         </span>
                        )}
                    </div>
                    <div className="grid w-full grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-4 lg:w-auto lg:min-w-0">
                       <button
                         onClick={handleQuickCopyQuote}
                         aria-label={quickCopied ? 'Quote copied' : 'Copy quote'}
                         title={quickCopied ? 'Quote copied' : 'Copy quote'}
                         className={`h-7 w-full lg:w-auto min-w-0 flex items-center justify-center gap-1.5 text-[8px] font-black uppercase tracking-widest px-2 rounded-lg border transition-all ${quickCopied ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-brand-950 text-slate-400 border-brand-800 hover:text-white'}`}
                       >
                         {quickCopied ? <Check size={10} /> : <Copy size={10} />}
                         <span>{quickCopied ? 'Done' : 'Copy'}</span>
                       </button>
                       <button
                         onClick={handleQuickWhatsAppQuote}
                         aria-label="Send quote to customer on WhatsApp"
                         title="Customer WhatsApp"
                         className="h-7 w-full lg:w-auto min-w-0 flex items-center justify-center gap-1.5 text-[8px] font-black uppercase tracking-widest px-2 rounded-lg border transition-all bg-brand-950 text-emerald-400 border-brand-800 hover:text-emerald-300"
                       >
                         <LinkIcon size={10} />
                         <span className="hidden sm:inline truncate">Customer WA</span>
                         <span className="sm:hidden truncate">Cust WA</span>
                       </button>
                       <button
                         onClick={handleQuickOperatorWhatsAppQuote}
                         aria-label="Send quote to operator on WhatsApp"
                         title="Operator WhatsApp"
                         disabled={!settings.operatorWhatsApp.trim()}
                         className="h-7 w-full lg:w-auto min-w-0 flex items-center justify-center gap-1.5 text-[8px] font-black uppercase tracking-widest px-2 rounded-lg border transition-all bg-brand-950 text-blue-400 border-brand-800 hover:text-blue-300 disabled:opacity-40 disabled:cursor-not-allowed"
                       >
                         <MessageCircle size={10} />
                         <span>Op WA</span>
                       </button>
                       <span className="h-7 w-full lg:w-auto min-w-0 inline-flex items-center justify-center gap-1 text-[8px] font-black uppercase tracking-widest px-2 rounded-full border border-gold-600/40 bg-gold-500/10 text-gold-300">
                         <Clock size={10} className="text-gold-400" />
                         <span className="truncate">{result.durationInTrafficText} ETA</span>
                       </span>
                    </div>
                 </div>
                 
                 <div className="pb-5 border-b border-brand-800 flex justify-between items-center">
                    <TrafficGauge index={result.trafficIndex} />
                    <button
                      type="button"
                      onClick={() => setShowBreakdown(!showBreakdown)}
                      aria-label={showBreakdown ? 'Hide traffic details' : 'Show traffic details'}
                      className={`p-2 rounded-lg transition-colors ${showBreakdown ? 'text-gold-400 bg-brand-950 border border-brand-800' : 'text-gold-600 hover:text-gold-400'}`}
                    >
                      <InfoIcon size={16}/>
                    </button>
                 </div>

                 {showBreakdown && (
                   <div className="mt-4 mb-5 rounded-xl border border-brand-800 bg-brand-950/70 p-3 space-y-2 animate-fade-in">
                     <div className="flex items-center justify-between">
                       <span className="text-[8px] font-black uppercase tracking-widest text-slate-400 inline-flex items-center gap-1">
                         <Gauge size={10} className="text-cyan-400" />
                         Traffic Index
                       </span>
                       <span className="text-[10px] font-black uppercase tracking-widest text-gold-400">{Math.round(result.trafficIndex)}/100</span>
                     </div>
                     <div className="flex items-center justify-between">
                       <span className="text-[8px] font-black uppercase tracking-widest text-slate-400">Baseline Duration</span>
                       <span className="text-[10px] font-black uppercase tracking-widest text-white">{result.durationText}</span>
                     </div>
                     <div className="flex items-center justify-between">
                       <span className="text-[8px] font-black uppercase tracking-widest text-slate-400">Live ETA</span>
                       <span className="text-[10px] font-black uppercase tracking-widest text-white">{result.durationInTrafficText}</span>
                     </div>
                     <div className="flex items-center justify-between">
                       <span className="text-[8px] font-black uppercase tracking-widest text-slate-400">Traffic Surplus</span>
                       <span className="text-[10px] font-black uppercase tracking-widest text-amber-400">+{Math.max(0, Math.round(result.surplusMin))} min</span>
                     </div>
                   </div>
                 )}

                 {assignedDriver && (
                   <div className="pt-4 pb-5 border-b border-brand-800">
                     <div className="inline-flex items-center space-x-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
                       <Car size={12} className="text-emerald-400" />
                       <span className="text-[9px] font-black uppercase tracking-widest text-emerald-300">
                         Assigned: {assignedDriver.name} ({assignedDriver.plateNumber})
                       </span>
                     </div>
                   </div>
                 )}

                 {/* Special Requirements Selection */}
                   <div className={`${isPassengerRequirementsCollapsed ? 'py-1' : 'py-5'} border-b border-brand-800`}>
                    <div className={`flex items-center justify-between gap-2 px-1 ${isPassengerRequirementsCollapsed ? 'mb-0' : 'mb-2'}`}>
                      <label className="text-[7px] font-black text-slate-500 uppercase tracking-[0.14em]">Passenger Requirements</label>
                      <button
                        type="button"
                        onClick={() => setIsPassengerRequirementsCollapsed(prev => !prev)}
                        className={`${isPassengerRequirementsCollapsed ? 'h-5 w-5 px-0 justify-center rounded-md border-transparent bg-transparent text-slate-400/90 hover:bg-white/10' : 'h-6 px-2 text-[7px] rounded-full border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'} font-black uppercase tracking-widest inline-flex items-center gap-1 transition-colors`}
                        title={isPassengerRequirementsCollapsed ? 'Expand passenger requirements' : 'Collapse passenger requirements'}
                      >
                        {isPassengerRequirementsCollapsed ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
                        {!isPassengerRequirementsCollapsed && 'Hide'}
                      </button>
                    </div>
                    {!isPassengerRequirementsCollapsed && (
                      <div className={`${navigationMode === 'SEQUENCE' ? 'flex flex-nowrap gap-1.5 overflow-x-auto px-1 pb-1 snap-x snap-mandatory scroll-px-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden' : 'flex flex-wrap gap-1.5'}`}>
                         {SPECIAL_REQUIREMENTS.map(req => (
                           <button 
                             key={req.id} 
                             onClick={() => toggleRequirement(req.id)}
                             title={req.label}
                             aria-label={req.label}
                             className={`px-2.5 py-1.5 rounded-lg text-[8px] font-black uppercase tracking-tight transition-all border inline-flex items-center justify-center gap-1.5 ${navigationMode === 'SEQUENCE' ? 'shrink-0 snap-start min-w-[6.5rem]' : ''} ${selectedRequirements.includes(req.id) ? 'bg-gold-600 border-gold-600 text-brand-900 shadow-lg shadow-gold-600/10' : 'bg-brand-950 border-brand-800 text-slate-500 hover:border-slate-600'}`}
                           >
                             {requirementIcon(req.id)}
                             {req.short}
                           </button>
                         ))}
                      </div>
                    )}
                 </div>

                 <div className="pt-5 space-y-4">
                    <div className="rounded-xl border border-brand-800 bg-brand-950 px-3 py-2">
                      <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Customer Source</p>
                      <p className="text-[10px] font-black text-white mt-1 uppercase tracking-tight">{customerName || 'Walk-in Client'}</p>
                      <p className="text-[9px] font-bold text-slate-400 mt-0.5">{customerPhone || 'N/A'}</p>
                    </div>

                    <div className="grid grid-cols-1 gap-2">
                      <div className={`rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-950 ${isPaymentModeCollapsed ? 'p-0.5' : 'p-2'}`}>
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[7px] font-black uppercase tracking-[0.14em] text-slate-500 dark:text-slate-300 inline-flex items-center gap-1">
                            <DollarSign size={10} className="text-gold-500" />
                            Payment Mode{isPaymentModeCollapsed ? ` · ${paymentMode}` : ''}
                          </p>
                          <button
                            type="button"
                            onClick={() => setIsPaymentModeCollapsed(prev => !prev)}
                            className={`${isPaymentModeCollapsed ? 'h-5 w-5 px-0 justify-center rounded-md border-transparent bg-transparent text-slate-500/80 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-brand-900/60' : 'h-6 px-2 text-[7px] rounded-full border border-slate-200/80 dark:border-brand-700 bg-white/90 dark:bg-brand-900/80 text-slate-500 dark:text-slate-300 hover:border-slate-300 dark:hover:border-brand-600'} font-black uppercase tracking-widest inline-flex items-center gap-1 transition-colors`}
                            title={isPaymentModeCollapsed ? 'Expand payment mode' : 'Collapse payment mode'}
                          >
                            {isPaymentModeCollapsed ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
                            {!isPaymentModeCollapsed && 'Hide'}
                          </button>
                        </div>
                        {!isPaymentModeCollapsed && (
                          <div className="mt-1 grid grid-cols-2 gap-1">
                            <button
                              type="button"
                              onClick={() => setPaymentMode('CASH')}
                              aria-label="Cash payment mode"
                              className={`h-7 rounded-lg text-[8px] font-black uppercase tracking-widest transition-colors inline-flex items-center justify-center gap-1 ${paymentMode === 'CASH' ? 'bg-emerald-600 text-white' : 'bg-slate-100 dark:bg-brand-900 text-slate-500 dark:text-slate-300'}`}
                              title={quoteDirectoryCustomer ? `Default for this customer: ${quotePreferredPaymentMode}` : 'Set payment mode to Cash'}
                            >
                              <DollarSign size={10} aria-hidden="true" />
                              Cash
                            </button>
                            <button
                              type="button"
                              onClick={() => setPaymentMode('CREDIT')}
                              aria-label="Credit payment mode"
                              className={`h-7 rounded-lg text-[8px] font-black uppercase tracking-widest transition-colors inline-flex items-center justify-center gap-1 ${paymentMode === 'CREDIT' ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-brand-900 text-slate-500 dark:text-slate-300'}`}
                              title={quoteDirectoryCustomer ? `Default for this customer: ${quotePreferredPaymentMode}` : 'Set payment mode to Credit'}
                            >
                              <ArrowRightLeft size={10} aria-hidden="true" />
                              Credit
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="relative flex items-center bg-white dark:bg-brand-950 border border-slate-200 dark:border-brand-800 rounded-xl px-3 h-11">
                        <Car size={14} className="text-emerald-500 mr-3" />
                        <input
                          ref={driverSearchInputRef}
                          type="text"
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
                            const nextQuery = event.target.value;
                            setDriverSearchQuery(nextQuery);
                            setShowDriverSuggestions(true);
                            if (selectedDriverId) {
                              setSelectedDriverId('');
                            }
                          }}
                          placeholder="Assign Driver (type name/plate/status)"
                          className="bg-transparent border-none focus:ring-0 text-brand-900 dark:text-white font-bold text-[10px] flex-1 h-full"
                        />
                        {driverSearchQuery.trim().length > 0 && (
                          <button
                            type="button"
                            onMouseDown={event => event.preventDefault()}
                            onClick={() => {
                              setDriverSearchQuery('');
                              setSelectedDriverId('');
                              setShowDriverSuggestions(false);
                            }}
                            className="h-6 w-6 rounded-md border border-slate-200 dark:border-brand-700 bg-slate-50 dark:bg-brand-900 text-slate-500 dark:text-slate-300 inline-flex items-center justify-center"
                            title="Clear selected driver"
                            aria-label="Clear selected driver"
                          >
                            <X size={10} />
                          </button>
                        )}
                        {showDriverSuggestions && (
                          <div className="absolute left-0 right-0 top-[calc(100%+0.35rem)] z-30 rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 shadow-xl max-h-64 overflow-y-auto">
                            {!driverSearchQuery.trim() && recommendedDrivers.length > 0 && (
                              <div className="px-2.5 pt-2 pb-1 border-b border-slate-100 dark:border-brand-800">
                                <p className="text-[7px] font-black uppercase tracking-widest text-slate-400">Recommended</p>
                                <div className="mt-1 grid grid-cols-1 gap-1">
                                  {recommendedDrivers.map(driver => {
                                    const insight = driverIntelligenceById.get(driver.id);
                                    return (
                                      <button
                                        key={`recommended-${driver.id}`}
                                        type="button"
                                        onMouseDown={event => event.preventDefault()}
                                        onClick={() => handleSelectDriverFromSuggestions(driver)}
                                        className="min-h-8 px-2 rounded-lg border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[8px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300"
                                      >
                                        <div className="flex items-center justify-between gap-2">
                                          <span className="truncate">{driver.name} ({driver.plateNumber})</span>
                                          <span className="ml-2 text-[7px] shrink-0">S{insight?.overall ?? 0}</span>
                                        </div>
                                        {insight?.reasons?.[0] && (
                                          <div className="text-left text-[6px] tracking-[0.12em] text-emerald-600/90 dark:text-emerald-300/90 truncate mt-0.5">
                                            {insight.reasons[0]}
                                          </div>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                            <div className="p-2 space-y-1">
                              {driverSuggestions.length > 0 ? driverSuggestions.map(driver => {
                                const insight = driverIntelligenceById.get(driver.id);
                                return (
                                  <button
                                    key={driver.id}
                                    type="button"
                                    onMouseDown={event => event.preventDefault()}
                                    onClick={() => handleSelectDriverFromSuggestions(driver)}
                                    className="w-full min-h-8 px-2 rounded-lg border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-[8px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-200"
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="truncate">{driver.name} ({driver.plateNumber})</span>
                                      <span className="ml-2 text-[7px] text-slate-500 dark:text-slate-300 shrink-0">S{insight?.overall ?? 0}</span>
                                    </div>
                                  </button>
                                );
                              }) : (
                                <p className="text-[8px] font-black uppercase tracking-widest text-slate-400 px-1 py-2">No matching active drivers</p>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                      <div className={`rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-950 ${isSpecificNotesCollapsed ? 'p-0.5' : 'p-2'}`}>
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[7px] font-black uppercase tracking-[0.14em] text-slate-500 dark:text-slate-300 inline-flex items-center gap-1">
                            <FileText size={10} />
                            Specific Notes{isSpecificNotesCollapsed ? ` · ${notes.trim() ? `${notes.trim().length} chars` : 'Empty'}` : ''}
                          </p>
                          <button
                            type="button"
                            onClick={() => setIsSpecificNotesCollapsed(prev => !prev)}
                            className={`${isSpecificNotesCollapsed ? 'h-5 w-5 px-0 justify-center rounded-md border-transparent bg-transparent text-slate-500/80 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-brand-900/60' : 'h-6 px-2 text-[7px] rounded-full border border-slate-200/80 dark:border-brand-700 bg-white/90 dark:bg-brand-900/80 text-slate-500 dark:text-slate-300 hover:border-slate-300 dark:hover:border-brand-600'} font-black uppercase tracking-widest inline-flex items-center gap-1 transition-colors`}
                            title={isSpecificNotesCollapsed ? 'Expand specific notes' : 'Collapse specific notes'}
                          >
                            {isSpecificNotesCollapsed ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
                            {!isSpecificNotesCollapsed && 'Hide'}
                          </button>
                        </div>
                        {!isSpecificNotesCollapsed && (
                          <div className="mt-1 flex items-start bg-slate-50 dark:bg-brand-900 border border-slate-200 dark:border-brand-800 rounded-xl px-3 py-2">
                            <FileText size={14} className="text-slate-500 mr-3 mt-1" />
                            <textarea
                              ref={notesTextareaRef}
                              placeholder="Specific notes..."
                              value={notes}
                              rows={1}
                              onFocus={e => resizeNotesTextarea(e.currentTarget)}
                              onChange={e => {
                                setNotes(e.target.value);
                                resizeNotesTextarea(e.currentTarget);
                              }}
                              className="bg-transparent border-none focus:ring-0 text-brand-900 dark:text-white font-bold text-xs flex-1 h-8 min-h-[2rem] max-h-32 resize-none"
                            />
                          </div>
                        )}
                      </div>
                    </div>

                    <div className={`rounded-xl border border-brand-800 ${isQuickSaveCollapsed ? 'p-0.5 space-y-0.5' : 'p-2.5 space-y-2'} bg-brand-950/40`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <p className="text-[7px] font-black uppercase tracking-[0.14em] text-slate-500 dark:text-slate-300">Quick Save to CRM</p>
                          <span
                            title="Save current pickup/dropoff into CRM: Home, Business, or Frequent places."
                            className="inline-flex items-center text-slate-400"
                          >
                            <Info size={11} />
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setIsQuickSaveCollapsed(prev => !prev)}
                          className={`${isQuickSaveCollapsed ? 'h-5 w-5 px-0 justify-center rounded-md border-transparent bg-transparent text-slate-400/90 hover:bg-white/10' : 'h-6 px-2 text-[7px] rounded-full border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'} font-black uppercase tracking-widest inline-flex items-center gap-1 transition-colors`}
                          title={isQuickSaveCollapsed ? 'Expand quick save actions' : 'Collapse quick save actions'}
                        >
                          {isQuickSaveCollapsed ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
                          {!isQuickSaveCollapsed && 'Hide'}
                        </button>
                      </div>
                      {!isQuickSaveCollapsed && (
                      <div className={`${navigationMode === 'SEQUENCE'
                        ? 'flex flex-nowrap items-stretch gap-2 overflow-x-auto px-1 pb-1 snap-x snap-mandatory scroll-px-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
                        : 'grid grid-cols-1 sm:grid-cols-2 gap-2'}`}>
                      <button
                        type="button"
                        onClick={() => upsertCustomerLocation('HOME', {
                          address: result?.pickupAddress,
                          mapsLink: pickupOriginalLink,
                          lat: typeof pickupPlace?.geometry?.location?.lat === 'function' ? pickupPlace.geometry.location.lat() : pickupPlace?.geometry?.location?.lat,
                          lng: typeof pickupPlace?.geometry?.location?.lng === 'function' ? pickupPlace.geometry.location.lng() : pickupPlace?.geometry?.location?.lng,
                        })}
                        title="Save current pickup as Home location in CRM."
                        aria-label="Save pickup as home"
                        className={`h-10 rounded-xl border border-blue-300 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 text-[9px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300 inline-flex items-center justify-center gap-1 ${navigationMode === 'SEQUENCE' ? 'shrink-0 snap-start min-w-[11.5rem]' : ''}`}
                      >
                        <House size={12} aria-hidden="true" />
                        Pickup → Home
                      </button>
                      <button
                        type="button"
                        onClick={() => upsertCustomerLocation('FREQUENT', {
                          address: result?.pickupAddress,
                          mapsLink: pickupOriginalLink,
                          lat: typeof pickupPlace?.geometry?.location?.lat === 'function' ? pickupPlace.geometry.location.lat() : pickupPlace?.geometry?.location?.lat,
                          lng: typeof pickupPlace?.geometry?.location?.lng === 'function' ? pickupPlace.geometry.location.lng() : pickupPlace?.geometry?.location?.lng,
                        })}
                        title="Save current pickup to Frequent places in CRM."
                        aria-label="Save pickup as frequent place"
                        className={`h-10 rounded-xl border border-cyan-300 dark:border-cyan-900/40 bg-cyan-50 dark:bg-cyan-900/10 text-[9px] font-black uppercase tracking-widest text-cyan-700 dark:text-cyan-300 inline-flex items-center justify-center gap-1 ${navigationMode === 'SEQUENCE' ? 'shrink-0 snap-start min-w-[11.5rem]' : ''}`}
                      >
                        <MapPin size={12} aria-hidden="true" />
                        Pickup → Frequent
                      </button>
                      <button
                        type="button"
                        onClick={() => upsertCustomerLocation('BUSINESS', {
                          address: result?.destinationAddress,
                          mapsLink: destinationOriginalLink,
                          lat: typeof destPlace?.geometry?.location?.lat === 'function' ? destPlace.geometry.location.lat() : destPlace?.geometry?.location?.lat,
                          lng: typeof destPlace?.geometry?.location?.lng === 'function' ? destPlace.geometry.location.lng() : destPlace?.geometry?.location?.lng,
                        })}
                        title="Save current dropoff as Business location in CRM."
                        aria-label="Save dropoff as business"
                        className={`h-10 rounded-xl border border-amber-300 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 text-[9px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-300 inline-flex items-center justify-center gap-1 ${navigationMode === 'SEQUENCE' ? 'shrink-0 snap-start min-w-[11.5rem]' : ''}`}
                      >
                        <Building2 size={12} aria-hidden="true" />
                        Dropoff → Business
                      </button>
                      <button
                        type="button"
                        onClick={() => upsertCustomerLocation('FREQUENT', {
                          address: result?.destinationAddress,
                          mapsLink: destinationOriginalLink,
                          lat: typeof destPlace?.geometry?.location?.lat === 'function' ? destPlace.geometry.location.lat() : destPlace?.geometry?.location?.lat,
                          lng: typeof destPlace?.geometry?.location?.lng === 'function' ? destPlace.geometry.location.lng() : destPlace?.geometry?.location?.lng,
                        })}
                        title="Save current dropoff to Frequent places in CRM."
                        aria-label="Save dropoff as frequent place"
                        className={`h-10 rounded-xl border border-emerald-300 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[9px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300 inline-flex items-center justify-center gap-1 ${navigationMode === 'SEQUENCE' ? 'shrink-0 snap-start min-w-[11.5rem]' : ''}`}
                      >
                        <Navigation size={12} aria-hidden="true" />
                        Dropoff → Frequent
                      </button>
                      </div>
                      )}
                    </div>
                    </div>

                    <div ref={saveDispatchAnchorRef}>
                    <Button onClick={handleSaveTrip} className="mt-4 w-full h-12 shadow-xl inline-flex items-center justify-center gap-2" variant={tripSaved ? 'secondary' : 'gold'}>
                      {tripSaved ? <Check size={14} /> : <Save size={14} />}
                      {tripSaved ? 'Committed to Log' : 'Save Dispatch'}
                    </Button>
                    </div>

                    {navigationMode === 'SEQUENCE' && activeSequenceStage === 'OUTPUT' && outputNeedsAttention && isOutputReadinessPanelDismissed && (
                      <button
                        type="button"
                        onClick={() => {
                          setIsOutputReadinessPanelDismissed(false);
                        }}
                        className="mt-2 h-9 px-3 rounded-xl border border-amber-300 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 text-[8px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-300 inline-flex items-center justify-center gap-1"
                      >
                        <AlertCircle size={11} />
                        Open Readiness Panel
                      </button>
                    )}

                    {renderSequenceWorkflowDock()}
                 </div>
           ) : (
              <div className="py-20 text-center flex flex-col items-center">
                 <div className="w-16 h-16 bg-slate-100 dark:bg-brand-950 rounded-3xl flex items-center justify-center text-slate-300 mb-4 border border-slate-200 dark:border-brand-800">
                   <CalcIcon size={24} />
                 </div>
                 <p className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">Ready for Calculation</p>
              </div>
           )}
           </div>
        </div>
      </div>

         <div id="calc-stage-map" className={`relative min-w-0 overflow-hidden bg-slate-200 dark:bg-brand-950 h-[45vh] min-h-[300px] lg:h-full lg:min-h-0 lg:flex-1 transition-all duration-300 ${isRouteStageVisible ? 'opacity-100' : 'hidden opacity-0'}`}>
         <div ref={mapRef} className="w-full h-full" />
         
         {calculating && (
           <div className="absolute inset-0 bg-brand-950/40 backdrop-blur-[2px] z-20 flex flex-col items-center justify-center animate-fade-in">
              <div className="bg-white dark:bg-brand-900 px-8 py-6 rounded-3xl shadow-2xl flex flex-col items-center border border-slate-200 dark:border-brand-800">
                 <div className="relative mb-4">
                    <Radar className="w-12 h-12 text-gold-500 animate-spin" />
                    <Loader2 className="w-12 h-12 text-blue-500 animate-spin absolute inset-0 opacity-50" style={{ animationDirection: 'reverse' }} />
                 </div>
                 <p className="text-[10px] font-black uppercase tracking-[0.3em] text-brand-900 dark:text-gold-400">Scanning Signal</p>
                 <p className="text-[8px] font-bold uppercase text-slate-400 mt-2">Computing optimal vector...</p>
              </div>
           </div>
         )}

         {pendingLocation && (
            <div className="absolute inset-0 bg-brand-950/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
               <div className="bg-white dark:bg-brand-900 rounded-3xl p-8 max-w-sm w-full shadow-2xl border border-slate-200 dark:border-brand-800">
                  <h3 className="text-xl font-black text-brand-900 dark:text-slate-100 uppercase mb-6 text-center">Set Marker</h3>
                  <div className="space-y-3">
                     <button onClick={() => confirmPending('pickup')} className="w-full h-14 bg-white dark:bg-brand-950 border-2 border-slate-100 dark:border-brand-800 rounded-2xl font-black uppercase text-xs hover:border-gold-500 transition-all flex items-center px-4">
                        <div className="w-8 h-8 rounded-lg bg-gold-600 text-brand-950 flex items-center justify-center mr-4">A</div> Pickup Point
                     </button>
                     <button onClick={() => confirmPending('dest')} className="w-full h-14 bg-white dark:bg-brand-950 border-2 border-slate-100 dark:border-brand-800 rounded-2xl font-black uppercase text-xs hover:border-blue-500 transition-all flex items-center px-4">
                        <div className="w-8 h-8 rounded-lg bg-brand-900 text-gold-400 flex items-center justify-center mr-4">B</div> Drop-off Point
                     </button>
                      {canPinStopsFromMap && (
                        <button onClick={confirmPendingStop} className="w-full h-14 bg-white dark:bg-brand-950 border-2 border-slate-100 dark:border-brand-800 rounded-2xl font-black uppercase text-xs hover:border-cyan-500 transition-all flex items-center px-4">
                          <div className="w-8 h-8 rounded-lg bg-cyan-500 text-white flex items-center justify-center mr-4">S</div> Add Stop
                        </button>
                      )}
                      {!canPinStopsFromMap && (
                        <p className="text-[9px] font-black uppercase tracking-widest text-slate-400 text-center px-2">
                         Set pickup and drop-off first to pin map stops.
                        </p>
                      )}
                     <button onClick={() => setPendingLocation(null)} className="w-full py-4 text-[10px] font-black uppercase text-slate-400 hover:text-red-500 transition-colors tracking-widest">Cancel</button>
                  </div>
               </div>
            </div>
         )}
      </div>

      {isCustomerSequenceSnapshotPanelVisible && quoteCustomerSnapshot && (
        <div className="hidden lg:flex lg:flex-1 lg:h-full min-h-0 min-w-0 overflow-hidden border-l-2 border-slate-300 dark:border-brand-800 bg-slate-100/70 dark:bg-brand-950">
          <div className="w-full h-full overflow-y-auto overscroll-contain scroll-smooth [scrollbar-gutter:stable] p-5 xl:p-6">
            <div className="rounded-2xl border border-slate-200 dark:border-brand-800 border-t-2 border-t-gold-500/40 bg-white dark:bg-brand-900 p-3 xl:p-4 shadow-xl">
              <div className="mb-3 pb-2 border-b border-slate-200 dark:border-brand-800">
                <p className="text-[8px] font-black uppercase tracking-[0.2em] text-slate-500 dark:text-slate-300">Customer Snapshot</p>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mt-1">Right Panel Intelligence</p>
              </div>
              <CustomerSnapshotCard snapshot={quoteCustomerSnapshot} />
            </div>
          </div>
        </div>
      )}

      {isOutputSequenceDriverInsightPanelVisible && outputDriverInsightTarget && outputDriverInsight && (
        <div key={`output-driver-panel-${outputDriverInsightTarget.id}-${outputDriverInsightMode}`} className="hidden lg:flex lg:flex-1 lg:h-full min-h-0 min-w-0 overflow-hidden border-l-2 border-slate-300 dark:border-brand-800 bg-slate-100/70 dark:bg-brand-950">
          <div className="w-full h-full overflow-y-auto overscroll-contain scroll-smooth [scrollbar-gutter:stable] px-5 pb-5 pt-16 xl:px-6 xl:pb-6 xl:pt-20">
            <div className="rounded-2xl border border-slate-200 dark:border-brand-800 border-t-2 border-t-gold-500/40 bg-white dark:bg-brand-900 p-4 xl:p-5 shadow-xl space-y-4">
              <div className="pb-3 border-b border-slate-200 dark:border-brand-800">
                <p className="text-[8px] font-black uppercase tracking-[0.2em] text-slate-500 dark:text-slate-300">Driver Intelligence</p>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-800 dark:text-slate-100">{outputDriverInsightTarget.name}</p>
                    <p className="text-[8px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">{outputDriverInsightTarget.plateNumber} · {outputDriverInsightTarget.carModel}</p>
                  </div>
                  <span className="h-7 px-2 rounded-md border border-gold-300 dark:border-gold-900/40 bg-gold-50 dark:bg-gold-900/10 text-[8px] font-black uppercase tracking-widest text-gold-700 dark:text-gold-300 inline-flex items-center">
                    Smart Score {outputDriverInsight.overall}
                  </span>
                </div>
                <p className="mt-1 text-[7px] font-black uppercase tracking-widest text-slate-400">
                  {outputDriverInsightMode === 'ASSIGNED' ? 'Assigned Driver View' : 'Top Recommendation View'}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-1.5 text-[8px] font-black uppercase tracking-widest">
                <div className="h-8 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-slate-600 dark:text-slate-200 inline-flex items-center">Availability {outputDriverInsightTarget.currentStatus}</div>
                <div className="h-8 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-slate-600 dark:text-slate-200 inline-flex items-center">Trip Fit {Math.round(outputDriverInsight.tripFitScore)}</div>
                <div className="h-8 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-slate-600 dark:text-slate-200 inline-flex items-center">Readiness {Math.round(outputDriverInsight.readinessScore)}</div>
                <div className="h-8 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-slate-600 dark:text-slate-200 inline-flex items-center">Governance {Math.round(outputDriverInsight.governanceScore)}</div>
              </div>

              {outputDriverInsight.reasons.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {outputDriverInsight.reasons.map(reason => (
                    <span
                      key={reason}
                      className="h-7 px-2 rounded-md border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[7px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300 inline-flex items-center"
                    >
                      {reason}
                    </span>
                  ))}
                </div>
              )}

              <div className="space-y-2">
                <p className="text-[8px] font-black uppercase tracking-[0.16em] text-slate-500 dark:text-slate-300">Driver Record</p>
                <div className="grid grid-cols-2 gap-1.5 text-[8px] font-black uppercase tracking-widest">
                  <div className="h-8 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-slate-600 dark:text-slate-200 inline-flex items-center">Trips {outputDriverInsight.totalTrips}</div>
                  <div className="h-8 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-slate-600 dark:text-slate-200 inline-flex items-center">Recent 30d {outputDriverInsight.recentTrips30}</div>
                  <div className="h-8 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-slate-600 dark:text-slate-200 inline-flex items-center">Completed {outputDriverInsight.completedTrips}</div>
                  <div className="h-8 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-slate-600 dark:text-slate-200 inline-flex items-center">Performance {Math.round(outputDriverInsight.performanceScore)}</div>
                </div>
                {outputDriverInsight.fairnessPenalty > 0 && (
                  <div className="h-8 px-2 rounded-md border border-blue-200 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 text-[8px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300 inline-flex items-center">
                    Rotation penalty active ({outputDriverInsight.fairnessPenalty})
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-[8px] font-black uppercase tracking-[0.16em] text-slate-500 dark:text-slate-300">Unit Readiness & Governance</p>
                <div className="grid grid-cols-2 gap-1.5 text-[8px] font-black uppercase tracking-widest">
                  <div className="h-8 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-slate-600 dark:text-slate-200 inline-flex items-center">Fuel {Math.round(outputDriverInsight.fuelRangeKm)} km</div>
                  <div className="h-8 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-slate-600 dark:text-slate-200 inline-flex items-center">Oil +{Math.round(outputDriverInsight.kmSinceOilChange)} km</div>
                  <div className="h-8 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-slate-600 dark:text-slate-200 inline-flex items-center">Checkup +{Math.round(outputDriverInsight.kmSinceCheckup)} km</div>
                  <div className="h-8 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-slate-600 dark:text-slate-200 inline-flex items-center">Customer Affinity {outputDriverInsight.customerAffinityTrips}</div>
                </div>
                {(outputDriverInsight.readinessAlerts.length > 0 || outputDriverInsight.governanceAlerts.length > 0) && (
                  <div className="space-y-1.5">
                    {outputDriverInsight.readinessAlerts.map(alert => (
                      <div
                        key={`ready-${alert}`}
                        className="min-h-8 px-2.5 py-1.5 rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 text-[8px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-300"
                      >
                        {alert}
                      </div>
                    ))}
                    {outputDriverInsight.governanceAlerts.map(alert => (
                      <div
                        key={`gov-${alert}`}
                        className="min-h-8 px-2.5 py-1.5 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 text-[8px] font-black uppercase tracking-widest text-red-700 dark:text-red-300"
                      >
                        {alert}
                      </div>
                    ))}
                  </div>
                )}
                {outputDriverInsight.isGovernanceBlocked && (
                  <div className="min-h-8 px-2.5 py-1.5 rounded-lg border border-red-300 dark:border-red-900/40 bg-red-50 dark:bg-red-900/15 text-[8px] font-black uppercase tracking-widest text-red-700 dark:text-red-300">
                    Governance blocked: assign another active/available unit.
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-[8px] font-black uppercase tracking-[0.16em] text-slate-500 dark:text-slate-300">Recommended Drivers</p>
                <div className="space-y-1.5">
                  {recommendedDrivers.slice(0, 3).map(driver => {
                    const insight = driverIntelligenceById.get(driver.id);
                    const isActiveSelection = selectedDriverId === driver.id;
                    return (
                      <button
                        key={`intel-recommend-${driver.id}`}
                        type="button"
                        onClick={() => handleSelectDriverFromSuggestions(driver)}
                        className={`w-full min-h-9 px-2.5 py-1.5 rounded-lg border text-[8px] font-black uppercase tracking-widest inline-flex items-center justify-between gap-2 ${isActiveSelection
                          ? 'border-emerald-300 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-emerald-700 dark:text-emerald-300'
                          : 'border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-slate-600 dark:text-slate-200'}`}
                      >
                        <span className="truncate">{driver.name} ({driver.plateNumber})</span>
                        <span className="shrink-0 text-[7px]">S{insight?.overall ?? 0}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {isOutputSequenceReadinessPanelVisible && result && (
        <div className="hidden lg:flex lg:flex-1 lg:h-full min-h-0 min-w-0 overflow-hidden border-l-2 border-slate-300 dark:border-brand-800 bg-slate-100/70 dark:bg-brand-950">
          <div className="w-full h-full overflow-y-auto overscroll-contain scroll-smooth [scrollbar-gutter:stable] px-5 pb-5 pt-16 xl:px-6 xl:pb-6 xl:pt-20">
            <div className="rounded-2xl border border-slate-200 dark:border-brand-800 border-t-2 border-t-gold-500/40 bg-white dark:bg-brand-900 p-4 xl:p-5 shadow-xl space-y-4">
              <div className="pb-3 border-b border-slate-200 dark:border-brand-800">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-left text-[8px] font-black uppercase tracking-[0.2em] text-slate-500 dark:text-slate-300">
                    Dispatch Readiness
                  </p>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setIsOutputReadinessPanelDismissed(true)}
                      className="h-6 w-6 rounded-md border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-slate-500 dark:text-slate-300 inline-flex items-center justify-center"
                      title="Close readiness panel"
                    >
                      <X size={10} />
                    </button>
                  </div>
                </div>
                <div className="mt-2 inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 border text-[9px] font-black uppercase tracking-widest">
                  {outputNeedsAttention ? (
                    <>
                      <AlertCircle size={12} className="text-amber-500" />
                      <span className="text-amber-700 dark:text-amber-300">Needs Attention ({outputBlockingChecks.length + outputRiskFlags.length})</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck size={12} className="text-emerald-500" />
                      <span className="text-emerald-700 dark:text-emerald-300">Ready to Dispatch</span>
                    </>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-[8px] font-black uppercase tracking-[0.16em] text-slate-500 dark:text-slate-300">Risk Flags</p>
                {outputRiskFlags.length > 0 ? (
                  <div className="space-y-1.5">
                    {outputRiskFlags.map(flag => (
                      <div
                        key={flag.key}
                        className="min-h-8 px-2.5 py-1.5 rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 text-[8px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-300 inline-flex items-center gap-1.5"
                      >
                        {flag.icon === 'TRAFFIC' && <Gauge size={10} className="text-cyan-500" />}
                        {flag.icon === 'DELAY' && <Clock size={10} />}
                        {flag.icon === 'FARE' && <DollarSign size={10} />}
                        {flag.icon === 'PAYMENT' && <ArrowRightLeft size={10} />}
                        <span>{flag.label}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="h-8 px-2.5 rounded-lg border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[8px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300 inline-flex items-center">
                    No active risk flags
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-[8px] font-black uppercase tracking-[0.16em] text-slate-500 dark:text-slate-300">Route Frame</p>
                <div className="rounded-lg border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 p-2 space-y-1.5">
                  <div className="text-[7px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">Pickup · {truncateUiText(result.pickupAddress || 'N/A', 42)}</div>
                  <div className="text-[7px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">Dropoff · {truncateUiText(result.destinationAddress || 'N/A', 42)}</div>
                  <div className="grid grid-cols-2 gap-1.5 text-[7px] font-black uppercase tracking-widest">
                    <span className="h-7 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-slate-600 dark:text-slate-200 inline-flex items-center">Distance {result.distanceKm} km</span>
                    <span className="h-7 px-2 rounded-md border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-slate-600 dark:text-slate-200 inline-flex items-center">Baseline {result.durationText}</span>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-[8px] font-black uppercase tracking-[0.16em] text-slate-500 dark:text-slate-300">Handoff Notes</p>
                {outputNotesPreview ? (
                  <div className="rounded-lg border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 px-2.5 py-2 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-200">
                    {truncateUiText(outputNotesPreview, 140)}
                  </div>
                ) : (
                  <div className="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 text-[8px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300 inline-flex items-center">
                    No specific notes
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {lastSavedTrip && (
        <MessageModal 
          isOpen={showMessageModal}
          onClose={() => setShowMessageModal(false)}
          title="Send Trip Confirmation"
          initialMessage={replacePlaceholders(settings.templates.trip_confirmation, lastSavedTrip, drivers, settings)}
          recipientPhone={lastSavedTrip.customerPhone}
          operatorPhone={settings.operatorWhatsApp}
          customerSnapshot={savedTripSnapshot || undefined}
          onMarkSent={(finalMsg) => {
            updateFullTrip({ ...lastSavedTrip, confirmation_sent_at: new Date().toISOString() });
            setShowMessageModal(false);
          }}
        />
      )}

      {calcActionToast && (
        <div className="fixed bottom-4 right-4 z-[120] rounded-xl border border-blue-200 dark:border-blue-800/40 bg-blue-50 dark:bg-blue-900/25 px-4 py-2.5 text-[9px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300 shadow-xl">
          {calcActionToast}
        </div>
      )}

    </div>
  );
};
