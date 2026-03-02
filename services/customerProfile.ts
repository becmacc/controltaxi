import { ContactImportCandidate } from './contactImport';
import { Customer, CustomerEntityType, CustomerGender, CustomerLocation, CustomerMarketSegment, CustomerProfileEvent, Trip, TripPaymentMode } from '../types';
import { normalizePhoneForWhatsApp } from './whatsapp';

const toIso = (value?: string): string => {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
};

const trimText = (value: unknown): string => String(value ?? '').trim();

const normalizePaymentMode = (mode?: TripPaymentMode): TripPaymentMode | undefined => {
  if (mode === 'CREDIT') return 'CREDIT';
  if (mode === 'CASH') return 'CASH';
  return undefined;
};

const pickSource = (current: Customer['source'], incoming: Customer['source']): Customer['source'] => {
  const rank: Record<Customer['source'], number> = { OPERATIONAL: 1, SYNC: 2, MANUAL: 3 };
  return rank[incoming] > rank[current] ? incoming : current;
};

const isPlaceholderName = (name: string): boolean => {
  return !name || /^walk-?in client$/i.test(name) || /^unknown client$/i.test(name);
};

const mergeNotes = (existing?: string, incoming?: string): string | undefined => {
  const lines = [...(existing || '').split(/\r?\n/), ...(incoming || '').split(/\r?\n/)]
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return undefined;

  const seen = new Set<string>();
  const merged: string[] = [];

  lines.forEach(line => {
    const key = line.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(line);
  });

  return merged.join('\n');
};

const uniqueSegments = (segments: CustomerMarketSegment[]): CustomerMarketSegment[] => {
  return Array.from(new Set(segments));
};

const inferInternationalFromPhone = (phone: string): boolean => {
  const key = customerPhoneKey(phone);
  return Boolean(key && !key.startsWith('961'));
};

const inferSegments = (phone: string, name?: string, notes?: string, existing?: CustomerMarketSegment[]): CustomerMarketSegment[] => {
  const text = `${trimText(name)} ${trimText(notes)}`.toLowerCase();
  const existingSegments = existing || [];
  const inferred: CustomerMarketSegment[] = [];
  const isInternational = inferInternationalFromPhone(phone);

  if (isInternational && existingSegments.length === 0) {
    inferred.push('EXPAT', 'TOURIST');
  }

  if (!isInternational && existingSegments.length === 0) {
    inferred.push('LOCAL_RESIDENT');
  }

  if (/\bexpat\b|\bexpert\b/.test(text)) {
    inferred.push('EXPAT');
  }

  if (/\btourist\b|\bvisitor\b|\bholiday\b/.test(text)) {
    inferred.push('TOURIST');
  }

  if (/\blocal\b|\bresident\b|\blebanese\b|\bsettled\b/.test(text)) {
    inferred.push('LOCAL_RESIDENT');
  }

  return uniqueSegments([...existingSegments, ...inferred]);
};

const inferGenderFromText = (name?: string, notes?: string): CustomerGender | undefined => {
  const text = `${trimText(name)} ${trimText(notes)}`.toLowerCase();

  const maleMarkers = [
    /(^|\s)(mr\.?|mister|sir)(\s|$)/,
    /(^|\s)(brother|captain)(\s|$)/,
    /(^|\s)(السيد)(\s|$)/,
  ];
  const femaleMarkers = [
    /(^|\s)(mrs\.?|ms\.?|miss|madam|lady)(\s|$)/,
    /(^|\s)(السيدة|آنسة)(\s|$)/,
  ];

  const male = maleMarkers.some(pattern => pattern.test(text));
  const female = femaleMarkers.some(pattern => pattern.test(text));

  if (male && !female) return 'MALE';
  if (female && !male) return 'FEMALE';
  return undefined;
};

const inferEntityTypeFromText = (name?: string, notes?: string): CustomerEntityType | undefined => {
  const text = `${trimText(name)} ${trimText(notes)}`.toLowerCase();
  const businessMarkers = [
    /\b(llc|ltd|inc|corp|company|co\.|sarl|sal|group)\b/,
    /\b(hotel|restaurant|cafe|shop|store|market|supermarket)\b/,
    /\b(clinic|hospital|pharmacy|school|university|office)\b/,
  ];
  const individualMarkers = [
    /(^|\s)(mr\.?|mrs\.?|ms\.?|miss|sir|madam)(\s|$)/,
    /(^|\s)(السيد|السيدة|آنسة)(\s|$)/,
  ];

  const isBusiness = businessMarkers.some(pattern => pattern.test(text));
  const isIndividual = individualMarkers.some(pattern => pattern.test(text));

  if (isBusiness && !isIndividual) return 'BUSINESS';
  if (isIndividual && !isBusiness) return 'INDIVIDUAL';
  return undefined;
};

const inferProfessionFromText = (name?: string, notes?: string): string | undefined => {
  const text = `${trimText(name)} ${trimText(notes)}`.toLowerCase();
  const professionPatterns: Array<{ label: string; pattern: RegExp }> = [
    { label: 'Doctor', pattern: /\b(dr\.?|doctor|physician)\b/ },
    { label: 'Engineer', pattern: /\b(eng\.?|engineer)\b/ },
    { label: 'Lawyer', pattern: /\b(lawyer|attorney|advocate)\b/ },
    { label: 'Professor', pattern: /\b(prof\.?|professor)\b/ },
    { label: 'Pilot', pattern: /\b(pilot|captain)\b/ },
    { label: 'Nurse', pattern: /\b(nurse)\b/ },
    { label: 'Teacher', pattern: /\b(teacher|instructor)\b/ },
  ];

  const matches = professionPatterns.filter(item => item.pattern.test(text));
  if (matches.length === 1) return matches[0].label;
  return undefined;
};

const normalizeTimeline = (timeline?: CustomerProfileEvent[]): CustomerProfileEvent[] => {
  if (!Array.isArray(timeline)) return [];

  return timeline
    .map(item => {
      const note = trimText(item?.note);
      if (!note) return null;

      return {
        id: trimText(item?.id) || `${toIso(item?.timestamp)}-${note.slice(0, 24).toLowerCase()}`,
        timestamp: toIso(item?.timestamp),
        source: item?.source || 'MANUAL',
        note,
        ...(typeof item?.tripId === 'number' ? { tripId: item.tripId } : {}),
      } as CustomerProfileEvent;
    })
    .filter((item): item is CustomerProfileEvent => item !== null);
};

const normalizeLocation = (location?: CustomerLocation): CustomerLocation | undefined => {
  if (!location) return undefined;
  const label = trimText(location.label);
  const address = trimText(location.address);
  if (!address) return undefined;

  const mapsLink = trimText(location.mapsLink);
  const lat = typeof location.lat === 'number' && Number.isFinite(location.lat) ? location.lat : undefined;
  const lng = typeof location.lng === 'number' && Number.isFinite(location.lng) ? location.lng : undefined;

  return {
    label: label || 'Place',
    address,
    ...(mapsLink ? { mapsLink } : {}),
    ...(lat !== undefined ? { lat } : {}),
    ...(lng !== undefined ? { lng } : {}),
  };
};

const mergeFrequentLocations = (
  existing?: CustomerLocation[],
  incoming?: CustomerLocation[]
): CustomerLocation[] => {
  const normalizedExisting = (existing || []).map(item => normalizeLocation(item)).filter((item): item is CustomerLocation => Boolean(item));
  const normalizedIncoming = (incoming || []).map(item => normalizeLocation(item)).filter((item): item is CustomerLocation => Boolean(item));

  const merged = [...normalizedExisting, ...normalizedIncoming];
  const deduped: CustomerLocation[] = [];
  const seen = new Set<string>();

  merged.forEach(item => {
    const key = `${item.address.toLowerCase()}|${trimText(item.mapsLink).toLowerCase()}|${item.lat ?? ''}|${item.lng ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(item);
  });

  return deduped;
};

export const customerPhoneKey = (phone: string): string => {
  const normalized = normalizePhoneForWhatsApp(phone);
  return normalized || trimText(phone);
};

export const mergeCustomerRecord = (existing: Customer, incoming: Customer): Customer => {
  const existingName = trimText(existing.name);
  const incomingName = trimText(incoming.name);
  const name = isPlaceholderName(existingName) && incomingName ? incomingName : (existingName || incomingName || 'Unknown Client');

  const existingTimeline = normalizeTimeline(existing.profileTimeline);
  const incomingTimeline = normalizeTimeline(incoming.profileTimeline);
  const timelineMap = new Map<string, CustomerProfileEvent>();

  [...existingTimeline, ...incomingTimeline].forEach(event => {
    const key = [event.timestamp, event.source, event.note.toLowerCase(), event.tripId ?? ''].join('|');
    if (!timelineMap.has(key)) {
      timelineMap.set(key, event);
    }
  });

  const profileTimeline = Array.from(timelineMap.values()).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const notes = mergeNotes(existing.notes, incoming.notes);
  const hasIncomingSegments = Array.isArray(incoming.marketSegments);
  const isInternational = hasIncomingSegments
    ? incoming.marketSegments!.length > 0 || incoming.isInternational === true || inferInternationalFromPhone(existing.phone) || inferInternationalFromPhone(incoming.phone)
    : inferInternationalFromPhone(existing.phone) || inferInternationalFromPhone(incoming.phone) || existing.isInternational || incoming.isInternational;
  const marketSegments = hasIncomingSegments
    ? uniqueSegments(incoming.marketSegments as CustomerMarketSegment[])
    : inferSegments(existing.phone || incoming.phone, name, notes, [
        ...(existing.marketSegments || []),
        ...(incoming.marketSegments || []),
      ]);
  const hasIncomingGender = Object.prototype.hasOwnProperty.call(incoming, 'gender');
  const inferredGender = inferGenderFromText(name, notes);
  const gender: CustomerGender | undefined = hasIncomingGender
    ? incoming.gender
    : (existing.gender || inferredGender || 'UNSPECIFIED');
  const hasIncomingEntityType = Object.prototype.hasOwnProperty.call(incoming, 'entityType');
  const inferredEntityType = inferEntityTypeFromText(name, notes);
  const entityType: CustomerEntityType | undefined = hasIncomingEntityType
    ? incoming.entityType
    : (existing.entityType || inferredEntityType || 'UNSPECIFIED');
  const hasIncomingProfession = Object.prototype.hasOwnProperty.call(incoming, 'profession');
  const inferredProfession = inferProfessionFromText(name, notes);
  const profession = hasIncomingProfession
    ? trimText(incoming.profession)
    : (trimText(existing.profession) || inferredProfession || '');
  const hasIncomingHomeLocation = Object.prototype.hasOwnProperty.call(incoming, 'homeLocation');
  const hasIncomingBusinessLocation = Object.prototype.hasOwnProperty.call(incoming, 'businessLocation');
  const hasIncomingFrequentLocations = Object.prototype.hasOwnProperty.call(incoming, 'frequentLocations');
  const hasIncomingDefaultPaymentMode = Object.prototype.hasOwnProperty.call(incoming, 'defaultPaymentMode');
  const homeLocation = hasIncomingHomeLocation
    ? normalizeLocation(incoming.homeLocation)
    : (normalizeLocation(existing.homeLocation) || normalizeLocation(incoming.homeLocation));
  const businessLocation = hasIncomingBusinessLocation
    ? normalizeLocation(incoming.businessLocation)
    : (normalizeLocation(existing.businessLocation) || normalizeLocation(incoming.businessLocation));
  const frequentLocations = hasIncomingFrequentLocations
    ? mergeFrequentLocations([], incoming.frequentLocations)
    : mergeFrequentLocations(existing.frequentLocations, incoming.frequentLocations);
  const incomingDefaultPaymentMode = normalizePaymentMode(incoming.defaultPaymentMode);
  const existingDefaultPaymentMode = normalizePaymentMode(existing.defaultPaymentMode);
  const defaultPaymentMode = hasIncomingDefaultPaymentMode
    ? incomingDefaultPaymentMode
    : existingDefaultPaymentMode;

  const createdAt = new Date(existing.createdAt).getTime() <= new Date(incoming.createdAt).getTime()
    ? toIso(existing.createdAt)
    : toIso(incoming.createdAt);

  const latestTimelineAt = profileTimeline[0]?.timestamp;
  const existingEnriched = existing.lastEnrichedAt ? toIso(existing.lastEnrichedAt) : undefined;
  const incomingEnriched = incoming.lastEnrichedAt ? toIso(incoming.lastEnrichedAt) : undefined;
  const candidates = [existingEnriched, incomingEnriched, latestTimelineAt].filter(Boolean) as string[];
  const lastEnrichedAt = candidates.length > 0
    ? candidates.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
    : undefined;

  return {
    ...existing,
    id: trimText(existing.id) || trimText(incoming.id) || `${Date.now()}-${Math.random()}`,
    name,
    phone: customerPhoneKey(existing.phone) || customerPhoneKey(incoming.phone),
    source: pickSource(existing.source, incoming.source),
    ...(isInternational ? { isInternational: true } : {}),
    ...(marketSegments.length > 0 ? { marketSegments } : {}),
    ...(gender ? { gender } : {}),
    ...(entityType ? { entityType } : {}),
    ...(profession ? { profession } : {}),
    ...(homeLocation ? { homeLocation } : {}),
    ...(businessLocation ? { businessLocation } : {}),
    ...(frequentLocations.length > 0 ? { frequentLocations } : {}),
    ...(defaultPaymentMode ? { defaultPaymentMode } : {}),
    createdAt,
    ...(notes ? { notes } : {}),
    ...(profileTimeline.length > 0 ? { profileTimeline } : {}),
    ...(lastEnrichedAt ? { lastEnrichedAt } : {}),
  };
};

export const mergeCustomerCollections = (
  existing: Customer[],
  incoming: Customer[]
): { customers: Customer[]; added: number; merged: number; unchanged: number } => {
  const mergedList: Customer[] = [];
  const keyToIndex = new Map<string, number>();
  let added = 0;
  let merged = 0;
  let unchanged = 0;

  existing.forEach(customer => {
    const key = customerPhoneKey(customer.phone);
    if (!key) return;

    if (!keyToIndex.has(key)) {
      keyToIndex.set(key, mergedList.length);
      mergedList.push({ ...customer, phone: key });
      return;
    }

    const index = keyToIndex.get(key)!;
    mergedList[index] = mergeCustomerRecord(mergedList[index], customer);
  });

  incoming.forEach(customer => {
    const key = customerPhoneKey(customer.phone);
    if (!key) return;

    const normalizedIncoming: Customer = { ...customer, phone: key };
    const index = keyToIndex.get(key);

    if (index === undefined) {
      keyToIndex.set(key, mergedList.length);
      mergedList.push(normalizedIncoming);
      added += 1;
      return;
    }

    const previous = mergedList[index];
    const next = mergeCustomerRecord(previous, normalizedIncoming);
    mergedList[index] = next;

    if (JSON.stringify(previous) === JSON.stringify(next)) {
      unchanged += 1;
    } else {
      merged += 1;
    }
  });

  return { customers: mergedList, added, merged, unchanged };
};

export const buildCustomerFromTrip = (
  trip: Trip,
  options?: { includeTimelineEvent?: boolean }
): Customer => {
  const includeTimelineEvent = options?.includeTimelineEvent === true;
  const note = trimText(trip.notes);
  const timestamp = toIso(trip.tripDate || trip.createdAt);
  const normalizedPaymentMode = normalizePaymentMode(trip.paymentMode) || 'CASH';
  const isInternational = inferInternationalFromPhone(trip.customerPhone);
  const marketSegments = inferSegments(trip.customerPhone, trip.customerName, note);
  const gender = inferGenderFromText(trip.customerName, note) || 'UNSPECIFIED';
  const entityType = inferEntityTypeFromText(trip.customerName, note) || 'UNSPECIFIED';
  const profession = inferProfessionFromText(trip.customerName, note);

  return {
    id: `${Date.now()}-${Math.random()}`,
    name: trimText(trip.customerName) || 'Unknown Client',
    phone: customerPhoneKey(trip.customerPhone),
    source: 'OPERATIONAL',
    defaultPaymentMode: normalizedPaymentMode,
    ...(isInternational ? { isInternational: true } : {}),
    ...(marketSegments.length > 0 ? { marketSegments } : {}),
    ...(gender ? { gender } : {}),
    ...(entityType ? { entityType } : {}),
    ...(profession ? { profession } : {}),
    createdAt: toIso(trip.createdAt),
    ...(note ? { notes: note } : {}),
    ...(includeTimelineEvent && note
      ? {
          profileTimeline: [
            {
              id: `${trip.id}-${timestamp}`,
              timestamp,
              source: 'TRIP_NOTE',
              note,
              tripId: trip.id,
            },
          ],
          lastEnrichedAt: timestamp,
        }
      : {}),
  };
};

export const buildCustomerFromImportedContact = (contact: ContactImportCandidate): Customer => {
  const timestamp = new Date().toISOString();
  const note = trimText(contact.notes);
  const importedTimeline = Array.isArray(contact.profileTimeline) ? contact.profileTimeline : [];
  const generatedTimeline = note
    ? [
        {
          id: `${Date.now()}-${Math.random()}`,
          timestamp,
          source: 'IMPORT' as const,
          note,
        },
      ]
    : [];
  const mergedTimeline = [...importedTimeline, ...generatedTimeline];
  const normalizedCreatedAt = trimText(contact.createdAt);
  const normalizedLastEnrichedAt = trimText(contact.lastEnrichedAt);
  const importedSource = contact.source;
  const autoInternational = inferInternationalFromPhone(contact.phone);
  const isInternational = contact.isInternational ?? autoInternational;
  const marketSegments = inferSegments(contact.phone, contact.name, note, contact.marketSegments);
  const gender = contact.gender || inferGenderFromText(contact.name, note) || 'UNSPECIFIED';
  const entityType = contact.entityType || inferEntityTypeFromText(contact.name, note) || 'UNSPECIFIED';
  const profession = trimText(contact.profession) || inferProfessionFromText(contact.name, note) || '';
  const homeLocation = normalizeLocation(contact.homeLocation as CustomerLocation | undefined);
  const businessLocation = normalizeLocation(contact.businessLocation as CustomerLocation | undefined);
  const frequentLocations = mergeFrequentLocations([], contact.frequentLocations as CustomerLocation[] | undefined);

  return {
    id: trimText(contact.id) || `${Date.now()}-${Math.random()}`,
    name: trimText(contact.name) || 'Unknown Client',
    phone: customerPhoneKey(contact.phone),
    source: importedSource || 'SYNC',
    ...(isInternational ? { isInternational: true } : {}),
    ...(marketSegments.length > 0 ? { marketSegments } : {}),
    ...(gender ? { gender } : {}),
    ...(entityType ? { entityType } : {}),
    ...(profession ? { profession } : {}),
    ...(homeLocation ? { homeLocation } : {}),
    ...(businessLocation ? { businessLocation } : {}),
    ...(frequentLocations.length > 0 ? { frequentLocations } : {}),
    createdAt: normalizedCreatedAt || timestamp,
    ...(note ? { notes: note } : {}),
    ...(mergedTimeline.length > 0
      ? {
          profileTimeline: mergedTimeline,
          lastEnrichedAt: normalizedLastEnrichedAt || timestamp,
        }
      : {}),
  };
};

export const getCustomerPreferredPaymentMode = (
  customer: Customer | null | undefined,
  trips: Trip[]
): TripPaymentMode => {
  const explicit = normalizePaymentMode(customer?.defaultPaymentMode);
  if (explicit) return explicit;
  if (!customer) return 'CASH';

  const key = customerPhoneKey(customer.phone);
  if (!key) return 'CASH';

  let latestTs = 0;
  let latestMode: TripPaymentMode | undefined;

  trips.forEach(trip => {
    if (customerPhoneKey(trip.customerPhone) !== key) return;
    const ts = new Date(trip.tripDate || trip.createdAt).getTime();
    if (!Number.isFinite(ts) || ts < latestTs) return;
    latestTs = ts;
    latestMode = normalizePaymentMode(trip.paymentMode) || 'CASH';
  });

  return latestMode || 'CASH';
};