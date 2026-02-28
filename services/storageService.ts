
import { Trip, Settings, Driver, Customer, MissionAlert, DeletedTripRecord } from '../types';
import { LOCAL_STORAGE_KEYS, DEFAULT_EXCHANGE_RATE, DEFAULT_HOURLY_WAIT_RATE, DEFAULT_RATE_USD_PER_KM, DEFAULT_FUEL_PRICE_USD_PER_LITER, DEFAULT_TEMPLATES } from '../constants';
import { mergeCustomerCollections } from './customerProfile';

interface FullSystemBackup {
  version?: string;
  timestamp?: string;
  trips?: Trip[];
  deletedTrips?: DeletedTripRecord[];
  drivers?: Driver[];
  customers?: Customer[];
  alerts?: MissionAlert[];
  settings?: Partial<Settings>;
}

export interface BackupInspection {
  isValid: boolean;
  error?: string;
  version?: string;
  counts: {
    trips: number;
    deletedTrips: number;
    drivers: number;
    customers: number;
    alerts: number;
  };
  hasSettings: boolean;
}

export interface RestoreResult {
  ok: boolean;
  error?: string;
  inspection?: BackupInspection;
  applied: {
    trips: boolean;
    deletedTrips: boolean;
    drivers: boolean;
    customers: boolean;
    alerts: boolean;
    settings: boolean;
  };
}

interface RestoreOptions {
  mode?: 'merge' | 'replace';
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const ENV_GOOGLE_MAPS_API_KEY = String(import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim();
const ENV_GOOGLE_MAPS_MAP_ID = String(import.meta.env.VITE_GOOGLE_MAPS_MAP_ID || '').trim();
const ENV_GOOGLE_MAPS_MAP_ID_DARK = String(import.meta.env.VITE_GOOGLE_MAPS_MAP_ID_DARK || '').trim();

const LEGACY_CONFIRMATION_REPLY_YES = 'Reply YES to confirm.';
const LEGACY_BRAND_LINE_PATTERN = /^(Control Taxi|Andrew's Taxi)\s*🙏\n/;

const migrateLegacyTemplates = (rawTemplates: unknown): { templates: Settings['templates']; changed: boolean } => {
  const nextTemplates: Settings['templates'] = {
    ...DEFAULT_TEMPLATES,
  };

  if (isRecord(rawTemplates)) {
    if (typeof rawTemplates.trip_confirmation === 'string') {
      nextTemplates.trip_confirmation = rawTemplates.trip_confirmation;
    }
    if (typeof rawTemplates.feedback_request === 'string') {
      nextTemplates.feedback_request = rawTemplates.feedback_request;
    }
    if (typeof rawTemplates.feedback_thanks === 'string') {
      nextTemplates.feedback_thanks = rawTemplates.feedback_thanks;
    }
  }

  let changed = false;

  if (nextTemplates.trip_confirmation.includes(LEGACY_CONFIRMATION_REPLY_YES)) {
    nextTemplates.trip_confirmation = DEFAULT_TEMPLATES.trip_confirmation;
    changed = true;
  }

  if (LEGACY_BRAND_LINE_PATTERN.test(nextTemplates.feedback_request)) {
    nextTemplates.feedback_request = DEFAULT_TEMPLATES.feedback_request;
    changed = true;
  }

  if (LEGACY_BRAND_LINE_PATTERN.test(nextTemplates.feedback_thanks)) {
    nextTemplates.feedback_thanks = DEFAULT_TEMPLATES.feedback_thanks;
    changed = true;
  }

  return { templates: nextTemplates, changed };
};

// --- SYSTEM WIDE ---
export const getFullSystemData = (options?: { includeSettings?: boolean }) => {
  const includeSettings = options?.includeSettings === true;
  return {
    trips: getTrips(),
    deletedTrips: getDeletedTrips(),
    drivers: getDrivers(),
    customers: getCustomers(),
    alerts: getAlerts(),
    ...(includeSettings ? { settings: getSettings() } : {}),
    timestamp: new Date().toISOString(),
    version: "2.1.0"
  };
};

export const inspectFullSystemBackup = (data: unknown): BackupInspection => {
  if (!isRecord(data)) {
    return {
      isValid: false,
      error: 'Backup must be a JSON object.',
      counts: { trips: 0, deletedTrips: 0, drivers: 0, customers: 0, alerts: 0 },
      hasSettings: false,
    };
  }

  const backup = data as FullSystemBackup;

  if (typeof backup.version !== 'string' || !backup.version.trim()) {
    return {
      isValid: false,
      error: 'Backup version is missing or invalid.',
      counts: { trips: 0, deletedTrips: 0, drivers: 0, customers: 0, alerts: 0 },
      hasSettings: false,
    };
  }

  if ('trips' in backup && !Array.isArray(backup.trips)) {
    return {
      isValid: false,
      error: 'Trips section is invalid.',
      counts: { trips: 0, deletedTrips: 0, drivers: 0, customers: 0, alerts: 0 },
      hasSettings: false,
    };
  }

  if ('deletedTrips' in backup && !Array.isArray(backup.deletedTrips)) {
    return {
      isValid: false,
      error: 'Deleted trips section is invalid.',
      counts: { trips: 0, deletedTrips: 0, drivers: 0, customers: 0, alerts: 0 },
      hasSettings: false,
    };
  }

  if ('drivers' in backup && !Array.isArray(backup.drivers)) {
    return {
      isValid: false,
      error: 'Drivers section is invalid.',
      counts: { trips: 0, deletedTrips: 0, drivers: 0, customers: 0, alerts: 0 },
      hasSettings: false,
    };
  }

  if ('customers' in backup && !Array.isArray(backup.customers)) {
    return {
      isValid: false,
      error: 'Customers section is invalid.',
      counts: { trips: 0, deletedTrips: 0, drivers: 0, customers: 0, alerts: 0 },
      hasSettings: false,
    };
  }

  if ('alerts' in backup && !Array.isArray(backup.alerts)) {
    return {
      isValid: false,
      error: 'Alerts section is invalid.',
      counts: { trips: 0, deletedTrips: 0, drivers: 0, customers: 0, alerts: 0 },
      hasSettings: false,
    };
  }

  if ('settings' in backup && !isRecord(backup.settings)) {
    return {
      isValid: false,
      error: 'Settings section is invalid.',
      counts: { trips: 0, deletedTrips: 0, drivers: 0, customers: 0, alerts: 0 },
      hasSettings: false,
    };
  }

  const counts = {
    trips: Array.isArray(backup.trips) ? backup.trips.length : 0,
    deletedTrips: Array.isArray(backup.deletedTrips) ? backup.deletedTrips.length : 0,
    drivers: Array.isArray(backup.drivers) ? backup.drivers.length : 0,
    customers: Array.isArray(backup.customers) ? backup.customers.length : 0,
    alerts: Array.isArray(backup.alerts) ? backup.alerts.length : 0,
  };
  const hasSettings = isRecord(backup.settings);

  if (counts.trips + counts.deletedTrips + counts.drivers + counts.customers + counts.alerts === 0 && !hasSettings) {
    return {
      isValid: false,
      error: 'Backup has no restorable sections.',
      counts,
      hasSettings,
      version: backup.version,
    };
  }

  return {
    isValid: true,
    counts,
    hasSettings,
    version: backup.version,
  };
};

export const restoreFullSystemData = (data: unknown, options?: RestoreOptions): RestoreResult => {
  const inspection = inspectFullSystemBackup(data);
  const mode = options?.mode === 'replace' ? 'replace' : 'merge';
  const applied = {
    trips: false,
    deletedTrips: false,
    drivers: false,
    customers: false,
    alerts: false,
    settings: false,
  };

  if (!inspection.isValid) {
    return { ok: false, error: inspection.error || 'Invalid backup.', inspection, applied };
  }

  const backup = data as FullSystemBackup;

  const mergeByKey = <T>(
    existing: T[],
    incoming: T[],
    getKey: (item: T) => string | number | undefined
  ): T[] => {
    const map = new Map<string | number, T>();

    existing.forEach(item => {
      const key = getKey(item);
      if (key === undefined || key === null || key === '') return;
      map.set(key, item);
    });

    incoming.forEach(item => {
      const key = getKey(item);
      if (key === undefined || key === null || key === '') return;
      map.set(key, item);
    });

    return Array.from(map.values());
  };

  if (Array.isArray(backup.trips)) {
    const nextTrips = mode === 'replace'
      ? backup.trips
      : mergeByKey(getTrips(), backup.trips, trip => trip.id);
    localStorage.setItem(LOCAL_STORAGE_KEYS.TRIPS, JSON.stringify(nextTrips));
    applied.trips = true;
  }
  if (Array.isArray(backup.deletedTrips)) {
    const nextDeletedTrips = mode === 'replace'
      ? backup.deletedTrips
      : mergeByKey(getDeletedTrips(), backup.deletedTrips, record => record.archiveId);
    localStorage.setItem(LOCAL_STORAGE_KEYS.DELETED_TRIPS, JSON.stringify(nextDeletedTrips));
    applied.deletedTrips = true;
  }
  if (Array.isArray(backup.drivers)) {
    const nextDrivers = mode === 'replace'
      ? backup.drivers
      : mergeByKey(getDrivers(), backup.drivers, driver => driver.id);
    localStorage.setItem(LOCAL_STORAGE_KEYS.DRIVERS, JSON.stringify(nextDrivers));
    applied.drivers = true;
  }
  if (Array.isArray(backup.customers)) {
    const nextCustomers = mode === 'replace'
      ? backup.customers
      : mergeCustomerCollections(getCustomers(), backup.customers).customers;
    localStorage.setItem(LOCAL_STORAGE_KEYS.CUSTOMERS, JSON.stringify(nextCustomers));
    applied.customers = true;
  }
  if (Array.isArray(backup.alerts)) {
    const nextAlerts = mode === 'replace'
      ? backup.alerts
      : mergeByKey(getAlerts(), backup.alerts, alert => alert.id);
    localStorage.setItem(LOCAL_STORAGE_KEYS.ALERTS, JSON.stringify(nextAlerts));
    applied.alerts = true;
  }

  if (isRecord(backup.settings)) {
    const templates = isRecord(backup.settings.templates) ? backup.settings.templates : DEFAULT_TEMPLATES;

    saveSettings({
      exchangeRate: typeof backup.settings.exchangeRate === 'number' ? backup.settings.exchangeRate : DEFAULT_EXCHANGE_RATE,
      googleMapsApiKey: typeof backup.settings.googleMapsApiKey === 'string' ? backup.settings.googleMapsApiKey : '',
      googleMapsMapId: typeof backup.settings.googleMapsMapId === 'string' ? backup.settings.googleMapsMapId : '',
      googleMapsMapIdDark: typeof backup.settings.googleMapsMapIdDark === 'string' ? backup.settings.googleMapsMapIdDark : '',
      operatorWhatsApp: typeof backup.settings.operatorWhatsApp === 'string' ? backup.settings.operatorWhatsApp : '',
      hourlyWaitRate: typeof backup.settings.hourlyWaitRate === 'number' ? backup.settings.hourlyWaitRate : DEFAULT_HOURLY_WAIT_RATE,
      ratePerKm: typeof backup.settings.ratePerKm === 'number' ? backup.settings.ratePerKm : DEFAULT_RATE_USD_PER_KM,
      fuelPriceUsdPerLiter: typeof backup.settings.fuelPriceUsdPerLiter === 'number' ? backup.settings.fuelPriceUsdPerLiter : DEFAULT_FUEL_PRICE_USD_PER_LITER,
      templates: {
        trip_confirmation: typeof templates.trip_confirmation === 'string' ? templates.trip_confirmation : DEFAULT_TEMPLATES.trip_confirmation,
        feedback_request: typeof templates.feedback_request === 'string' ? templates.feedback_request : DEFAULT_TEMPLATES.feedback_request,
        feedback_thanks: typeof templates.feedback_thanks === 'string' ? templates.feedback_thanks : DEFAULT_TEMPLATES.feedback_thanks,
      }
    });
    applied.settings = true;
  }

  return { ok: true, inspection, applied };
};

export const clearOperationalData = () => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.TRIPS, JSON.stringify([]));
  localStorage.setItem(LOCAL_STORAGE_KEYS.DELETED_TRIPS, JSON.stringify([]));
  localStorage.setItem(LOCAL_STORAGE_KEYS.DRIVERS, JSON.stringify([]));
  localStorage.setItem(LOCAL_STORAGE_KEYS.CUSTOMERS, JSON.stringify([]));
  localStorage.setItem(LOCAL_STORAGE_KEYS.ALERTS, JSON.stringify([]));
};

// --- ALERTS ---
export const getAlerts = (): MissionAlert[] => {
  try {
    const data = localStorage.getItem(LOCAL_STORAGE_KEYS.ALERTS);
    return data ? JSON.parse(data) : [];
  } catch (e) {
    console.error("Failed to load alerts", e);
    return [];
  }
};

export const saveAlerts = (alerts: MissionAlert[]): void => {
  // Keep only active alerts or very recent ones to keep storage clean
  const limitedAlerts = alerts.slice(-100); 
  localStorage.setItem(LOCAL_STORAGE_KEYS.ALERTS, JSON.stringify(limitedAlerts));
};

// --- TRIPS ---
export const getTrips = (): Trip[] => {
  try {
    const data = localStorage.getItem(LOCAL_STORAGE_KEYS.TRIPS);
    return data ? JSON.parse(data) : [];
  } catch (e) {
    console.error("Failed to load trips", e);
    return [];
  }
};

export const saveTrip = (trip: Trip): Trip[] => {
  const trips = getTrips();
  const newTrips = [trip, ...trips];
  localStorage.setItem(LOCAL_STORAGE_KEYS.TRIPS, JSON.stringify(newTrips));
  return newTrips;
};

export const saveDispatch = (
  entity: 'trip' | 'driver' | 'customers',
  payload: Trip | Driver | Customer[]
): Trip[] | Driver[] | Customer[] => {
  switch (entity) {
    case 'trip':
      return saveTrip(payload as Trip);
    case 'driver':
      return saveDriver(payload as Driver);
    case 'customers':
      saveCustomers(payload as Customer[]);
      return payload as Customer[];
    default:
      return [];
  }
};

export const updateTrip = (updatedTrip: Trip): Trip[] => {
  const trips = getTrips();
  const newTrips = trips.map(t => t.id === updatedTrip.id ? updatedTrip : t);
  localStorage.setItem(LOCAL_STORAGE_KEYS.TRIPS, JSON.stringify(newTrips));
  return newTrips;
};

export const getDeletedTrips = (): DeletedTripRecord[] => {
  try {
    const data = localStorage.getItem(LOCAL_STORAGE_KEYS.DELETED_TRIPS);
    return data ? JSON.parse(data) : [];
  } catch (e) {
    console.error('Failed to load deleted trips', e);
    return [];
  }
};

export const saveDeletedTrips = (deletedTrips: DeletedTripRecord[]): DeletedTripRecord[] => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.DELETED_TRIPS, JSON.stringify(deletedTrips));
  return deletedTrips;
};

export const archiveCancelledTrip = (tripId: number): { trips: Trip[]; deletedTrips: DeletedTripRecord[] } => {
  const trips = getTrips();
  const target = trips.find(entry => entry.id === tripId);
  if (!target || target.status !== 'CANCELLED') {
    return { trips, deletedTrips: getDeletedTrips() };
  }

  const nextTrips = trips.filter(entry => entry.id !== tripId);
  localStorage.setItem(LOCAL_STORAGE_KEYS.TRIPS, JSON.stringify(nextTrips));

  const archiveRecord: DeletedTripRecord = {
    archiveId: `deleted-${target.id}-${Date.now()}`,
    deletedAt: new Date().toISOString(),
    deletedReason: 'CANCELLED_DELETE',
    trip: target,
  };

  const nextDeletedTrips = [archiveRecord, ...getDeletedTrips()];
  localStorage.setItem(LOCAL_STORAGE_KEYS.DELETED_TRIPS, JSON.stringify(nextDeletedTrips));

  return { trips: nextTrips, deletedTrips: nextDeletedTrips };
};

export const restoreDeletedTrip = (archiveId: string): { trips: Trip[]; deletedTrips: DeletedTripRecord[] } => {
  const deletedTrips = getDeletedTrips();
  const target = deletedTrips.find(record => record.archiveId === archiveId);
  if (!target) {
    return { trips: getTrips(), deletedTrips };
  }

  const currentTrips = getTrips();
  const restoredTrip = target.trip;
  const alreadyExists = currentTrips.some(entry => entry.id === restoredTrip.id);
  const nextTrips = alreadyExists ? currentTrips : [restoredTrip, ...currentTrips];
  localStorage.setItem(LOCAL_STORAGE_KEYS.TRIPS, JSON.stringify(nextTrips));

  const nextDeletedTrips = deletedTrips.filter(record => record.archiveId !== archiveId);
  localStorage.setItem(LOCAL_STORAGE_KEYS.DELETED_TRIPS, JSON.stringify(nextDeletedTrips));

  return { trips: nextTrips, deletedTrips: nextDeletedTrips };
};

// --- CUSTOMERS ---
export const getCustomers = (): Customer[] => {
  try {
    const data = localStorage.getItem(LOCAL_STORAGE_KEYS.CUSTOMERS);
    return data ? JSON.parse(data) : [];
  } catch (e) {
    console.error("Failed to load customers", e);
    return [];
  }
};

export const saveCustomers = (customers: Customer[]): void => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.CUSTOMERS, JSON.stringify(customers));
};

// --- DRIVERS ---
export const getDrivers = (): Driver[] => {
  try {
    const data = localStorage.getItem(LOCAL_STORAGE_KEYS.DRIVERS);
    if (!data) return [];
    const parsed = JSON.parse(data);
    return parsed.map((d: any) => {
      const normalizedFuelLogs = Array.isArray(d.fuelLogs)
        ? d.fuelLogs
            .filter((entry: any) => entry && typeof entry === 'object')
            .map((entry: any, index: number) => {
              const timestamp = typeof entry.timestamp === 'string' && entry.timestamp ? entry.timestamp : (d.joinedAt || new Date().toISOString());
              const rawCurrency = String(entry.currency || '').toUpperCase();
              const currency: 'USD' | 'LBP' = rawCurrency === 'LBP' ? 'LBP' : 'USD';
              const amountOriginal = Number(entry.amountOriginal);
              const amountLbp = Number(entry.amountLbp);
              const amountUsd = Number(entry.amountUsd);
              const fxRateSnapshot = Number(entry.fxRateSnapshot);
              const fallbackFx = Number(getSettings().exchangeRate) || 90000;

              const resolvedAmountOriginal = Number.isFinite(amountOriginal)
                ? amountOriginal
                : (currency === 'LBP'
                    ? (Number.isFinite(amountLbp) ? amountLbp : 0)
                    : (Number.isFinite(amountUsd) ? amountUsd : 0));

              const resolvedFx = Number.isFinite(fxRateSnapshot) && fxRateSnapshot > 0
                ? fxRateSnapshot
                : fallbackFx;

              const resolvedAmountUsd = Number.isFinite(amountUsd)
                ? amountUsd
                : (currency === 'LBP'
                    ? (resolvedFx > 0 ? resolvedAmountOriginal / resolvedFx : 0)
                    : resolvedAmountOriginal);

              const resolvedAmountLbp = currency === 'LBP'
                ? resolvedAmountOriginal
                : (resolvedAmountUsd * resolvedFx);

              const odometerKm = typeof entry.odometerKm === 'number' ? entry.odometerKm : undefined;
              const note = typeof entry.note === 'string' && entry.note ? entry.note : undefined;
              const deterministicId = `${String(d.id || 'driver')}-${timestamp}-${resolvedAmountUsd}-${odometerKm ?? ''}-${index}`;

              return {
                id: String(entry.id || deterministicId),
                timestamp,
                amountUsd: Math.max(0, resolvedAmountUsd),
                amountOriginal: Math.max(0, resolvedAmountOriginal),
                currency,
                fxRateSnapshot: resolvedFx,
                amountLbp: Math.max(0, resolvedAmountLbp),
                ...(odometerKm !== undefined ? { odometerKm } : {}),
                ...(note ? { note } : {}),
              };
            })
        : ((d.totalGasSpent || 0) > 0
            ? [{
                id: `legacy-fuel-${String(d.id || 'driver')}`,
                timestamp: d.joinedAt || new Date().toISOString(),
                amountUsd: Number(d.totalGasSpent) || 0,
                amountOriginal: Number(d.totalGasSpent) || 0,
                currency: 'USD' as const,
                fxRateSnapshot: Number(getSettings().exchangeRate) || 90000,
                amountLbp: (Number(d.totalGasSpent) || 0) * ((Number(getSettings().exchangeRate) || 90000)),
                note: 'Legacy migration baseline',
              }]
            : []);

      const normalizedTotalGasSpent = normalizedFuelLogs.length > 0
        ? normalizedFuelLogs.reduce((sum: number, entry: any) => sum + (Number(entry.amountUsd) || 0), 0)
        : (Number(d.totalGasSpent) || 0);

      return {
        ...d,
        currentStatus: d.currentStatus || 'OFF_DUTY',
        vehicleOwnership: d.vehicleOwnership || 'COMPANY_FLEET',
        fuelCostResponsibility: d.fuelCostResponsibility || 'COMPANY',
        maintenanceResponsibility: d.maintenanceResponsibility || 'COMPANY',
        baseMileage: d.baseMileage || 0,
        lastOilChangeKm: d.lastOilChangeKm || 0,
        lastCheckupKm: d.lastCheckupKm || 0,
        totalGasSpent: normalizedTotalGasSpent,
        lastRefuelKm: d.lastRefuelKm ?? d.baseMileage ?? 0,
        fuelRangeKm: d.fuelRangeKm || 500,
        fuelLogs: normalizedFuelLogs,
      };
    });
  } catch (e) {
    console.error("Failed to load drivers", e);
    return [];
  }
};

export const saveDriver = (driver: Driver): Driver[] => {
  const drivers = getDrivers();
  const existingIndex = drivers.findIndex(d => d.id === driver.id);
  let newDrivers;
  
  if (existingIndex >= 0) {
    newDrivers = [...drivers];
    newDrivers[existingIndex] = driver;
  } else {
    newDrivers = [driver, ...drivers];
  }
  
  localStorage.setItem(LOCAL_STORAGE_KEYS.DRIVERS, JSON.stringify(newDrivers));
  return newDrivers;
};

export const deleteDriver = (id: string): Driver[] => {
  const drivers = getDrivers();
  const newDrivers = drivers.filter(d => d.id !== id);
  localStorage.setItem(LOCAL_STORAGE_KEYS.DRIVERS, JSON.stringify(newDrivers));
  return newDrivers;
};

// --- SETTINGS ---
export const getSettings = (): Settings => {
  try {
    const data = localStorage.getItem(LOCAL_STORAGE_KEYS.SETTINGS);
    if (data) {
      const parsed = JSON.parse(data);
      if (!isRecord(parsed)) {
        throw new Error('Invalid settings payload in storage');
      }

      const migratedTemplates = migrateLegacyTemplates(parsed.templates);

      if (migratedTemplates.changed) {
        localStorage.setItem(
          LOCAL_STORAGE_KEYS.SETTINGS,
          JSON.stringify({
            ...parsed,
            templates: migratedTemplates.templates,
          })
        );
      }

      return {
        exchangeRate: parsed.exchangeRate ?? DEFAULT_EXCHANGE_RATE,
        googleMapsApiKey: ENV_GOOGLE_MAPS_API_KEY || parsed.googleMapsApiKey || '',
        googleMapsMapId: ENV_GOOGLE_MAPS_MAP_ID || parsed.googleMapsMapId || '',
        googleMapsMapIdDark: ENV_GOOGLE_MAPS_MAP_ID_DARK || parsed.googleMapsMapIdDark || '',
        operatorWhatsApp: parsed.operatorWhatsApp ?? '',
        hourlyWaitRate: parsed.hourlyWaitRate ?? DEFAULT_HOURLY_WAIT_RATE,
        ratePerKm: parsed.ratePerKm ?? DEFAULT_RATE_USD_PER_KM,
        fuelPriceUsdPerLiter: parsed.fuelPriceUsdPerLiter ?? DEFAULT_FUEL_PRICE_USD_PER_LITER,
        templates: migratedTemplates.templates
      };
    }
  } catch (e) {
    console.error("Failed to load settings", e);
  }
  
  return {
    exchangeRate: DEFAULT_EXCHANGE_RATE,
    googleMapsApiKey: ENV_GOOGLE_MAPS_API_KEY,
    googleMapsMapId: ENV_GOOGLE_MAPS_MAP_ID,
    googleMapsMapIdDark: ENV_GOOGLE_MAPS_MAP_ID_DARK,
    operatorWhatsApp: '',
    hourlyWaitRate: DEFAULT_HOURLY_WAIT_RATE,
    ratePerKm: DEFAULT_RATE_USD_PER_KM,
    fuelPriceUsdPerLiter: DEFAULT_FUEL_PRICE_USD_PER_LITER,
    templates: DEFAULT_TEMPLATES
  };
};

export const saveSettings = (settings: Settings): void => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
};
