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

const splitDelimitedLine = (line: string, delimiter: string): string[] => {
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

    if (char === delimiter && !inQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
};

const parseDelimitedRows = (text: string, delimiter: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === '"') {
      const next = text[index + 1];
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      row.push(cell.trim());
      cell = '';
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[index + 1] === '\n') {
        index += 1;
      }
      row.push(cell.trim());
      const hasContent = row.some(entry => entry.length > 0);
      if (hasContent) {
        rows.push(row);
      }
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    const hasContent = row.some(entry => entry.length > 0);
    if (hasContent) {
      rows.push(row);
    }
  }

  return rows;
};

const normalizeHeader = (header: string): string => {
  return header
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\-_]/g, ' ')
    .replace(/\s+/g, ' ');
};

const detectDelimiter = (headerLine: string): string => {
  const candidates = [',', ';', '\t', '|'];
  let bestDelimiter = ',';
  let bestScore = -1;

  candidates.forEach(candidate => {
    const fields = splitDelimitedLine(headerLine, candidate);
    const score = fields.length;
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = candidate;
    }
  });

  return bestDelimiter;
};

const findNameColumnIndex = (headers: string[]): number => {
  const exactAliases = new Set([
    'name',
    'full name',
    'full_name',
    'customer name',
    'customer_name',
    'display name',
    'contact name',
  ]);

  const exactIndex = headers.findIndex(header => exactAliases.has(header));
  if (exactIndex >= 0) return exactIndex;

  return headers.findIndex(header => /(^|\s)name($|\s)/.test(header));
};

const findPhoneColumnIndex = (headers: string[]): number => {
  let bestIndex = -1;
  let bestScore = -1;

  headers.forEach((header, index) => {
    let score = 0;
    const isPhoneLike = /(phone|mobile|tel|telephone|cell|number)/.test(header);
    if (!isPhoneLike) return;

    score += 20;
    if (['phone', 'mobile', 'number', 'customer phone', 'customer_phone'].includes(header)) {
      score += 100;
    }
    if (/value|number/.test(header)) {
      score += 15;
    }
    if (/type|label|kind/.test(header)) {
      score -= 20;
    }
    if (/primary|main/.test(header)) {
      score += 10;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
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
  const sanitizedText = text.replace(/^\uFEFF/, '');
  const previewLines = sanitizedText.split(/\r?\n/).filter(Boolean);

  if (previewLines.length < 2) {
    return { totalRows: 0, valid: [], rejected: 0, errors: ['CSV needs a header row and at least one data row.'] };
  }

  const delimiter = detectDelimiter(previewLines[0]);
  const rows = parseDelimitedRows(sanitizedText, delimiter);

  if (rows.length < 2) {
    return { totalRows: 0, valid: [], rejected: 0, errors: ['CSV needs a header row and at least one data row.'] };
  }

  const headers = rows[0].map(normalizeHeader);
  const nameIndex = findNameColumnIndex(headers);
  const phoneIndex = findPhoneColumnIndex(headers);
  const firstNameIndex = headers.findIndex(header => ['first name', 'firstname', 'given name', 'givenname'].includes(header));
  const lastNameIndex = headers.findIndex(header => ['last name', 'lastname', 'family name', 'familyname', 'surname'].includes(header));

  if ((nameIndex === -1 && firstNameIndex === -1 && lastNameIndex === -1) || phoneIndex === -1) {
    return {
      totalRows: 0,
      valid: [],
      rejected: 0,
      errors: ['CSV header must include a phone column and either a name column or first/last name columns.'],
    };
  }

  const errors: string[] = [];
  const valid: ContactImportCandidate[] = [];
  const MAX_REPORTED_ERRORS = 120;

  rows.slice(1).forEach((cols, index) => {
    const row: Record<string, unknown> = {};
    headers.forEach((header, headerIndex) => {
      row[header] = cols[headerIndex] ?? '';
    });

    const firstName = firstNameIndex >= 0 ? String(cols[firstNameIndex] ?? '').trim() : '';
    const lastName = lastNameIndex >= 0 ? String(cols[lastNameIndex] ?? '').trim() : '';
    const compositeName = `${firstName} ${lastName}`.trim();
    row.name = nameIndex >= 0 ? cols[nameIndex] : compositeName;
    row.phone = cols[phoneIndex];

    const parsedRow = parseContactRow(row, `Row ${index + 2}`);
    if (parsedRow.error) {
      if (errors.length < MAX_REPORTED_ERRORS) {
        errors.push(parsedRow.error);
      }
      return;
    }

    valid.push(parsedRow.contact!);
  });

  const totalRows = rows.length - 1;

  if (errors.length === MAX_REPORTED_ERRORS) {
    const hiddenErrorCount = Math.max(0, totalRows - valid.length - MAX_REPORTED_ERRORS);
    if (hiddenErrorCount > 0) {
      errors.push(`...and ${hiddenErrorCount} more invalid rows.`);
    }
  }

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

  const unfoldVcfLines = (block: string): string[] => {
    const rawLines = block.split(/\r?\n/);
    const unfolded: string[] = [];

    rawLines.forEach(line => {
      if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length > 0) {
        unfolded[unfolded.length - 1] += line.slice(1);
        return;
      }
      unfolded.push(line);
    });

    return unfolded.map(line => line.trim()).filter(Boolean);
  };

  const decodeQuotedPrintable = (value: string): string => {
    if (!value) return '';

    const softBreakNormalized = value.replace(/=(\r?\n)/g, '');
    const bytes: number[] = [];

    for (let index = 0; index < softBreakNormalized.length; index += 1) {
      const char = softBreakNormalized[index];
      if (char === '=' && index + 2 < softBreakNormalized.length) {
        const hex = softBreakNormalized.slice(index + 1, index + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          index += 2;
          continue;
        }
      }

      bytes.push(char.charCodeAt(0));
    }

    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
    } catch {
      return softBreakNormalized;
    }
  };

  const unescapeVCardValue = (value: string): string => {
    return value
      .replace(/\\n/gi, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\:/g, ':')
      .trim();
  };

  blocks.forEach((block, index) => {
    const lines = unfoldVcfLines(block);
    const nameLine = lines.find(line => /^FN(?::|;)/i.test(line)) || lines.find(line => /^N(?::|;)/i.test(line));
    const telLine = lines.find(line => /^TEL(?::|;)/i.test(line));
    const noteLine = lines.find(line => /^NOTE(?::|;)/i.test(line));

    const readValue = (line?: string): string => {
      if (!line) return '';
      const idx = line.indexOf(':');
      if (idx === -1) return '';
      const metadata = line.slice(0, idx);
      const rawValue = line.slice(idx + 1).trim();
      const decoded = /ENCODING=QUOTED-PRINTABLE/i.test(metadata)
        ? decodeQuotedPrintable(rawValue)
        : rawValue;
      return unescapeVCardValue(decoded);
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

  const trimmed = text.trim();
  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  return looksLikeJson ? parseContactsFromJson(text) : parseContactsFromCsv(text);
};
