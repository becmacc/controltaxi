
import { format, parseISO } from 'date-fns';
import { Trip, Driver } from '../types';
import { SPECIAL_REQUIREMENTS } from '../constants';

const isCoordinateLike = (value?: string): boolean => {
  if (!value) return false;
  const text = value.trim();
  return /^-?\d{1,3}(?:\.\d+)?\s*,\s*-?\d{1,3}(?:\.\d+)?$/.test(text);
};

const cleanAddressLine = (value?: string): string => {
  if (!value) return '';
  const text = value.trim();
  if (!text || isCoordinateLike(text)) return '';
  return text;
};

const toGoogleMapsLink = (addressText?: string, lat?: number, lng?: number, directLink?: string): string => {
  if (directLink && /^https?:\/\//i.test(directLink)) {
    return directLink;
  }

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return `https://www.google.com/maps?q=${lat},${lng}`;
  }

  if (addressText && addressText.trim()) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressText.trim())}`;
  }

  return '';
};

const formatLocationText = (addressText?: string, lat?: number, lng?: number, directLink?: string, fallbackLabel = 'Location'): string => {
  const readableAddress = cleanAddressLine(addressText);
  const mapLink = toGoogleMapsLink(addressText, lat, lng, directLink);

  if (readableAddress && mapLink) {
    return `${readableAddress}\nMap: ${mapLink}`;
  }

  if (readableAddress) {
    return readableAddress;
  }

  if (mapLink) {
    return `Google Maps: ${mapLink}`;
  }

  return fallbackLabel;
};

export const formatTripPickup = (trip: Trip): string => {
  return formatLocationText(trip.pickupText, trip.pickupLat, trip.pickupLng, trip.pickupOriginalLink, 'Pickup Location');
};

export const formatTripStops = (trip: Trip): string => {
  const stops = (trip.stops || [])
    .map(stop => formatLocationText(stop.text, stop.lat, stop.lng, stop.originalLink, 'Stop'))
    .filter(Boolean);

  if (stops.length === 0) return '';

  return stops.map((stopText, index) => `${index + 1}. ${stopText}`).join('\n');
};

export const formatTripDestination = (trip: Trip): string => {
  const destination = formatLocationText(trip.destinationText, trip.destLat, trip.destLng, trip.destinationOriginalLink, 'Destination');
  const stopsText = formatTripStops(trip);
  if (!stopsText) return destination;
  return `${destination}\nStops:\n${stopsText}`;
};

export const replacePlaceholders = (template: string, trip: Trip, drivers: Driver[]): string => {
  const driver = drivers.find(d => d.id === trip.driverId);

  const driverName = driver ? driver.name : 'our driver';
  const driverNameWithPlate = driver ? `${driver.name} (${driver.plateNumber})` : 'Driver TBD';
  
  const tripDate = trip.tripDate ? parseISO(trip.tripDate) : parseISO(trip.createdAt);
  const formattedDate = format(tripDate, "d MMM, h:mm a");

  // Format Requirements string
  const reqLabels = (trip.specialRequirements || [])
    .map(id => SPECIAL_REQUIREMENTS.find(r => r.id === id)?.label)
    .filter(Boolean);
  
  const requirementsText = reqLabels.length > 0 
    ? `Requirements: ${reqLabels.join(', ')}` 
    : '';
  const stopsText = formatTripStops(trip);
  const stopsBlock = stopsText ? `Stops: ${stopsText.replace(/\n/g, ' | ')}` : '';
  
  const notesText = trip.notes ? `Notes: ${trip.notes}` : '';
  
  // Combine for a clean block
  const detailsBlock = [requirementsText, stopsBlock, notesText].filter(Boolean).join('. ');

  const replacements: Record<string, string> = {
    '{customer_name}': trip.customerName || "Customer",
    '{customer_phone}': trip.customerPhone || "N/A",
    '{pickup}': formatTripPickup(trip),
    '{destination}': formatTripDestination(trip),
    '{trip_datetime_formatted}': formattedDate,
    '{eta_text}': trip.durationInTrafficText || trip.durationText || "TBD",
    '{fare_usd}': trip.fareUsd ? trip.fareUsd.toString() : "0",
    '{fare_lbp}': trip.fareLbp ? trip.fareLbp.toLocaleString() : "0",
    '{payment_mode}': trip.paymentMode || 'CASH',
    '{settlement_status}': trip.settlementStatus || 'PENDING',
    '{stops_text}': stopsText,
    '{driver_name}': driverName,
    '{driver_name_with_plate}': driverNameWithPlate,
    '{driver_plate}': driver?.plateNumber || 'TBD',
    '{requirements_text}': requirementsText,
    '{notes}': notesText,
    '{details_block}': detailsBlock
  };

  let result = template;
  Object.entries(replacements).forEach(([placeholder, value]) => {
    // Global replace for placeholders
    result = result.split(placeholder).join(value);
  });

  return result;
};
