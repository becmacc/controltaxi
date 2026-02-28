export interface ParsedLocation {
  lat: number;
  lng: number;
  originalUrl: string;
}

const toParsedLocation = (latRaw: string, lngRaw: string, original: string): ParsedLocation | null => {
  const lat = parseFloat(latRaw);
  const lng = parseFloat(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng, originalUrl: original };
};

const COORD_FRAGMENT = '(-?\\d{1,3}(?:\\.\\d+)?)';

export const parseGpsOrLatLngInput = (input: string): ParsedLocation | null => {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const prefixedMatch = trimmed.match(new RegExp(`^(?:geo:|gps:)?\\s*${COORD_FRAGMENT}\\s*[,;\\s/]\\s*${COORD_FRAGMENT}(?:\\s|$)`, 'i'));
  if (prefixedMatch) {
    const parsed = toParsedLocation(prefixedMatch[1], prefixedMatch[2], trimmed);
    if (parsed) {
      return {
        ...parsed,
        originalUrl: `https://www.google.com/maps?q=${parsed.lat},${parsed.lng}`,
      };
    }
  }

  return null;
};

/**
 * Parses a Google Maps URL to extract coordinates.
 * Supports:
 * - @lat,lng
 * - ?q=lat,lng
 * - search/lat,lng
 * - ?ll=lat,lng
 */
export const parseGoogleMapsLink = (url: string): ParsedLocation | null => {
  if (!url) return null;
  const trimmed = url.trim();

  // 1. @lat,lng
  // e.g. https://www.google.com/maps/@33.8938,35.5018,15z
  const atMatch = trimmed.match(/@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/);
  if (atMatch) {
    return toParsedLocation(atMatch[1], atMatch[2], trimmed);
  }

  // 2. q=lat,lng
  // e.g. https://maps.google.com/?q=33.8938,35.5018
  const qMatch = trimmed.match(/[?&]q=(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/);
  if (qMatch) {
    return toParsedLocation(qMatch[1], qMatch[2], trimmed);
  }
  
  // 3. search/lat,lng
  const searchMatch = trimmed.match(/search\/(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/);
  if (searchMatch) {
    return toParsedLocation(searchMatch[1], searchMatch[2], trimmed);
  }

  // 4. LL parameter (sometimes used)
  const llMatch = trimmed.match(/[?&]ll=(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/);
  if (llMatch) {
    return toParsedLocation(llMatch[1], llMatch[2], trimmed);
  }

  // Note: Short links (goo.gl, maps.app.goo.gl) generally require server-side 
  // HEAD requests to follow redirects, which isn't possible in a pure client-side
  // demo due to CORS. In a full production env, these would be sent to the API.

  return null;
};