import { normalizePhoneForWhatsApp } from './whatsapp';

export interface ContactImportCandidate {
  name: string;
  phone: string;
  notes?: string;
  id?: string;
  source?: 'MANUAL' | 'SYNC' | 'OPERATIONAL';
  createdAt?: string;
  lastEnrichedAt?: string;
  isInternational?: boolean;
  marketSegments?: ('EXPAT' | 'TOURIST' | 'LOCAL_RESIDENT')[];
  gender?: 'MALE' | 'FEMALE' | 'UNSPECIFIED';
  entityType?: 'BUSINESS' | 'INDIVIDUAL' | 'UNSPECIFIED';
  profession?: string;
  homeLocation?: {
    label: string;
    address: string;
    mapsLink?: string;
    lat?: number;
    lng?: number;
  };
  businessLocation?: {
    label: string;
    address: string;
    mapsLink?: string;
    lat?: number;
    lng?: number;
  };
  frequentLocations?: {
    label: string;
    address: string;
    mapsLink?: string;
    lat?: number;
    lng?: number;
  }[];
  profileTimeline?: {
    id: string;
    timestamp: string;
    source: 'TRIP_NOTE' | 'IMPORT' | 'MANUAL' | 'SYNC';
    note: string;
    tripId?: number;
  }[];
}

export interface ContactImportReport {
  totalRows: number;
  valid: ContactImportCandidate[];
  rejected: number;
  errors: string[];
}

const splitCsvLine = (line: string): string[] => {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];

    if (char === '"') {
      const next = line[index + 1];
      if (inQuotes && next === '"') {
        current += '"';
        index++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
};

const cleanString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
};

const parseNumber = (value: unknown): number | undefined => {
  const raw = cleanString(value);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseLocationObject = (
  value: unknown,
  fallbackLabel: string,
): { label: string; address: string; mapsLink?: string; lat?: number; lng?: number } | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const address = cleanString(row.address ?? row.text ?? row.value);
  if (!address) return undefined;

  return {
    label: cleanString(row.label) || fallbackLabel,
    address,
    ...(cleanString(row.mapsLink ?? row.maps_link ?? row.url) ? { mapsLink: cleanString(row.mapsLink ?? row.maps_link ?? row.url) } : {}),
    ...(parseNumber(row.lat ?? row.latitude) !== undefined ? { lat: parseNumber(row.lat ?? row.latitude) } : {}),
    ...(parseNumber(row.lng ?? row.lon ?? row.long ?? row.longitude) !== undefined ? { lng: parseNumber(row.lng ?? row.lon ?? row.long ?? row.longitude) } : {}),
  };
};

const parseContactRow = (row: Record<string, unknown>, rowLabel: string): { contact?: ContactImportCandidate; error?: string } => {
  const rawName = cleanString(row.name ?? row.full_name ?? row.customer_name);
  const rawPhone = cleanString(row.phone ?? row.mobile ?? row.number ?? row.customer_phone);
  const notes = cleanString(row.notes ?? row.note ?? row.source);
  const rawSource = cleanString(row.source).toUpperCase();
  const source = ['MANUAL', 'SYNC', 'OPERATIONAL'].includes(rawSource)
    ? (rawSource as 'MANUAL' | 'SYNC' | 'OPERATIONAL')
    : undefined;
  const createdAt = cleanString(row.created_at ?? row.createdAt);
  const lastEnrichedAt = cleanString(row.last_enriched_at ?? row.lastEnrichedAt);
  const rawInternational = cleanString(row.is_international ?? row.isInternational).toLowerCase();
  const isInternational = rawInternational === 'true' || rawInternational === '1' || rawInternational === 'yes';
  const rawGender = cleanString(row.gender ?? row.sex).toUpperCase();
  const gender = rawGender === 'MALE' || rawGender === 'FEMALE' || rawGender === 'UNSPECIFIED'
    ? (rawGender as 'MALE' | 'FEMALE' | 'UNSPECIFIED')
    : undefined;
  const rawEntityType = cleanString(row.entity_type ?? row.entityType ?? row.classification).toUpperCase();
  const entityType = rawEntityType === 'BUSINESS' || rawEntityType === 'INDIVIDUAL' || rawEntityType === 'UNSPECIFIED'
    ? (rawEntityType as 'BUSINESS' | 'INDIVIDUAL' | 'UNSPECIFIED')
    : undefined;
  const profession = cleanString(row.profession ?? row.job_title ?? row.job ?? row.occupation);
  const homeAddress = cleanString(row.home_address ?? row.homeAddress);
  const homeMapsLink = cleanString(row.home_maps_link ?? row.homeMapsLink);
  const homeLat = parseNumber(row.home_lat ?? row.homeLat);
  const homeLng = parseNumber(row.home_lng ?? row.homeLng);
  const businessAddress = cleanString(row.business_address ?? row.businessAddress);
  const businessMapsLink = cleanString(row.business_maps_link ?? row.businessMapsLink);
  const businessLat = parseNumber(row.business_lat ?? row.businessLat);
  const businessLng = parseNumber(row.business_lng ?? row.businessLng);
  const importedId = cleanString(row.id);
  const rawSegments = cleanString(row.market_segments ?? row.marketSegments);
  const marketSegments = rawSegments
    ? rawSegments
        .split(/[|,]/)
        .map(entry => entry.trim().toUpperCase().replace(/\s+/g, '_'))
        .map(entry => {
          if (entry === 'LOCAL' || entry === 'RESIDENT' || entry === 'LOCALRESIDENT') return 'LOCAL_RESIDENT';
          return entry;
        })
        .filter(entry => entry === 'EXPAT' || entry === 'TOURIST' || entry === 'LOCAL_RESIDENT') as ('EXPAT' | 'TOURIST' | 'LOCAL_RESIDENT')[]
    : undefined;

  const homeLocation = parseLocationObject(row.home_location ?? row.homeLocation, 'Home')
    ?? (homeAddress
      ? {
          label: 'Home',
          address: homeAddress,
          ...(homeMapsLink ? { mapsLink: homeMapsLink } : {}),
          ...(homeLat !== undefined ? { lat: homeLat } : {}),
          ...(homeLng !== undefined ? { lng: homeLng } : {}),
        }
      : undefined);

  const businessLocation = parseLocationObject(row.business_location ?? row.businessLocation, 'Business')
    ?? (businessAddress
      ? {
          label: 'Business',
          address: businessAddress,
          ...(businessMapsLink ? { mapsLink: businessMapsLink } : {}),
          ...(businessLat !== undefined ? { lat: businessLat } : {}),
          ...(businessLng !== undefined ? { lng: businessLng } : {}),
        }
      : undefined);

  let frequentLocations = Array.isArray(row.frequent_locations) || Array.isArray(row.frequentLocations)
    ? ((row.frequent_locations ?? row.frequentLocations) as unknown[])
        .map((entry, index) => parseLocationObject(entry, `Place ${index + 1}`))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : undefined;

  if (!frequentLocations || frequentLocations.length === 0) {
    const rawFrequentJson = cleanString(row.frequent_locations_json ?? row.frequentLocationsJson);
    if (rawFrequentJson) {
      try {
        const parsedFrequent = JSON.parse(rawFrequentJson);
        if (Array.isArray(parsedFrequent)) {
          frequentLocations = parsedFrequent
            .map((entry, index) => parseLocationObject(entry, `Place ${index + 1}`))
            .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
        }
      } catch {
        // Ignore malformed frequent locations payload
      }
    }
  }

  let profileTimeline: ContactImportCandidate['profileTimeline'] | undefined;
  const rawTimeline = cleanString(row.profile_timeline_json ?? row.profileTimeline);
  if (rawTimeline) {
    try {
      const parsedTimeline = JSON.parse(rawTimeline);
      if (Array.isArray(parsedTimeline)) {
        profileTimeline = parsedTimeline
          .filter(item => item && typeof item === 'object')
          .map(item => {
            const entry = item as Record<string, unknown>;
            const note = cleanString(entry.note);
            if (!note) return null;

            const entrySourceRaw = cleanString(entry.source).toUpperCase();
            const entrySource = ['TRIP_NOTE', 'IMPORT', 'MANUAL', 'SYNC'].includes(entrySourceRaw)
              ? (entrySourceRaw as 'TRIP_NOTE' | 'IMPORT' | 'MANUAL' | 'SYNC')
              : 'IMPORT';
            const tripId = Number(entry.tripId);

            return {
              id: cleanString(entry.id) || `${Date.now()}-${Math.random()}`,
              timestamp: cleanString(entry.timestamp) || new Date().toISOString(),
              source: entrySource,
              note,
              ...(Number.isFinite(tripId) ? { tripId } : {}),
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      }
    } catch {
      // Ignore malformed timeline payloads and continue with base contact import
    }
  }

  if (!rawName) {
    return { error: `${rowLabel}: name is required.` };
  }

  const normalizedPhone = normalizePhoneForWhatsApp(rawPhone);
  if (!normalizedPhone) {
    return { error: `${rowLabel}: phone is invalid.` };
  }

  return {
    contact: {
      name: rawName,
      phone: normalizedPhone,
      ...(notes ? { notes } : {}),
      ...(importedId ? { id: importedId } : {}),
      ...(source ? { source } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(lastEnrichedAt ? { lastEnrichedAt } : {}),
      ...(rawInternational ? { isInternational } : {}),
      ...(marketSegments && marketSegments.length > 0 ? { marketSegments } : {}),
      ...(gender ? { gender } : {}),
      ...(entityType ? { entityType } : {}),
      ...(profession ? { profession } : {}),
      ...(homeLocation ? { homeLocation } : {}),
      ...(businessLocation ? { businessLocation } : {}),
      ...(frequentLocations && frequentLocations.length > 0 ? { frequentLocations } : {}),
      ...(profileTimeline && profileTimeline.length > 0 ? { profileTimeline } : {}),
    },
  };
};

const parseContactsFromJson = (text: string): ContactImportReport => {
  const errors: string[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return { totalRows: 0, valid: [], rejected: 0, errors: ['Invalid JSON file.'] };
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { contacts?: unknown[] }).contacts)
      ? (parsed as { contacts: unknown[] }).contacts
      : null);

  if (!rows) {
    return { totalRows: 0, valid: [], rejected: 0, errors: ['JSON must be an array of contacts or { contacts: [...] }.'] };
  }

  const valid: ContactImportCandidate[] = [];

  rows.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      errors.push(`Row ${index + 1}: invalid object.`);
      return;
    }

    const parsedRow = parseContactRow(entry as Record<string, unknown>, `Row ${index + 1}`);
    if (parsedRow.error) {
      errors.push(parsedRow.error);
      return;
    }

    valid.push(parsedRow.contact!);
  });

  return {
    totalRows: rows.length,
    valid,
    rejected: rows.length - valid.length,
    errors,
  };
};

const parseContactsFromCsv = (text: string): ContactImportReport => {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return { totalRows: 0, valid: [], rejected: 0, errors: ['CSV needs a header row and at least one data row.'] };
  }

  const headers = splitCsvLine(lines[0]).map(h => h.toLowerCase());
  const nameIndex = headers.findIndex(h => ['name', 'full_name', 'customer_name'].includes(h));
  const phoneIndex = headers.findIndex(h => ['phone', 'mobile', 'number', 'customer_phone'].includes(h));

  if (nameIndex === -1 || phoneIndex === -1) {
    return {
      totalRows: 0,
      valid: [],
      rejected: 0,
      errors: ['CSV header must include name and phone columns.'],
    };
  }

  const errors: string[] = [];
  const valid: ContactImportCandidate[] = [];

  lines.slice(1).forEach((line, index) => {
    const cols = splitCsvLine(line);
    const row: Record<string, unknown> = {};
    headers.forEach((header, headerIndex) => {
      row[header] = cols[headerIndex] ?? '';
    });
    row.name = cols[nameIndex];
    row.phone = cols[phoneIndex];

    const parsedRow = parseContactRow(row, `Row ${index + 2}`);
    if (parsedRow.error) {
      errors.push(parsedRow.error);
      return;
    }

    valid.push(parsedRow.contact!);
  });

  const totalRows = lines.length - 1;

  return {
    totalRows,
    valid,
    rejected: totalRows - valid.length,
    errors,
  };
};

const parseContactsFromVcf = (text: string): ContactImportReport => {
  const blocks = text
    .split(/END:VCARD/i)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => `${block}\nEND:VCARD`);

  if (blocks.length === 0) {
    return { totalRows: 0, valid: [], rejected: 0, errors: ['VCF file contains no contact cards.'] };
  }

  const valid: ContactImportCandidate[] = [];
  const errors: string[] = [];

  blocks.forEach((block, index) => {
    const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const nameLine = lines.find(line => /^FN(?::|;)/i.test(line)) || lines.find(line => /^N(?::|;)/i.test(line));
    const telLine = lines.find(line => /^TEL(?::|;)/i.test(line));
    const noteLine = lines.find(line => /^NOTE(?::|;)/i.test(line));

    const readValue = (line?: string): string => {
      if (!line) return '';
      const idx = line.indexOf(':');
      if (idx === -1) return '';
      return line.slice(idx + 1).trim();
    };

    const rawName = readValue(nameLine).replace(/;/g, ' ').trim();
    const rawPhone = readValue(telLine);
    const notes = readValue(noteLine);

    const parsedRow = parseContactRow({ name: rawName, phone: rawPhone, notes }, `Card ${index + 1}`);
    if (parsedRow.error) {
      errors.push(parsedRow.error);
      return;
    }

    valid.push(parsedRow.contact!);
  });

  return {
    totalRows: blocks.length,
    valid,
    rejected: blocks.length - valid.length,
    errors,
  };
};

export const parseContactsImport = (fileName: string, text: string): ContactImportReport => {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) return parseContactsFromCsv(text);
  if (lower.endsWith('.json')) return parseContactsFromJson(text);
  if (lower.endsWith('.vcf')) return parseContactsFromVcf(text);

  if (/BEGIN:VCARD/i.test(text)) return parseContactsFromVcf(text);

  try {
    return parseContactsFromJson(text);
  } catch {
    return parseContactsFromCsv(text);
  }
};
