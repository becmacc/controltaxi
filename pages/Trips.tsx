
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useStore } from '../context/StoreContext';
import { Trip, TripStatus, Driver, Customer, CustomerLocation, TripStop } from '../types';
import { useLocation } from 'react-router-dom';
import { format, isToday, isFuture, isPast, parseISO } from 'date-fns';
import { 
  Search, Phone, User, UserCheck, Star, MapPin, Navigation, Clock, X, Check,
  FileText, CheckCircle2, XCircle, Car, Calendar,
  Download, AlertTriangle, DollarSign, List as ListIcon, 
  MessageCircle, Send, Settings, MailCheck, HeartHandshake,
  LayoutGrid, MoreVertical, ExternalLink, ArrowRightLeft, UserX, ClipboardX, Trash2, Archive, ChevronDown, ChevronUp
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { MessageModal } from '../components/MessageModal';
import { CustomerSnapshotCard } from '../components/CustomerSnapshotCard';
import { MIN_RIDE_FARE_USD } from '../constants';
import { formatTripDestination, formatTripPickup, formatTripStops, replacePlaceholders } from '../services/placeholderService';
import { buildWhatsAppLink } from '../services/whatsapp';
import { buildCustomerSnapshotForTrip, CustomerSnapshot } from '../services/customerSnapshot';
import { customerPhoneKey } from '../services/customerProfile';
import { parseGoogleMapsLink, parseGpsOrLatLngInput } from '../services/locationParser';
import { loadGoogleMapsScript } from '../services/googleMapsLoader';
import { computeTrafficIndex } from '../services/trafficMetrics';

declare var google: any;

type ViewMode = 'TABLE' | 'CARD';
const OPERATOR_INDEX_MARKERS = ['NEW', 'CORP', 'AIRPORT', 'PRIORITY', 'FOLLOWUP', 'VIP', 'VVIP'] as const;

const extractIndexMarkers = (text?: string): string[] => {
  if (!text) return [];
  const matches = text.toUpperCase().match(/\[(NEW|CORP|AIRPORT|PRIORITY|FOLLOWUP|VIP|VVIP)\]/g) || [];
  return Array.from(new Set(matches.map(match => match.replace(/\[|\]/g, ''))));
};

export const TripsPage: React.FC = () => {
  const { trips, deletedTrips, drivers, customers, updateFullTrip, deleteCancelledTrip, restoreDeletedTrip, settings, addCustomers } = useStore();
  const location = useLocation();
  const [filterText, setFilterText] = useState('');
  const [timeFilter, setTimeFilter] = useState<'ALL' | 'TODAY' | 'UPCOMING' | 'PAST'>('ALL');
  const [viewMode, setViewMode] = useState<ViewMode>('TABLE');
  
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [copiedType, setCopiedType] = useState<string | null>(null);
  const [messagingContext, setMessagingContext] = useState<{ trip: Trip, type: 'FEEDBACK_REQ' | 'THANKS' } | null>(null);
  const [manifestState, setManifestState] = useState<'IDLE' | 'DONE' | 'ERROR'>('IDLE');
  const [manifestMessage, setManifestMessage] = useState('');
  const [whatsAppError, setWhatsAppError] = useState<string | null>(null);
  const [actionToast, setActionToast] = useState<{ tone: 'SUCCESS' | 'ERROR'; message: string } | null>(null);
  const [deletedTripsCollapsed, setDeletedTripsCollapsed] = useState(true);
  const [handledDeepLinkKey, setHandledDeepLinkKey] = useState<string>('');

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

  const filteredTrips = useMemo(() => {
    const lower = filterText.toLowerCase();
    return trips.filter(trip => {
      const matchesText = trip.customerName.toLowerCase().includes(lower) || 
                          trip.customerPhone.includes(filterText) || 
                          trip.pickupText.toLowerCase().includes(lower) || 
                          trip.destinationText.toLowerCase().includes(lower) ||
                          trip.notes.toLowerCase().includes(lower) ||
                          (trip.driverId && drivers.find(d => d.id === trip.driverId)?.name.toLowerCase().includes(lower));

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
  }, [trips, drivers, filterText, timeFilter]);

  const filteredDeletedTrips = useMemo(() => {
    const lower = filterText.toLowerCase();
    return deletedTrips.filter(record => {
      const trip = record.trip;
      const driverName = trip.driverId ? (drivers.find(d => d.id === trip.driverId)?.name || '') : '';
      const matchesText = trip.customerName.toLowerCase().includes(lower) ||
        trip.customerPhone.includes(filterText) ||
        trip.pickupText.toLowerCase().includes(lower) ||
        trip.destinationText.toLowerCase().includes(lower) ||
        trip.notes.toLowerCase().includes(lower) ||
        record.deletedReason.toLowerCase().includes(lower) ||
        driverName.toLowerCase().includes(lower);

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
  }, [deletedTrips, drivers, filterText, timeFilter]);

  const activeDrivers = useMemo(
    () => drivers.filter(d => d.status === 'ACTIVE'),
    [drivers]
  );

  const selectedTripSnapshot = useMemo(() => {
    if (!selectedTrip) return null;
    return buildCustomerSnapshotForTrip(selectedTrip, customers, trips, drivers);
  }, [selectedTrip, customers, trips, drivers]);

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

  const handleApplyRequote = (updatedTrip: Trip) => {
    updateFullTrip(updatedTrip);
    setSelectedTrip(updatedTrip);
  };

  const messagingSnapshot = useMemo(() => {
    if (!messagingContext?.trip) return null;
    return buildCustomerSnapshotForTrip(messagingContext.trip, customers, trips, drivers);
  }, [messagingContext, customers, trips, drivers]);

  const statusConfig = {
    [TripStatus.QUOTED]: { icon: FileText, label: 'Quoted', className: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-brand-900/50 dark:text-slate-400 dark:border-brand-800' },
    [TripStatus.CONFIRMED]: { icon: Clock, label: 'Confirmed', className: 'bg-blue-50 text-blue-600 border-blue-100 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800/50' },
    [TripStatus.COMPLETED]: { icon: CheckCircle2, label: 'Success', className: 'bg-emerald-50 text-emerald-600 border-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800/50' },
    [TripStatus.CANCELLED]: { icon: XCircle, label: 'Cancelled', className: 'bg-red-50 text-red-600 border-red-100 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800/50' },
  };

  const copyToClipboard = (text: string, type: string, id: number) => {
    navigator.clipboard.writeText(text);
    setCopiedType(`${type}-${id}`);
    setTimeout(() => setCopiedType(null), 2000);
  };

  const openWhatsAppMessage = (phone: string | undefined, text: string) => {
    const link = buildWhatsAppLink(phone || '', text);
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
          trip.durationInTrafficMin ?? trip.durationMin,
          trip.trafficIndex ?? 0,
          trip.surplusMin ?? 0,
          trip.fareUsd,
          trip.fareLbp,
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
          trip.durationInTrafficMin ?? trip.durationMin,
          trip.trafficIndex ?? 0,
          trip.surplusMin ?? 0,
          trip.fareUsd,
          trip.fareLbp,
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
    return `🚕 *MISSION ASSIGNED*\n📅 Time: ${date}\n👤 Client: ${trip.customerName}\n📞 Call: ${trip.customerPhone}\n\n📍 *Pickup:* ${formatTripPickup(trip)}\n🏁 *Drop-off:* ${formatTripDestination(trip)}\n\n📝 Notes: ${trip.notes || 'Standard pickup'}`;
  };

  const getCustomerTemplate = (trip: Trip) => {
    const driver = drivers.find(d => d.id === trip.driverId);
    const date = trip.tripDate ? format(parseISO(trip.tripDate), "d MMM, h:mm a") : format(parseISO(trip.createdAt), "d MMM, h:mm a");
    const driverInfo = driver ? `\n🚖 Driver: ${driver.name}` : '';
    return `🚕 *RIDE CONFIRMED*\n📅 Date: ${date}\n📍 From: ${formatTripPickup(trip)}\n🏁 To: ${formatTripDestination(trip)}\n💰 Fare: $${trip.fareUsd}${driverInfo}`;
  };

  const getTripExtractTemplate = (trip: Trip) => {
    const driver = drivers.find(d => d.id === trip.driverId);
    const date = trip.tripDate ? format(parseISO(trip.tripDate), "d MMM, h:mm a") : format(parseISO(trip.createdAt), "d MMM, h:mm a");
    return [
      `🚕 *MISSION EXTRACT*`,
      `🆔 #${trip.id.toString().slice(-4)} · *${statusConfig[trip.status].label.toUpperCase()}*`,
      `📅 ${date}`,
      `👤 ${trip.customerName} (${trip.customerPhone})`,
      `🚖 ${driver?.name || 'Unassigned'}`,
      `📍 ${formatTripPickup(trip)}`,
      `🏁 ${formatTripDestination(trip)}`,
      `💰 $${trip.fareUsd}`,
      `📝 ${trip.notes || '—'}`
    ].join('\n');
  };

  const openModal = (trip: Trip) => { setSelectedTrip(trip); setIsModalOpen(true); };

  const handleCommitPhase = (updatedTrip: Trip) => {
    if (!selectedTrip) return;
    const wasCompleted = selectedTrip.status !== TripStatus.COMPLETED && updatedTrip.status === TripStatus.COMPLETED;
    const feedbackJustReceived = selectedTrip.rating === undefined && updatedTrip.rating !== undefined;

    updateFullTrip(updatedTrip);
    setIsModalOpen(false);

    if (wasCompleted) {
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
    if (target === 'SMART_PICKUP') {
      return shouldSetHomeOnSmart ? 'Pickup added to Frequent and set as Home.' : 'Pickup added to Frequent (Home kept).';
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
             </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
            <div className="relative flex-1 lg:w-64">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input type="text" placeholder="Search vectors..." className="w-full bg-white dark:bg-brand-900 border border-slate-200 dark:border-brand-800 rounded-xl h-10 pl-9 text-[10px] font-bold uppercase tracking-widest" value={filterText} onChange={e => setFilterText(e.target.value)} />
            </div>
            <div className="relative">
              <Calendar size={12} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <select value={timeFilter} onChange={e => setTimeFilter(e.target.value as any)} className="appearance-none bg-white dark:bg-brand-900 border border-slate-200 dark:border-brand-800 rounded-xl h-10 pl-8 pr-8 text-[9px] font-black uppercase tracking-widest outline-none">
                <option value="ALL">Historical</option>
                <option value="TODAY">Immediate</option>
                <option value="UPCOMING">Forecast</option>
                <option value="PAST">Archived</option>
              </select>
              <ChevronDown size={12} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
            </div>
            <Button variant="outline" className="h-10 text-[9px] font-black" onClick={() => handleManifestDownload('FILTERED')}><Download size={14} className="mr-2" /> Manifest</Button>
            <Button variant="outline" className="h-10 text-[9px] font-black" onClick={() => handleManifestDownload('ALL')}><Download size={14} className="mr-2" /> Manifest (All)</Button>
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
        {filteredTrips.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 bg-white dark:bg-brand-900 rounded-[3rem] border border-slate-200 dark:border-brand-800 shadow-sm animate-in fade-in duration-500">
             <div className="w-24 h-24 bg-slate-50 dark:bg-brand-950 rounded-full flex items-center justify-center mb-6">
                <ClipboardX size={48} className="text-slate-300 dark:text-brand-800" />
             </div>
             <h3 className="text-xl font-black text-brand-900 dark:text-white uppercase tracking-tight">No Missions Identified</h3>
             <p className="text-[10px] font-black uppercase text-slate-400 tracking-[0.3em] mt-2">Adjust search filters or criteria</p>
             <Button variant="outline" className="mt-8 h-10 text-[9px]" onClick={() => {setFilterText(''); setTimeFilter('ALL');}}>Reset Filter Archive</Button>
          </div>
        )}

        {/* Responsive Table/Card Engine */}
        {filteredTrips.length > 0 && viewMode === 'TABLE' ? (
          <div className="hidden md:block bg-white dark:bg-brand-900 rounded-[2rem] border border-slate-200 dark:border-brand-800 shadow-xl overflow-x-auto">
            <table className="w-full min-w-[1160px] text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 dark:bg-brand-950/50 border-b border-slate-100 dark:border-brand-800">
                  <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">ID / Phase</th>
                  <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">Scheduled</th>
                  <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">Client</th>
                  <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">Vector</th>
                  <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">Metrics</th>
                  <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">Traffic Delay</th>
                  <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">Unit</th>
                  <th className="px-4 py-3 text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">Comms Audit</th>
                  <th className="sticky right-0 z-20 px-4 py-3 text-right text-[9px] font-black text-slate-400 uppercase tracking-[0.2em] bg-slate-50 dark:bg-brand-950/50 border-l border-slate-100 dark:border-brand-800">Command</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-brand-800/50">
                {filteredTrips.map(trip => {
                  const driver = drivers.find(d => d.id === trip.driverId);
                  const tripDate = parseISO(trip.tripDate || trip.createdAt);
                  const indexMarkers = getTripIndexMarkers(trip);
                  const stopPreview = getTripStopPreview(trip);
                  const traffic = describeTraffic(trip.trafficIndex);
                  return (
                    <tr key={trip.id} className="hover:bg-slate-50/50 dark:hover:bg-brand-800/20 transition-colors group">
                      <td className="px-4 py-4">
                         <div className="flex items-center space-x-3">
                            <div className="flex items-center space-x-1">
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
                            <span className="text-[10px] font-black text-slate-300 tracking-widest">#{trip.id.toString().slice(-4)}</span>
                         </div>
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap">
                         <div className="text-[10px] font-black text-brand-900 dark:text-white uppercase">{format(tripDate, 'MMM d')}</div>
                         <div className="text-[10px] font-bold text-slate-400 mt-0.5">{format(tripDate, 'h:mm a')}</div>
                      </td>
                      <td className="px-4 py-4">
                         <div className="text-[11px] font-black text-brand-900 dark:text-white uppercase leading-none">{trip.customerName}</div>
                         <div className="text-[10px] font-bold text-slate-400 mt-1">{trip.customerPhone}</div>
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
                      <td className="px-4 py-4 max-w-[170px]">
                         <div className="flex items-center text-[10px] font-bold text-slate-600 dark:text-slate-300">
                            <MapPin size={10} className="text-gold-600 mr-2 flex-shrink-0" />
                            <span className="truncate">{trip.pickupText.split(',')[0]}</span>
                         </div>
                         <div className="flex items-center text-[10px] font-bold text-slate-400 mt-1.5 ml-3">
                            <Navigation size={10} className="text-blue-500 mr-2 flex-shrink-0" />
                            <span className="truncate">{trip.destinationText.split(',')[0]}</span>
                         </div>
                         {(trip.stops?.length || 0) > 0 && (
                          <div className="mt-1.5 ml-3 space-y-0.5">
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
                      </td>
                      <td className="px-4 py-4">
                         <div className="text-[11px] font-black text-brand-900 dark:text-white">${trip.fareUsd}</div>
                         <div className="text-[9px] font-bold text-slate-400 mt-0.5 uppercase tracking-tighter">{trip.distanceText}</div>
                         <div className="text-[8px] font-black text-slate-500 dark:text-slate-300 mt-1 uppercase tracking-widest">ETA {trip.durationInTrafficText || trip.durationText}</div>
                         <div className={`text-[8px] font-black mt-0.5 uppercase tracking-widest ${traffic.tone}`}>{traffic.label} · TI {Number.isFinite(trip.trafficIndex) ? trip.trafficIndex : 0}</div>
                      </td>
                       <td className="px-4 py-4">
                         <div className="text-[11px] font-black text-brand-900 dark:text-white">+{Number.isFinite(trip.surplusMin) ? trip.surplusMin : 0}m</div>
                         <div className="text-[8px] font-black text-slate-500 dark:text-slate-300 mt-1 uppercase tracking-widest">Traffic Surplus</div>
                       </td>
                      <td className="px-4 py-4">
                         <div className={`text-[10px] font-black uppercase tracking-widest ${!driver ? 'text-amber-500' : 'text-slate-900 dark:text-slate-300'}`}>
                            {driver?.name.split(' ')[0] || 'Unassigned'}
                         </div>
                      </td>
                      <td className="px-4 py-4">
                         <div className="flex items-center space-x-3">
                            <MailCheck size={14} className={trip.confirmation_sent_at ? 'text-emerald-500' : 'text-slate-200 dark:text-brand-800'} />
                            <MessageCircle size={14} className={trip.feedback_request_sent_at ? 'text-blue-500' : 'text-slate-200 dark:text-brand-800'} />
                            <HeartHandshake size={14} className={trip.thank_you_sent_at ? 'text-gold-500' : 'text-slate-200 dark:text-brand-800'} />
                         </div>
                      </td>
                       <td className="sticky right-0 z-10 px-4 py-4 text-right bg-white dark:bg-brand-900 group-hover:bg-slate-50/50 dark:group-hover:bg-brand-800/20 border-l border-slate-100 dark:border-brand-800">
                         <div className="flex items-center justify-end space-x-1">
                            <button onClick={() => copyToClipboard(getDriverTemplate(trip), 'driver', trip.id)} className={`p-2 rounded-lg transition-all ${copiedType === `driver-${trip.id}` ? 'bg-emerald-500 text-white' : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-brand-800'}`}>
                               {copiedType === `driver-${trip.id}` ? <Check size={14}/> : <Car size={14}/>}
                            </button>
                            <button
                              onClick={() => openModal(trip)}
                              className={`h-8 px-3 rounded-lg border text-[9px] font-black uppercase tracking-widest transition-all inline-flex items-center gap-1.5 ${!driver
                                ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-700/40'
                                : 'bg-slate-50 text-brand-900 border-slate-200 dark:bg-brand-950 dark:text-gold-500 dark:border-brand-800'}`}
                              title={!driver ? 'Assign Driver / Edit Trip' : 'Edit Trip'}
                            >
                              <Settings size={12}/>
                              {!driver ? 'Assign / Edit' : 'Edit'}
                            </button>
                         </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {/* Card View (Always on Mobile, Toggleable on Desktop) */}
        {filteredTrips.length > 0 && (viewMode === 'CARD' || viewMode === 'TABLE') && (
          <div className={`${viewMode === 'TABLE' ? 'md:hidden' : ''} grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pb-4 md:pb-20`}>
            {filteredTrips.map(trip => {
              const tripDate = parseISO(trip.tripDate || trip.createdAt);
              const driver = drivers.find(d => d.id === trip.driverId);
              const indexMarkers = getTripIndexMarkers(trip);
              const stopPreview = getTripStopPreview(trip);
              const traffic = describeTraffic(trip.trafficIndex);
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
                     <div className="text-right">
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">{format(tripDate, 'MMM d')}</p>
                        <p className="text-xs font-black text-brand-900 dark:text-gold-400">{format(tripDate, 'h:mm a')}</p>
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
                           <p className="text-xs font-black text-brand-900 dark:text-white uppercase truncate max-w-[150px]">{trip.customerName}</p>
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
                          <p className="text-[8px] font-black text-slate-500 dark:text-slate-300 uppercase tracking-widest">ETA {trip.durationInTrafficText || trip.durationText}</p>
                          <p className={`text-[8px] font-black uppercase tracking-widest ${traffic.tone}`}>{traffic.label} · TI {Number.isFinite(trip.trafficIndex) ? trip.trafficIndex : 0}</p>
                           <p className={`text-xs font-black uppercase ${!driver ? 'text-amber-500 animate-pulse' : 'text-slate-900 dark:text-slate-300'}`}>{driver?.name.split(' ')[0] || 'Awaiting'}</p>
                        </div>
                     </div>
                  </div>

                  <div className="flex justify-between items-center pt-6 border-t border-slate-50 dark:border-brand-800">
                     <div className="flex items-center space-x-2 text-brand-900 dark:text-white">
                        <span className="text-[10px] font-black">$</span>
                        <span className="text-lg font-black tracking-tighter">{trip.fareUsd}</span>
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

      {isModalOpen && selectedTrip && (
         <TripUpdateModal 
            trip={selectedTrip} 
            drivers={activeDrivers} 
            onClose={() => setIsModalOpen(false)}
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
          initialMessage={replacePlaceholders(
            messagingContext.type === 'FEEDBACK_REQ' ? settings.templates.feedback_request : settings.templates.feedback_thanks,
            messagingContext.trip,
            drivers
          )}
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
}> = ({ trip, drivers, onClose, onSave, onCopy, onWhatsApp, customerPhone, operatorPhone, mapsApiKey, buildDriverTemplate, buildCustomerTemplate, buildOperatorTemplate, copiedType, customerSnapshot, onAssignLocation, onSetCustomerPriority, onRequoteDestination, onApplyRequote, onDeleteCancelled }) => {
  const [status, setStatus] = useState<TripStatus>(trip.status);
  const [driverId, setDriverId] = useState<string>(trip.driverId || '');
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
  const destinationAutocompleteRef = useRef<any>(null);
  const stopInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const stopAutocompleteRefs = useRef<any[]>([]);

  useEffect(() => {
    setStatus(trip.status);
    setDriverId(trip.driverId || '');
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

  useEffect(() => {
    if (!mapsApiKey.trim()) return;

    let disposed = false;

    const setupAutocomplete = async () => {
      try {
        await loadGoogleMapsScript(mapsApiKey);
        if (disposed || !destinationInputRef.current || !google?.maps?.places?.Autocomplete) {
          return;
        }

        if (destinationAutocompleteRef.current) {
          google.maps.event.clearInstanceListeners(destinationAutocompleteRef.current);
        }

        const autocomplete = new google.maps.places.Autocomplete(destinationInputRef.current, {
          componentRestrictions: { country: 'lb' },
          fields: ['place_id', 'geometry', 'formatted_address', 'name'],
          types: ['geocode'],
        });

        autocomplete.addListener('place_changed', () => {
          const place = autocomplete.getPlace();
          const nextValue = place?.formatted_address || place?.name;
          if (nextValue) {
            setDestinationDraft(nextValue);
          }

          const lat = Number(place?.geometry?.location?.lat?.() ?? place?.geometry?.location?.lat);
          const lng = Number(place?.geometry?.location?.lng?.() ?? place?.geometry?.location?.lng);
          if (Number.isFinite(lat) && Number.isFinite(lng) && nextValue) {
            setDestinationCandidate({
              text: nextValue,
              placeId: place?.place_id || 'GEOCODED_DESTINATION',
              lat,
              lng,
            });
          }
        });

        destinationAutocompleteRef.current = autocomplete;

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

          const stopAutocomplete = new google.maps.places.Autocomplete(input, {
            componentRestrictions: { country: 'lb' },
            fields: ['place_id', 'geometry', 'formatted_address', 'name'],
            types: ['geocode'],
          });

          stopAutocomplete.addListener('place_changed', () => {
            const place = stopAutocomplete.getPlace();
            const nextValue = place?.formatted_address || place?.name;
            if (!nextValue) return;
            setStopsDraft(prev => prev.map((entry, i) => (i === index ? nextValue : entry)));

            const latRaw = place?.geometry?.location?.lat;
            const lngRaw = place?.geometry?.location?.lng;
            const lat = typeof latRaw === 'function' ? Number(latRaw.call(place.geometry.location)) : Number(latRaw);
            const lng = typeof lngRaw === 'function' ? Number(lngRaw.call(place.geometry.location)) : Number(lngRaw);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

            const candidate: TripStop = {
              text: nextValue,
              placeId: place?.place_id || 'GEOCODED_STOP',
              lat,
              lng,
            };
            setStopCandidates(prev => prev.map((entry, i) => (i === index ? candidate : entry)));
          });

          stopAutocompleteRefs.current[index] = stopAutocomplete;
        });
      } catch {
      }
    };

    setupAutocomplete();

    return () => {
      disposed = true;
      if (destinationAutocompleteRef.current && google?.maps?.event?.clearInstanceListeners) {
        google.maps.event.clearInstanceListeners(destinationAutocompleteRef.current);
      }
      destinationAutocompleteRef.current = null;
      stopAutocompleteRefs.current.forEach(instance => {
        if (instance && google?.maps?.event?.clearInstanceListeners) {
          google.maps.event.clearInstanceListeners(instance);
        }
      });
      stopAutocompleteRefs.current = [];
    };
  }, [mapsApiKey, trip.id, stopsDraft.length]);

  const liveTrip: Trip = {
    ...trip,
    ...quotePatch,
    status,
    driverId: driverId || undefined,
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

          <div className="grid grid-cols-2 gap-4">
             <div><label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-2 px-1">Phase Status</label><select value={status} onChange={e => setStatus(e.target.value as TripStatus)} className="w-full border border-slate-200 dark:border-brand-800 rounded-xl h-12 px-4 bg-slate-50 dark:bg-brand-950 text-[11px] font-black uppercase outline-none focus:ring-2 focus:ring-gold-500 transition-all">
                {Object.values(TripStatus).map(s => <option key={s} value={s}>{s}</option>)}
             </select></div>
             <div><label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-2 px-1">Active Unit</label><select value={driverId} onChange={e => setDriverId(e.target.value)} className="w-full border border-slate-200 dark:border-brand-800 rounded-xl h-12 px-4 bg-slate-50 dark:bg-brand-950 text-[11px] font-black uppercase outline-none focus:ring-2 focus:ring-gold-500 transition-all">
                <option value="">Unassigned</option>
                 {drivers.map(d => <option key={d.id} value={d.id}>{d.name} ({d.plateNumber}) [{d.currentStatus}]</option>)}
             </select></div>
          </div>

          <div className="pt-4 border-t border-slate-100 dark:border-brand-800 space-y-3">
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
              <button type="button" onClick={() => runAssignLocation('SMART_PICKUP', 'PICKUP')} className="h-10 rounded-xl border border-cyan-300 dark:border-cyan-900/40 bg-cyan-50 dark:bg-cyan-900/10 text-[9px] font-black uppercase tracking-widest text-cyan-700 dark:text-cyan-300">Pickup Smart</button>
              <button type="button" onClick={() => runAssignLocation('BUSINESS', 'DROPOFF')} className="h-10 rounded-xl border border-amber-300 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 text-[9px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-300">Dropoff → Business</button>
              <button type="button" onClick={() => runAssignLocation('FREQUENT', 'PICKUP')} className="h-10 rounded-xl border border-emerald-300 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[9px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300">Pickup + Frequent</button>
              <button type="button" onClick={() => runAssignLocation('FREQUENT', 'DROPOFF')} className="h-10 rounded-xl border border-emerald-300 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/10 text-[9px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300">Dropoff + Frequent</button>
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
