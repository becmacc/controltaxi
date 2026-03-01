
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useStore } from '../context/StoreContext';
import { loadGoogleMapsScript } from '../services/googleMapsLoader';
import { parseGoogleMapsLink, parseGpsOrLatLngInput, ParsedLocation } from '../services/locationParser';
import { SPECIAL_REQUIREMENTS } from '../constants';
import { RouteResult, TripStatus, Customer, CustomerLocation, Trip, TripStop } from '../types';
import { Button } from '../components/ui/Button';
import { 
  MapPin, Navigation, Copy, Check, Save, Calculator as CalcIcon, 
  Clock, Link as LinkIcon, User, Phone, FileText, DollarSign, 
  Repeat, Hourglass, ChevronDown, ChevronUp, AlertCircle, 
  Calendar, Settings, Car, Crosshair, RefreshCcw, Info, InfoIcon,
  Layers, Search, X, Star, Loader2, Radar, ShieldCheck, Zap, UserX, MessageCircle
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
} from '../services/whatsapp';
import { buildCustomerSnapshot, buildCustomerSnapshotForTrip } from '../services/customerSnapshot';
import { customerPhoneKey } from '../services/customerProfile';
import { clampTrafficIndex, computeTrafficIndex } from '../services/trafficMetrics';

declare var google: any;

const CALCULATOR_DRAFT_KEY = 'calculator_draft_v1';

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
  const { settings, addTrip, theme, customers, drivers, trips, updateFullTrip, addCustomers } = useStore();
  const navigate = useNavigate();
  
  // Maps State
  const [mapsLoaded, setMapsLoaded] = useState(false);
  const [error, setError] = useState<React.ReactNode | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  
  const pickupInputRef = useRef<HTMLInputElement>(null);
  const destInputRef = useRef<HTMLInputElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  
  // Maps Objects Refs
  const mapInstance = useRef<any>(null);
  const markers = useRef<{ pickup: any, dest: any }>({ pickup: null, dest: null });
  const stopMarkers = useRef<any[]>([]);
  const routePolyline = useRef<any>(null);
  const geocoder = useRef<any>(null);
  const usingAdvancedMarkers = useRef(false);
  const inputResolveTokenRef = useRef(0);
  
  // Autocomplete Refs
  const pickupAcRef = useRef<any>(null);
  const destAcRef = useRef<any>(null);
  const stopInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const stopAutocompleteRefs = useRef<any[]>([]);

  // Data State
  const [pickupPlace, setPickupPlace] = useState<any>(null);
  const [destPlace, setDestPlace] = useState<any>(null);
  const [pickupOriginalLink, setPickupOriginalLink] = useState<string | undefined>(undefined);
  const [destinationOriginalLink, setDestinationOriginalLink] = useState<string | undefined>(undefined);
  const [stopsDraft, setStopsDraft] = useState<string[]>([]);
  const [stopCandidates, setStopCandidates] = useState<Array<TripStop | null>>([]);
  const [resolvedStops, setResolvedStops] = useState<TripStop[]>([]);
  const [pendingLocation, setPendingLocation] = useState<{ lat: number, lng: number } | null>(null);
  
  // Time State
  const [tripDate, setTripDate] = useState<string>('');
  const [dateRequiredError, setDateRequiredError] = useState(false);

  // Directory / Customer State
  const [searchDirectory, setSearchDirectory] = useState('');
  const [showDirectoryResults, setShowDirectoryResults] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerPhoneIntlEnabled, setCustomerPhoneIntlEnabled] = useState(false);
  const [customerPhoneDialCode, setCustomerPhoneDialCode] = useState(DEFAULT_PHONE_DIAL_CODE);
  const [customerPhoneUseCustomDialCode, setCustomerPhoneUseCustomDialCode] = useState(false);
  const [customerPhoneCustomDialCode, setCustomerPhoneCustomDialCode] = useState('');
  const [selectedDriverId, setSelectedDriverId] = useState('');

  const customerPhonePopularPresets = PHONE_COUNTRY_PRESETS;
  const resolvedCustomerCustomDialCode = customerPhoneCustomDialCode.replace(/\D/g, '');
  const selectedCustomerIntlDialCode = customerPhoneUseCustomDialCode
    ? (resolvedCustomerCustomDialCode || customerPhoneDialCode || DEFAULT_PHONE_DIAL_CODE)
    : customerPhoneDialCode;
  const customerPhoneEffectiveDialCode = customerPhoneIntlEnabled ? selectedCustomerIntlDialCode : DEFAULT_PHONE_DIAL_CODE;

  const activeDrivers = useMemo(
    () => drivers.filter(d => d.status === 'ACTIVE'),
    [drivers]
  );

  const assignedDriver = useMemo(
    () => drivers.find(d => d.id === selectedDriverId),
    [drivers, selectedDriverId]
  );

  useEffect(() => {
    if (!selectedDriverId) return;
    const stillAssignable = drivers.some(
      d => d.id === selectedDriverId && d.status === 'ACTIVE'
    );
    if (!stillAssignable) {
      setSelectedDriverId('');
    }
  }, [drivers, selectedDriverId]);

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

  const quoteCustomerSnapshot = useMemo(() => {
    const name = customerName.trim();
    const phone = customerPhone.trim();
    if (!name && !phone) return null;
    return buildCustomerSnapshot(name, phone, customers, trips, drivers);
  }, [customerName, customerPhone, customers, trips, drivers]);

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

  const operatorIndexMarkers = ['NEW', 'CORP', 'AIRPORT', 'PRIORITY', 'FOLLOWUP'] as const;

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

    const combined: CustomerLocation[] = [];
    if (quoteDirectoryCustomer.homeLocation) {
      combined.push({ ...quoteDirectoryCustomer.homeLocation, label: 'Home' });
    }
    if (quoteDirectoryCustomer.businessLocation) {
      combined.push({ ...quoteDirectoryCustomer.businessLocation, label: 'Business' });
    }
    if (Array.isArray(quoteDirectoryCustomer.frequentLocations)) {
      combined.push(...quoteDirectoryCustomer.frequentLocations);
    }

    const seen = new Set<string>();
    return combined.filter(location => {
      const key = `${(location.address || '').toLowerCase()}|${String(location.mapsLink || '').toLowerCase()}|${location.lat ?? ''}|${location.lng ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [quoteDirectoryCustomer]);

  // Options State
  const [isRoundTrip, setIsRoundTrip] = useState(false);
  const [addWaitTime, setAddWaitTime] = useState(false);
  const [waitTimeHours, setWaitTimeHours] = useState(0);
  const [selectedRequirements, setSelectedRequirements] = useState<string[]>([]);

  // Calculation State
  const [calculating, setCalculating] = useState(false);
  const [result, setResult] = useState<RouteResult | null>(null);
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

  const hasAnyOperatorMarker = operatorIndexMarkers.some(marker => hasOperatorMarker(marker));
  const shouldShowQuickMarkers =
    Boolean(customerName.trim() || customerPhone.trim()) &&
    (!quoteDirectoryCustomer || hasAnyOperatorMarker);

  const savedTripSnapshot = useMemo(() => {
    if (!lastSavedTrip) return null;
    return buildCustomerSnapshotForTrip(lastSavedTrip, customers, trips, drivers);
  }, [lastSavedTrip, customers, trips, drivers]);

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

    if (usingAdvancedMarkers.current && google.maps.marker?.AdvancedMarkerElement && google.maps.marker?.PinElement) {
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map: mapInstance.current,
        position,
        content: new google.maps.marker.PinElement({ glyph: label, background: color, borderColor: 'white' }).element,
        gmpDraggable: draggable,
      });
      if (onDragEnd) marker.addListener('dragend', onDragEnd);
      return marker;
    }

    const marker = new google.maps.Marker({
      map: mapInstance.current,
      position,
      draggable,
      label: { text: label, color: '#ffffff', fontWeight: '700' },
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 10,
        fillColor: color,
        fillOpacity: 1,
        strokeColor: '#ffffff',
        strokeWeight: 2,
      },
    });
    if (onDragEnd) marker.addListener('dragend', onDragEnd);
    return marker;
  };

  const styleMapMarker = (marker: any, label: string, color: string) => {
    if (!marker) return;

    if (usingAdvancedMarkers.current && google.maps.marker?.PinElement && marker.content !== undefined) {
      marker.content = new google.maps.marker.PinElement({ glyph: label, background: color, borderColor: 'white' }).element;
      return;
    }

    if (typeof marker.setLabel === 'function') {
      marker.setLabel({ text: label, color: '#ffffff', fontWeight: '700' });
    }
    if (typeof marker.setIcon === 'function') {
      marker.setIcon({
        path: google.maps.SymbolPath.CIRCLE,
        scale: 10,
        fillColor: color,
        fillOpacity: 1,
        strokeColor: '#ffffff',
        strokeWeight: 2,
      });
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
    const minimumFutureMs = 2 * 60 * 1000;
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

    const restrictedEndpoint = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&components=country:LB&key=${encodeURIComponent(settings.googleMapsApiKey)}`;
    const restrictedResponse = await fetch(restrictedEndpoint);
    if (restrictedResponse.ok) {
      const restrictedPayload = await restrictedResponse.json();
      const restrictedResult = parseFirstResult(restrictedPayload);
      if (restrictedResult) return restrictedResult;
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
      if (typeof draft.isRoundTrip === 'boolean') setIsRoundTrip(draft.isRoundTrip);
      if (typeof draft.addWaitTime === 'boolean') setAddWaitTime(draft.addWaitTime);
      if (typeof draft.waitTimeHours === 'number') setWaitTimeHours(draft.waitTimeHours);
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
        const selectedMapId = (theme === 'dark' ? settings.googleMapsMapIdDark : settings.googleMapsMapId) || settings.googleMapsMapId;
        const mapOptions: any = {
          center: { lat: 33.8938, lng: 35.5018 },
          zoom: 12,
          disableDefaultUI: true
        };
        if (selectedMapId) {
          mapOptions.mapId = selectedMapId;
        }

        usingAdvancedMarkers.current = Boolean(
          mapOptions.mapId && google.maps.marker?.AdvancedMarkerElement && google.maps.marker?.PinElement
        );

        mapInstance.current = new google.maps.Map(mapRef.current, {
          ...mapOptions
        });
        geocoder.current = new google.maps.Geocoder();
        mapInstance.current.addListener("click", (e: any) => e.latLng && setPendingLocation({ lat: e.latLng.lat(), lng: e.latLng.lng() }));
        
        markers.current.pickup = createMapMarker('A', '#d4a017', { lat: 33.8938, lng: 35.5018 }, true, () => handleMarkerDrag('pickup'));
        markers.current.dest = createMapMarker('B', '#2563eb', { lat: 33.8938, lng: 35.5018 }, true, () => handleMarkerDrag('dest'));

        if (pickupInputRef.current) {
          pickupAcRef.current = new google.maps.places.Autocomplete(pickupInputRef.current, {
            componentRestrictions: { country: 'lb' },
            fields: ['place_id', 'geometry', 'formatted_address', 'name'],
            types: ['geocode']
          });
          pickupAcRef.current.addListener('place_changed', () => {
            const place = pickupAcRef.current.getPlace();
            if (place.geometry) {
              setPickupPlace(place);
              setPickupOriginalLink(undefined);
              setMarkerPosition(markers.current.pickup, place.geometry.location);
              mapInstance.current.panTo(place.geometry.location);
            }
          });
        }
        if (destInputRef.current) {
          destAcRef.current = new google.maps.places.Autocomplete(destInputRef.current, {
            componentRestrictions: { country: 'lb' },
            fields: ['place_id', 'geometry', 'formatted_address', 'name'],
            types: ['geocode']
          });
          destAcRef.current.addListener('place_changed', () => {
            const place = destAcRef.current.getPlace();
            if (place.geometry) {
              setDestPlace(place);
              setDestinationOriginalLink(undefined);
              setMarkerPosition(markers.current.dest, place.geometry.location);
              mapInstance.current.panTo(place.geometry.location);
            }
          });
        }
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
    if (!mapsLoaded || !google?.maps?.places?.Autocomplete) return;

    setStopCandidates(prev => {
      const next = prev.slice(0, stopsDraft.length);
      while (next.length < stopsDraft.length) next.push(null);
      return next;
    });

    stopAutocompleteRefs.current.forEach(instance => {
      if (instance && google?.maps?.event?.clearInstanceListeners) {
        google.maps.event.clearInstanceListeners(instance);
      }
    });
    stopAutocompleteRefs.current = [];

    stopInputRefs.current = stopInputRefs.current.slice(0, stopsDraft.length);

    stopInputRefs.current.forEach((input, index) => {
      if (!input) return;
      const autocomplete = new google.maps.places.Autocomplete(input, {
        componentRestrictions: { country: 'lb' },
        fields: ['place_id', 'geometry', 'formatted_address', 'name'],
        types: ['geocode'],
      });

      autocomplete.addListener('place_changed', () => {
        const place = autocomplete.getPlace();
        const nextValue = place?.formatted_address || place?.name;
        if (!nextValue) return;
        setStopsDraft(prev => prev.map((entry, i) => (i === index ? nextValue : entry)));

        const lat = Number(place?.geometry?.location?.lat?.() ?? place?.geometry?.location?.lat);
        const lng = Number(place?.geometry?.location?.lng?.() ?? place?.geometry?.location?.lng);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          const candidate: TripStop = {
            text: nextValue,
            placeId: place?.place_id || 'GEOCODED_STOP',
            lat,
            lng,
          };
          setStopCandidates(prev => prev.map((entry, i) => (i === index ? candidate : entry)));
        }
      });

      stopAutocompleteRefs.current[index] = autocomplete;
    });

    return () => {
      stopAutocompleteRefs.current.forEach(instance => {
        if (instance && google?.maps?.event?.clearInstanceListeners) {
          google.maps.event.clearInstanceListeners(instance);
        }
      });
      stopAutocompleteRefs.current = [];
    };
  }, [mapsLoaded, stopsDraft.length]);

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
    setFareUsd(base + wait);
    setFareLbp((base + wait) * settings.exchangeRate);
  };

  const toggleRequirement = (id: string) => {
    setSelectedRequirements(prev => 
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const handleSelectCustomer = (c: Customer) => {
    setCustomerName(c.name);
    setCustomerPhone(c.phone);
    const detectedDialCode = detectPhoneDialCode(c.phone) || DEFAULT_PHONE_DIAL_CODE;
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
    setSearchDirectory('');
    setShowDirectoryResults(false);
  };

  const handleResetPreQuoteCustomer = () => {
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
    const shouldSetHomeOnSmart = target === 'SMART_PICKUP' && !existing?.homeLocation?.address;

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
      ...((target === 'HOME' || shouldSetHomeOnSmart) ? { homeLocation: nextLocation } : (existing?.homeLocation ? { homeLocation: existing.homeLocation } : {})),
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
            ? (shouldSetHomeOnSmart ? 'Pickup added to Frequent and set as Home.' : 'Pickup added to Frequent (Home kept).')
            : 'Location added to Frequent places.'
    );
  };

  const buildCurrentTripData = (): Trip => {
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
      ...(resolvedStops.length > 0 ? { stops: resolvedStops } : {}),
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

  const handleSaveTrip = () => {
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

    const trimmedStops = stopsDraft.map(value => value.trim()).filter(Boolean);
    if (trimmedStops.length > 0 && resolvedStops.length !== trimmedStops.length) {
      setError('Resolve all stops from autocomplete before saving dispatch.');
      return;
    }

    try {
      const tripData = buildCurrentTripData();
      addTrip(tripData);
      setLastSavedTrip(tripData);
      setShowMessageModal(true);
      setTripSaved(true);
      setDateRequiredError(false);
      setError(null);
      setCustomerName('');
      setCustomerPhone('');
      setCustomerPhoneIntlEnabled(false);
      setCustomerPhoneDialCode(DEFAULT_PHONE_DIAL_CODE);
      setCustomerPhoneUseCustomDialCode(false);
      setCustomerPhoneCustomDialCode('');
      setSelectedDriverId('');
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
    const quoteMsg = replacePlaceholders(settings.templates.trip_confirmation, tempTrip, drivers);
    navigator.clipboard.writeText(quoteMsg);
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
    const quoteMsg = replacePlaceholders(settings.templates.trip_confirmation, tempTrip, drivers);
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
    const quoteMsg = replacePlaceholders(settings.templates.trip_confirmation, tempTrip, drivers);
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

  return (
    <div className="flex flex-col lg:flex-row min-h-screen lg:h-full bg-slate-50 dark:bg-brand-950">
      <div className="lg:w-96 flex flex-col h-auto lg:h-full bg-white dark:bg-brand-900 border-r border-slate-200 dark:border-brand-800 z-10 shadow-xl overflow-y-auto">
        <div className="bg-brand-950 px-4 py-2 flex justify-between items-center border-b border-brand-800">
           <div className="flex items-center space-x-2">
             <div className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
             <span className="text-[8px] font-black text-slate-400 uppercase tracking-[0.2em]">${settings.ratePerKm}/km Rate Active</span>
           </div>
           <span className="text-[8px] font-black text-slate-400 uppercase tracking-[0.2em]">{settings.exchangeRate.toLocaleString()} LBP/$</span>
        </div>

        <div className="p-5 space-y-6">
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
           <div className="space-y-4">
              <div className="space-y-3">
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
                 <div className="space-y-2 rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 p-3">
                   <div className="flex items-center justify-between">
                     <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Stops (Optional)</label>
                     <button
                       type="button"
                       onClick={addStopField}
                       className="h-6 px-2 rounded-md border border-slate-300 dark:border-brand-700 bg-slate-50 dark:bg-brand-950 text-[7px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300"
                     >
                       Add Stop
                     </button>
                   </div>
                   {stopsDraft.length > 0 ? (
                     <div className="space-y-2">
                       {stopsDraft.map((stopValue, index) => (
                         <div key={`stop-${index}`} className="flex items-center gap-2">
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

                  <div className="space-y-2">
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">Scheduled Mission</label>
                    <input type="datetime-local" value={tripDate} onChange={e => {setTripDate(e.target.value); setDateRequiredError(false);}} className={`w-full h-11 px-4 rounded-xl border bg-slate-50 dark:bg-brand-950 text-xs font-bold transition-all ${dateRequiredError ? 'border-red-500' : 'border-slate-200 dark:border-brand-800'}`} />
                  </div>

              <div className="grid grid-cols-2 gap-3">
                 <button onClick={() => setIsRoundTrip(!isRoundTrip)} className={`h-11 rounded-xl text-[9px] font-black uppercase tracking-widest border-2 transition-all flex items-center justify-center ${isRoundTrip ? 'bg-brand-900 text-gold-400 border-brand-900' : 'bg-slate-50 border-slate-100 text-slate-400'}`}>
                   <Repeat size={14} className="mr-2"/> {isRoundTrip ? 'Round Trip' : 'One Way'}
                 </button>
                 <div className="flex bg-slate-50 rounded-xl p-0.5 border-2 border-slate-100 dark:bg-brand-950 dark:border-brand-800">
                    <button onClick={() => setAddWaitTime(!addWaitTime)} className={`h-9 w-9 rounded-lg flex items-center justify-center ${addWaitTime ? 'bg-gold-600 text-brand-950' : 'text-slate-300'}`}><Clock size={14}/></button>
                    <input type="number" disabled={!addWaitTime} value={waitTimeHours} onChange={e => setWaitTimeHours(parseFloat(e.target.value) || 0)} className="flex-1 bg-transparent text-center text-[10px] font-black border-none focus:ring-0" placeholder="Hrs" />
                 </div>
              </div>

              <div className="space-y-2 rounded-xl border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 p-3">
                <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">Customer Profile (Quote + WhatsApp)</label>
                <div className="grid grid-cols-1 gap-2">
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500"><Search size={13} /></div>
                    <input
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
                  <div className="flex items-center bg-white dark:bg-brand-900 border border-slate-200 dark:border-brand-800 rounded-xl px-3 h-10">
                    <User size={13} className="text-gold-600 mr-2.5" />
                    <input type="text" placeholder="Client Name" value={customerName} onChange={e => setCustomerName(e.target.value)} className="bg-transparent border-none focus:ring-0 text-brand-900 dark:text-white font-bold text-[10px] flex-1 h-full" />
                  </div>
                  <div className="flex items-center bg-white dark:bg-brand-900 border border-slate-200 dark:border-brand-800 rounded-xl px-3 h-10">
                    <Phone size={13} className="text-blue-500 mr-2.5" />
                    <input
                      type="text"
                      placeholder="Client Phone"
                      value={customerPhone}
                      onChange={e => {
                        const nextPhone = e.target.value;
                        setCustomerPhone(nextPhone);
                        const detectedDialCode = detectPhoneDialCode(nextPhone);
                        if (detectedDialCode) {
                          const isKnownPreset = customerPhonePopularPresets.some(option => option.dialCode === detectedDialCode);
                          setCustomerPhoneIntlEnabled(detectedDialCode !== DEFAULT_PHONE_DIAL_CODE);
                          if (isKnownPreset) {
                            setCustomerPhoneUseCustomDialCode(false);
                            setCustomerPhoneDialCode(detectedDialCode);
                          } else {
                            setCustomerPhoneUseCustomDialCode(true);
                            setCustomerPhoneCustomDialCode(detectedDialCode);
                          }
                        }
                      }}
                      className="bg-transparent border-none focus:ring-0 text-brand-900 dark:text-white font-bold text-[10px] flex-1 h-full"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setCustomerPhoneIntlEnabled(prev => !prev)}
                      className={`h-8 rounded-lg border text-[8px] font-black uppercase tracking-widest transition-colors ${customerPhoneIntlEnabled ? 'border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10' : 'border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10'}`}
                    >
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
                      <div className="h-8 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-2 flex items-center text-[8px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">
                        Default +961
                      </div>
                    )}
                  </div>
                  {customerPhoneIntlEnabled && customerPhoneUseCustomDialCode && (
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
                      className="w-full border border-slate-200 dark:border-brand-800 rounded-xl p-3 h-11 bg-slate-50 dark:bg-brand-950 font-bold"
                      placeholder="Other country code (e.g. 1, 61)"
                      aria-label="Custom country code"
                    />
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
                    className="h-8 rounded-lg border border-slate-300 dark:border-violet-700/40 bg-slate-50 dark:bg-violet-900/10 text-[8px] font-black uppercase tracking-widest text-violet-700 dark:text-violet-300"
                  >
                    ★ Mark VIP
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSetCustomerPriority('VVIP')}
                    className="h-8 rounded-lg border border-amber-300 dark:border-pink-700/40 bg-amber-50 dark:bg-pink-900/10 text-[8px] font-black uppercase tracking-widest text-pink-700 dark:text-pink-300"
                  >
                    ★★ Mark VVIP
                  </button>
                </div>
                {frequentPlaceSuggestions.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[8px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300 px-1">Frequent Place Suggestions</p>
                    <div className="space-y-2 max-h-32 overflow-auto pr-1">
                      {frequentPlaceSuggestions.slice(0, 8).map((location, index) => (
                        <div key={`${location.address}-${location.mapsLink || ''}-${index}`} className="rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-[10px] font-bold text-brand-900 dark:text-white truncate">{location.address}</p>
                            <span className="text-[7px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300">
                              {(location.label || 'Frequent').toUpperCase()}
                            </span>
                          </div>
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => applyFrequentPlaceToRoute('pickup', location)}
                              className="h-7 px-2 rounded-lg border border-gold-500/30 bg-gold-500/10 text-[8px] font-black uppercase tracking-widest text-gold-700 dark:text-gold-400"
                            >
                              Set Pickup
                            </button>
                            <button
                              type="button"
                              onClick={() => applyFrequentPlaceToRoute('dest', location)}
                              className="h-7 px-2 rounded-lg border border-blue-500/30 bg-blue-500/10 text-[8px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300"
                            >
                              Set Dropoff
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {quoteDirectoryCustomer && quoteCustomerSnapshot && (
                  <CustomerSnapshotCard snapshot={quoteCustomerSnapshot} />
                )}

                {shouldShowQuickMarkers && (
                  <div className="rounded-2xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 p-3 space-y-2">
                    <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Quick Operator Markers</p>
                    <p className="text-[9px] font-bold text-slate-500 dark:text-slate-300">New customer detected. Tag quickly for indexing.</p>
                    <div className="flex flex-wrap gap-1.5">
                      {operatorIndexMarkers.map(marker => {
                        const active = hasOperatorMarker(marker);
                        return (
                          <button
                            key={marker}
                            type="button"
                            onClick={() => toggleOperatorMarker(marker)}
                            className={`h-7 px-2.5 rounded-lg border text-[8px] font-black uppercase tracking-widest ${active
                              ? 'bg-brand-900 text-gold-400 border-brand-900 dark:bg-gold-600 dark:text-brand-950 dark:border-gold-600'
                              : 'bg-slate-50 dark:bg-brand-950 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-brand-700'}`}
                          >
                            {marker}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
           </div>

           {result ? (
              <div className="bg-brand-900 rounded-2xl shadow-2xl p-5 border-t-4 border-gold-600 animate-fade-in relative overflow-visible">
                 <div className="flex justify-between items-start mb-6">
                    <div>
                       <div className="flex items-baseline space-x-1 text-white">
                          <span className="text-gold-400 font-black text-lg">$</span>
                          <span className="text-4xl font-black tracking-tighter">{fareUsd}</span>
                       </div>
                       <p className="text-[9px] font-black text-gold-600 uppercase tracking-widest mt-1">~{fareLbp.toLocaleString()} LBP Total</p>
                    </div>
                    <div className="text-right space-y-1.5 min-w-[132px]">
                       <button
                         onClick={handleQuickCopyQuote}
                         aria-label={quickCopied ? 'Quote copied' : 'Copy quote'}
                         title={quickCopied ? 'Quote copied' : 'Copy quote'}
                         className={`w-full h-7 flex items-center justify-center gap-1.5 text-[8px] font-black uppercase tracking-widest px-2 rounded-lg border transition-all ${quickCopied ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-brand-950 text-slate-400 border-brand-800 hover:text-white'}`}
                       >
                         {quickCopied ? <Check size={10} /> : <Copy size={10} />}
                         <span>{quickCopied ? 'Done' : 'Copy'}</span>
                       </button>
                       <button
                         onClick={handleQuickWhatsAppQuote}
                         aria-label="Send quote to customer on WhatsApp"
                         title="Customer WhatsApp"
                         className="w-full h-7 flex items-center justify-center gap-1.5 text-[8px] font-black uppercase tracking-widest px-2 rounded-lg border transition-all bg-brand-950 text-emerald-400 border-brand-800 hover:text-emerald-300"
                       >
                         <LinkIcon size={10} />
                         <span className="hidden sm:inline">Customer WA</span>
                         <span className="sm:hidden">Cust WA</span>
                       </button>
                       <button
                         onClick={handleQuickOperatorWhatsAppQuote}
                         aria-label="Send quote to operator on WhatsApp"
                         title="Operator WhatsApp"
                         disabled={!settings.operatorWhatsApp.trim()}
                         className="w-full h-7 flex items-center justify-center gap-1.5 text-[8px] font-black uppercase tracking-widest px-2 rounded-lg border transition-all bg-brand-950 text-blue-400 border-brand-800 hover:text-blue-300 disabled:opacity-40 disabled:cursor-not-allowed"
                       >
                         <MessageCircle size={10} />
                         <span>Op WA</span>
                       </button>
                       <span className="w-full h-7 inline-flex items-center justify-center gap-1 text-[8px] font-black text-slate-400 uppercase tracking-widest bg-brand-950 px-2 rounded-lg border border-brand-800">
                         <Clock size={10} />
                         <span>{result.durationInTrafficText} ETA</span>
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
                       <span className="text-[8px] font-black uppercase tracking-widest text-slate-400">Traffic Index</span>
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
                 <div className="py-5 border-b border-brand-800">
                    <label className="text-[8px] font-black text-slate-500 uppercase tracking-widest block mb-3 px-1">Passenger Requirements</label>
                    <div className="flex flex-wrap gap-1.5">
                       {SPECIAL_REQUIREMENTS.map(req => (
                         <button 
                           key={req.id} 
                           onClick={() => toggleRequirement(req.id)}
                           className={`px-2.5 py-1.5 rounded-lg text-[8px] font-black uppercase tracking-tight transition-all border ${selectedRequirements.includes(req.id) ? 'bg-gold-600 border-gold-600 text-brand-900 shadow-lg shadow-gold-600/10' : 'bg-brand-950 border-brand-800 text-slate-500 hover:border-slate-600'}`}
                         >
                           {req.short}
                         </button>
                       ))}
                    </div>
                 </div>

                 <div className="pt-5 space-y-4">
                    <div className="rounded-xl border border-brand-800 bg-brand-950 px-3 py-2">
                      <p className="text-[8px] font-black uppercase tracking-widest text-slate-400">Customer Source</p>
                      <p className="text-[10px] font-black text-white mt-1 uppercase tracking-tight">{customerName || 'Walk-in Client'}</p>
                      <p className="text-[9px] font-bold text-slate-400 mt-0.5">{customerPhone || 'N/A'}</p>
                    </div>

                    <div className="grid grid-cols-1 gap-2">
                      <div className="flex items-center bg-brand-950 border border-brand-800 rounded-xl px-3 h-11">
                        <Car size={14} className="text-emerald-500 mr-3" />
                        <select
                          value={selectedDriverId}
                          onChange={e => setSelectedDriverId(e.target.value)}
                          className="bg-transparent border-none focus:ring-0 text-white font-bold text-xs flex-1 h-full"
                        >
                          <option value="">Assign Driver (Optional)</option>
                          {activeDrivers.map(driver => (
                            <option key={driver.id} value={driver.id}>{driver.name} ({driver.plateNumber}) [{driver.currentStatus}]</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-start bg-brand-950 border border-brand-800 rounded-xl px-3 py-2 min-h-20">
                        <FileText size={14} className="text-slate-500 mr-3 mt-1" />
                        <textarea placeholder="Specific notes..." value={notes} onChange={e => setNotes(e.target.value)} className="bg-transparent border-none focus:ring-0 text-white font-bold text-xs flex-1 h-full resize-none" />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => upsertCustomerLocation('HOME', {
                          address: result?.pickupAddress,
                          mapsLink: pickupOriginalLink,
                          lat: typeof pickupPlace?.geometry?.location?.lat === 'function' ? pickupPlace.geometry.location.lat() : pickupPlace?.geometry?.location?.lat,
                          lng: typeof pickupPlace?.geometry?.location?.lng === 'function' ? pickupPlace.geometry.location.lng() : pickupPlace?.geometry?.location?.lng,
                        })}
                        className="h-10 rounded-xl border border-blue-300 dark:border-blue-900/40 bg-blue-50 dark:bg-blue-900/10 text-[9px] font-black uppercase tracking-widest text-blue-700 dark:text-blue-300"
                      >
                        Pickup → Home
                      </button>
                      <button
                        type="button"
                        onClick={() => upsertCustomerLocation('SMART_PICKUP', {
                          address: result?.pickupAddress,
                          mapsLink: pickupOriginalLink,
                          lat: typeof pickupPlace?.geometry?.location?.lat === 'function' ? pickupPlace.geometry.location.lat() : pickupPlace?.geometry?.location?.lat,
                          lng: typeof pickupPlace?.geometry?.location?.lng === 'function' ? pickupPlace.geometry.location.lng() : pickupPlace?.geometry?.location?.lng,
                        })}
                        className="h-10 rounded-xl border border-cyan-300 dark:border-cyan-900/40 bg-cyan-50 dark:bg-cyan-900/10 text-[9px] font-black uppercase tracking-widest text-cyan-700 dark:text-cyan-300"
                      >
                        Pickup Smart
                      </button>
                      <button
                        type="button"
                        onClick={() => upsertCustomerLocation('BUSINESS', {
                          address: result?.destinationAddress,
                          mapsLink: destinationOriginalLink,
                          lat: typeof destPlace?.geometry?.location?.lat === 'function' ? destPlace.geometry.location.lat() : destPlace?.geometry?.location?.lat,
                          lng: typeof destPlace?.geometry?.location?.lng === 'function' ? destPlace.geometry.location.lng() : destPlace?.geometry?.location?.lng,
                        })}
                        className="h-10 rounded-xl border border-amber-300 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 text-[9px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-300"
                      >
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
                        className="h-10 rounded-xl border border-emerald-300 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[9px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300"
                      >
                        Dropoff + Frequent
                      </button>
                    </div>

                    <Button onClick={handleSaveTrip} className="w-full h-12 shadow-xl" variant={tripSaved ? 'secondary' : 'gold'}>
                      {tripSaved ? 'Committed to Log' : 'Save Dispatch'}
                    </Button>
                 </div>
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

      <div className="relative bg-slate-200 dark:bg-brand-950 h-[45vh] min-h-[300px] lg:h-auto lg:min-h-0 lg:flex-1">
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

      {lastSavedTrip && (
        <MessageModal 
          isOpen={showMessageModal}
          onClose={() => setShowMessageModal(false)}
          title="Send Trip Confirmation"
          initialMessage={replacePlaceholders(settings.templates.trip_confirmation, lastSavedTrip, drivers)}
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
