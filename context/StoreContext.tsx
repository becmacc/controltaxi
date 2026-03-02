
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Trip, Settings, Driver, Customer, MissionAlert, TripStatus, DeletedTripRecord, CreditLedgerEntry, ReceiptRecord, CreditPartyType, CreditCycle, TripPaymentMode, TripSettlementStatus, CustomerProfileEvent } from '../types';
import * as Storage from '../services/storageService';
import { addMinutes, parseISO, isAfter } from 'date-fns';
import { LOCAL_STORAGE_KEYS } from '../constants';
import { buildCustomerFromTrip, customerPhoneKey, mergeCustomerCollections } from '../services/customerProfile';
import {
  CloudSyncSession,
  createSyncSignature,
  fetchCloudSyncSignature,
  getCloudSyncDocId,
  getOrCreateCloudSyncClientId,
  startCloudSync,
} from '../services/cloudSyncService';

interface StoreContextType {
  trips: Trip[];
  deletedTrips: DeletedTripRecord[];
  drivers: Driver[];
  customers: Customer[];
  creditLedger: CreditLedgerEntry[];
  receipts: ReceiptRecord[];
  settings: Settings;
  alerts: MissionAlert[];
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  addTrip: (tripData: Omit<Trip, 'id' | 'createdAt'>) => void;
  updateTripField: (id: number, field: keyof Trip, value: Trip[keyof Trip]) => void;
  updateFullTrip: (trip: Trip) => void;
  deleteCancelledTrip: (id: number) => { ok: boolean; reason?: string };
  restoreDeletedTrip: (archiveId: string) => { ok: boolean; reason?: string };
  
  // Alert Methods
  dismissAlert: (id: string) => void;
  snoozeAlert: (id: string, minutes?: number) => void;
  resolveAlert: (id: string) => void;

  // Customer Methods
  addCustomers: (newCustomers: Customer[]) => void;
  removeCustomerByPhone: (phone: string) => { ok: boolean; reason?: string };
  addCreditLedgerEntry: (payload: {
    partyType: CreditPartyType;
    partyName: string;
    cycle: CreditCycle;
    amountUsd: number;
    partyId?: string;
    dueDate?: string;
    notes?: string;
  }) => { ok: boolean; reason?: string; entry?: CreditLedgerEntry };
  settleCreditLedgerEntry: (entryId: string) => { ok: boolean; reason?: string; receipt?: ReceiptRecord };

  // Driver Methods
  addDriver: (driver: Driver) => void;
  editDriver: (driver: Driver) => void;
  removeDriver: (id: string) => void;

  updateSettings: (newSettings: Settings) => void;
  refreshData: () => void;
  forceCloudSyncPublish: () => Promise<{ ok: boolean; reason?: string }>;
  hardResetCloudSync: () => Promise<{ ok: boolean; nextDocId?: string; reason?: string }>;
}

declare global {
  var __CONTROL_STORE_CONTEXT__: React.Context<StoreContextType | undefined> | undefined;
}

const StoreContext = globalThis.__CONTROL_STORE_CONTEXT__ || createContext<StoreContextType | undefined>(undefined);
globalThis.__CONTROL_STORE_CONTEXT__ = StoreContext;

export const StoreProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [deletedTrips, setDeletedTrips] = useState<DeletedTripRecord[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [creditLedger, setCreditLedger] = useState<CreditLedgerEntry[]>([]);
  const [receipts, setReceipts] = useState<ReceiptRecord[]>([]);
  const [alerts, setAlerts] = useState<MissionAlert[]>([]);
  const [settings, setSettings] = useState<Settings>(Storage.getSettings());
  const [theme, setTheme] = useState<'light' | 'dark'>((localStorage.getItem('theme') as 'light' | 'dark') || 'light');
  const [cloudSyncReady, setCloudSyncReady] = useState(false);
  const [cloudSyncSessionVersion, setCloudSyncSessionVersion] = useState(0);
  const cloudSyncSessionRef = useRef<CloudSyncSession | null>(null);
  const cloudSyncClientIdRef = useRef<string>(getOrCreateCloudSyncClientId());
  const isApplyingRemoteRef = useRef(false);
  const lastSyncedSignatureRef = useRef<string | null>(null);
  const publishDebounceRef = useRef<number | null>(null);
  const notificationCooldownRef = useRef<Record<string, number>>({});
  const ALERT_NOTIFICATION_COOLDOWN_MS = 10 * 60 * 1000;

  const alertSignature = (alert: MissionAlert): string => {
    if (alert.type === 'REFUEL') {
      return `REFUEL:${alert.driverId || 'UNKNOWN_DRIVER'}`;
    }
    return `${alert.type}:${alert.tripId || 'UNKNOWN_TRIP'}`;
  };

  const dedupeAlerts = (inputAlerts: MissionAlert[]): MissionAlert[] => {
    const sorted = [...inputAlerts].sort((a, b) => {
      const targetDelta = new Date(b.targetTime).getTime() - new Date(a.targetTime).getTime();
      if (targetDelta !== 0) return targetDelta;
      const triggeredDelta = Number(a.triggered) - Number(b.triggered);
      return triggeredDelta;
    });

    const signatureMap = new Map<string, MissionAlert>();
    sorted.forEach(alert => {
      const key = alertSignature(alert);
      if (!signatureMap.has(key)) {
        signatureMap.set(key, alert);
      }
    });

    return Array.from(signatureMap.values()).sort((a, b) => new Date(a.targetTime).getTime() - new Date(b.targetTime).getTime());
  };

  const refreshData = useCallback(() => {
    setTrips(Storage.getTrips());
    setDeletedTrips(Storage.getDeletedTrips());
    setDrivers(Storage.getDrivers());
    setCustomers(Storage.getCustomers());
    setCreditLedger(Storage.getCreditLedger());
    setReceipts(Storage.getReceipts());
    setAlerts(Storage.getAlerts());
    setSettings(Storage.getSettings());
  }, []);

  useEffect(() => {
    refreshData();
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }

  }, [theme, refreshData]);

  useEffect(() => {
    const syncKeys = new Set<string>([
      LOCAL_STORAGE_KEYS.TRIPS,
      LOCAL_STORAGE_KEYS.DELETED_TRIPS,
      LOCAL_STORAGE_KEYS.DRIVERS,
      LOCAL_STORAGE_KEYS.CUSTOMERS,
      LOCAL_STORAGE_KEYS.ALERTS,
      LOCAL_STORAGE_KEYS.CREDIT_LEDGER,
      LOCAL_STORAGE_KEYS.RECEIPTS,
      LOCAL_STORAGE_KEYS.SETTINGS,
      LOCAL_STORAGE_KEYS.SYNC_EPOCH,
      LOCAL_STORAGE_KEYS.SYNC_RESET_TOKEN,
      'theme',
    ]);

    const handleStorageSync = (event: StorageEvent) => {
      if (!event.key || !syncKeys.has(event.key)) return;

      if (event.key === 'theme') {
        const nextTheme = (localStorage.getItem('theme') as 'light' | 'dark') || 'light';
        setTheme(nextTheme);
      }

      refreshData();
    };

    window.addEventListener('storage', handleStorageSync);
    return () => window.removeEventListener('storage', handleStorageSync);
  }, [refreshData]);

  useEffect(() => {
    let stopped = false;

    const initializeCloudSync = async () => {
      const session = await startCloudSync({
        clientId: cloudSyncClientIdRef.current,
        onStatusChange: (status, message) => {
          if (stopped) return;

          setCloudSyncReady(status === 'ready');

          if (status === 'ready') {
            console.info('[cloud-sync] ready');
          } else if (status === 'connecting') {
            console.info('[cloud-sync] connecting', message || '');
          } else if (status === 'disabled') {
            console.warn('[cloud-sync] disabled', message || '(missing firebase env)');
          } else if (status === 'error') {
            console.error('[cloud-sync] error', message || '(unknown error)');
          }
        },
        onRemoteData: (payload, metadata) => {
          try {
            if (metadata.updatedBy === cloudSyncClientIdRef.current) {
              if (metadata.signature) {
                lastSyncedSignatureRef.current = metadata.signature;
              }
              return;
            }

            if (metadata.channel) {
              console.info('[cloud-sync] incoming', metadata.channel);
            }

            const inspection = Storage.inspectFullSystemBackup(payload);
            if (!inspection.isValid) {
              console.warn('[cloud-sync] ignored invalid payload', inspection.error || 'invalid backup shape');
              return;
            }

            const payloadRecord = payload as Record<string, unknown>;
            const payloadSyncEpoch = typeof payloadRecord.syncEpoch === 'number' && Number.isFinite(payloadRecord.syncEpoch)
              ? Math.max(0, Math.floor(payloadRecord.syncEpoch))
              : 0;
            const remoteSyncEpoch = typeof metadata.syncEpoch === 'number'
              ? Math.max(0, Math.floor(metadata.syncEpoch))
              : payloadSyncEpoch;
            const localSyncEpoch = Storage.getSyncEpoch();
            const payloadResetToken = typeof payloadRecord.resetToken === 'string'
              ? String(payloadRecord.resetToken).trim()
              : '';
            const remoteResetToken = typeof metadata.resetToken === 'string'
              ? metadata.resetToken.trim()
              : payloadResetToken;
            const localResetToken = Storage.getSyncResetToken();

            const remoteHasOperationalData =
              (Array.isArray(payloadRecord.trips) && payloadRecord.trips.length > 0) ||
              (Array.isArray(payloadRecord.deletedTrips) && payloadRecord.deletedTrips.length > 0) ||
              (Array.isArray(payloadRecord.drivers) && payloadRecord.drivers.length > 0) ||
              (Array.isArray(payloadRecord.customers) && payloadRecord.customers.length > 0) ||
              (Array.isArray(payloadRecord.alerts) && payloadRecord.alerts.length > 0) ||
              (Array.isArray(payloadRecord.creditLedger) && payloadRecord.creditLedger.length > 0) ||
              (Array.isArray(payloadRecord.receipts) && payloadRecord.receipts.length > 0);

            if (remoteResetToken !== localResetToken) {
              const canAdoptRemoteReset = Boolean(remoteResetToken) && remoteSyncEpoch > localSyncEpoch;
              const targetResetToken = canAdoptRemoteReset
                ? remoteResetToken
                : (localResetToken || remoteResetToken);

              if (!targetResetToken) {
                console.warn('[cloud-sync] reset token mismatch without recoverable token; ignoring payload');
                return;
              }

              if (!canAdoptRemoteReset && remoteHasOperationalData) {
                console.warn('[cloud-sync] blocked stale payload that conflicts with local reset token');
              } else {
                console.warn('[cloud-sync] reset token mismatch; applying authoritative clear');
              }

              Storage.clearOperationalDataAtEpoch(Math.max(remoteSyncEpoch, localSyncEpoch), targetResetToken);
              refreshData();

              const healedPayload = Storage.getFullSystemData({ includeSettings: true });
              const healedSignature = createSyncSignature(healedPayload);
              const activeSession = cloudSyncSessionRef.current;
              if (activeSession && activeSession.isEnabled) {
                void activeSession.publish(healedPayload, healedSignature).then(ok => {
                  if (ok) {
                    lastSyncedSignatureRef.current = healedSignature;
                    console.info('[cloud-sync] acknowledged remote reset token');
                  }
                });
              }
              return;
            }

            if (remoteSyncEpoch > payloadSyncEpoch) {
              console.warn('[cloud-sync] remote sync epoch is ahead of payload epoch; enforcing clear-state recovery');
              if (remoteSyncEpoch > localSyncEpoch) {
                Storage.clearOperationalDataAtEpoch(remoteSyncEpoch);
                refreshData();
              }

              const healedPayload = Storage.getFullSystemData({ includeSettings: true });
              const healedSignature = createSyncSignature(healedPayload);
              const activeSession = cloudSyncSessionRef.current;
              if (activeSession && activeSession.isEnabled) {
                void activeSession.publish(healedPayload, healedSignature).then(ok => {
                  if (ok) {
                    lastSyncedSignatureRef.current = healedSignature;
                    console.info('[cloud-sync] recovered from stale payload overwrite');
                  }
                });
              }
              return;
            }

            if (remoteSyncEpoch < localSyncEpoch) {
              console.warn('[cloud-sync] ignored stale remote payload (older sync epoch)');
              const localPayload = Storage.getFullSystemData({ includeSettings: true });
              const localSignature = createSyncSignature(localPayload);
              const activeSession = cloudSyncSessionRef.current;
              if (activeSession && activeSession.isEnabled) {
                void activeSession.publish(localPayload, localSignature).then(ok => {
                  if (ok) {
                    lastSyncedSignatureRef.current = localSignature;
                    console.info('[cloud-sync] self-healed stale remote payload');
                  }
                });
              }
              return;
            }

            const remoteSignature = metadata.signature || createSyncSignature(payload);
            const localSignature = createSyncSignature(Storage.getFullSystemData({ includeSettings: true }));

            if (remoteSignature === localSignature) {
              lastSyncedSignatureRef.current = remoteSignature;
              return;
            }

            isApplyingRemoteRef.current = true;
            const restoreResult = Storage.restoreFullSystemData(payload, { mode: 'replace' });
            if (!restoreResult.ok) {
              console.warn('[cloud-sync] restore rejected', restoreResult.error || 'unknown restore error');
              isApplyingRemoteRef.current = false;
              return;
            }
            refreshData();
            isApplyingRemoteRef.current = false;
            lastSyncedSignatureRef.current = remoteSignature;
          } catch (error) {
            isApplyingRemoteRef.current = false;
            const message = error instanceof Error ? error.message : 'Unknown sync apply error';
            console.error('[cloud-sync] apply error', message);
          }
        },
      });

      if (stopped) {
        session.stop();
        return;
      }

      cloudSyncSessionRef.current = session;
      setCloudSyncSessionVersion(v => v + 1);

      if (session.isReady()) {
        setCloudSyncReady(true);
      }
    };

    initializeCloudSync();

    return () => {
      stopped = true;
      if (publishDebounceRef.current !== null) {
        clearTimeout(publishDebounceRef.current);
        publishDebounceRef.current = null;
      }
      cloudSyncSessionRef.current?.stop();
      cloudSyncSessionRef.current = null;
    };
  }, [refreshData]);

  useEffect(() => {
    const session = cloudSyncSessionRef.current;
    if (!cloudSyncReady || !session || !session.isEnabled) {
      return;
    }

    if (isApplyingRemoteRef.current) {
      return;
    }

    const payload = Storage.getFullSystemData({ includeSettings: true });
    const signature = createSyncSignature(payload);

    if (signature === lastSyncedSignatureRef.current) {
      return;
    }

    if (publishDebounceRef.current !== null) {
      clearTimeout(publishDebounceRef.current);
    }

    publishDebounceRef.current = window.setTimeout(async () => {
      const activeSession = cloudSyncSessionRef.current;
      if (!activeSession || !activeSession.isEnabled) {
        return;
      }

      const remoteSignatureResult = await fetchCloudSyncSignature();
      if (!remoteSignatureResult.ok || !remoteSignatureResult.signature) {
        if (remoteSignatureResult.code === 'no-remote-payload') {
          const bootstrapOk = await activeSession.publish(payload, signature);
          if (bootstrapOk) {
            lastSyncedSignatureRef.current = signature;
            console.info('[cloud-sync] bootstrap publish ok');
          } else {
            console.warn('[cloud-sync] bootstrap publish failed');
          }
          return;
        }

        console.warn('[cloud-sync] publish skipped (remote signature unavailable)');
        return;
      }

      const localSyncEpoch = typeof (payload as { syncEpoch?: unknown }).syncEpoch === 'number'
        ? Math.max(0, Math.floor((payload as { syncEpoch?: number }).syncEpoch || 0))
        : 0;
      const remoteSyncEpoch = typeof remoteSignatureResult.syncEpoch === 'number'
        ? Math.max(0, Math.floor(remoteSignatureResult.syncEpoch))
        : 0;
      const localResetToken = typeof (payload as { resetToken?: unknown }).resetToken === 'string'
        ? String((payload as { resetToken?: string }).resetToken || '').trim()
        : '';
      const remoteResetToken = typeof remoteSignatureResult.resetToken === 'string'
        ? remoteSignatureResult.resetToken.trim()
        : '';

      if (remoteResetToken && remoteResetToken !== localResetToken) {
        console.warn('[cloud-sync] publish skipped (remote reset token not acknowledged locally)');
        return;
      }

      const knownRemoteSignature = lastSyncedSignatureRef.current;
      if (knownRemoteSignature && remoteSignatureResult.signature !== knownRemoteSignature) {
        if (remoteSyncEpoch < localSyncEpoch) {
          console.info('[cloud-sync] remote epoch behind local, publishing authoritative local state');
        } else {
          console.warn('[cloud-sync] publish skipped (stale local state detected)');
          return;
        }
      }

      if (!knownRemoteSignature) {
        lastSyncedSignatureRef.current = remoteSignatureResult.signature;
        if (remoteSignatureResult.signature !== signature) {
          if (remoteSyncEpoch < localSyncEpoch) {
            console.info('[cloud-sync] remote epoch behind local, publishing authoritative local state');
          } else {
            console.warn('[cloud-sync] publish skipped (awaiting remote apply)');
            return;
          }
        }
      }

      if (remoteSyncEpoch > localSyncEpoch) {
        console.warn('[cloud-sync] publish skipped (stale local state detected)');
        return;
      }

      const ok = await activeSession.publish(payload, signature);
      if (ok) {
        lastSyncedSignatureRef.current = signature;
        console.info('[cloud-sync] publish ok');
      } else {
        console.warn('[cloud-sync] publish failed');
      }
    }, 700);
  }, [alerts, cloudSyncReady, cloudSyncSessionVersion, creditLedger, customers, deletedTrips, drivers, receipts, settings, trips]);

  useEffect(() => {
    Storage.saveAlerts(alerts);
  }, [alerts]);

  useEffect(() => {
    const checkAlerts = () => {
      const now = new Date();
      let changed = false;
      const dedupedCurrentAlerts = dedupeAlerts(alerts);

      if (dedupedCurrentAlerts.length !== alerts.length) {
        changed = true;
      }
      
      const updatedAlerts = dedupedCurrentAlerts.map(alert => {
        if (!alert.triggered && isAfter(now, parseISO(alert.targetTime))) {
          const signature = alertSignature(alert);
          const lastNotifiedAt = notificationCooldownRef.current[signature] || 0;
          const withinCooldown = now.getTime() - lastNotifiedAt < ALERT_NOTIFICATION_COOLDOWN_MS;

          if (!withinCooldown) {
            triggerNotification(alert);
            notificationCooldownRef.current[signature] = now.getTime();
          }

          if (alert.snoozedUntil) {
            changed = true;
            return { ...alert, snoozedUntil: undefined };
          }

          return alert;
        }
        return alert;
      });

      const newRefuelAlerts: MissionAlert[] = [];
      drivers.forEach(driver => {
        if (driver.status !== 'ACTIVE') return;

        const driverTrips = trips.filter(t => t.driverId === driver.id && t.status === TripStatus.COMPLETED);
        const missionDistance = driverTrips.reduce((acc, t) => acc + t.distanceKm, 0);
        const totalOdometer = driver.baseMileage + missionDistance;
        const refuelBaseline = driver.lastRefuelKm ?? driver.baseMileage ?? 0;
        const kmSinceRefuel = Math.max(0, totalOdometer - refuelBaseline);
        const fuelRange = Math.max(1, driver.fuelRangeKm || 500);
        const fuelRemainingPercent = Math.max(0, Math.min(100, (1 - (kmSinceRefuel / fuelRange)) * 100));

        const hasExistingAlert = updatedAlerts.some(a => a.driverId === driver.id && a.type === 'REFUEL');
        
        if (fuelRemainingPercent < 15 && !hasExistingAlert) {
          const alert: MissionAlert = {
            id: `refuel-${driver.id}`,
            driverId: driver.id,
            type: 'REFUEL',
            targetTime: now.toISOString(),
            label: `Low Fuel Alert (${Math.round(fuelRemainingPercent)}%)`,
            triggered: false,
            driverName: driver.name
          };
          newRefuelAlerts.push(alert);
          changed = true;
        }
      });

      if (changed) {
        setAlerts(dedupeAlerts([...updatedAlerts, ...newRefuelAlerts]));
      }
    };

    const interval = setInterval(checkAlerts, 15000);
    return () => clearInterval(interval);
  }, [alerts, drivers, trips]);

  const triggerNotification = (alert: MissionAlert) => {
    const title = alert.type === 'REFUEL' 
      ? `FUEL ADVISORY: ${alert.driverName}`
      : `MISSION UPDATE: ${alert.customerName}`;
      
    const body = alert.type === 'REFUEL'
      ? `${alert.label}. Unit ${alert.driverName} requires immediate refueling.`
      : `${alert.label} check required for Trip #${alert.tripId}`;
    
    if (!('Notification' in window)) return;

    if (Notification.permission === 'granted') {
      new Notification(title, { body, icon: '/favicon.svg' });
      return;
    }

    if (Notification.permission === 'default') {
      Notification.requestPermission().then(permission => {
        if (permission === 'granted') {
          new Notification(title, { body, icon: '/favicon.svg' });
        }
      });
    }
  };

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
  };

  const buildMissionAlerts = (trip: Trip): MissionAlert[] => {
    if (trip.status === TripStatus.CANCELLED || trip.status === TripStatus.COMPLETED) {
      return [];
    }

    const tripAnchor = parseISO(trip.tripDate || trip.createdAt);
    const startTime = Number.isNaN(tripAnchor.getTime()) ? parseISO(trip.createdAt) : tripAnchor;
    const eta = addMinutes(startTime, trip.durationInTrafficMin || trip.durationMin);

    return [
      {
        id: `pickup-${trip.id}`,
        tripId: trip.id,
        type: 'PICKUP',
        targetTime: startTime.toISOString(),
        label: 'Pickup Due',
        triggered: false,
        customerName: trip.customerName,
      },
      {
        id: `dropoff-${trip.id}`,
        tripId: trip.id,
        type: 'DROP_OFF',
        targetTime: eta.toISOString(),
        label: 'Arrival Check',
        triggered: false,
        customerName: trip.customerName,
      }
    ];
  };

  const scheduleMissionAlerts = (trip: Trip) => {
    const scheduledAlerts = buildMissionAlerts(trip);
    setAlerts(prev => {
      const retained = prev.filter(a => !(a.tripId === trip.id && (a.type === 'PICKUP' || a.type === 'DROP_OFF')));
      return [...retained, ...scheduledAlerts];
    });
  };

  useEffect(() => {
    if (trips.length === 0) {
      setAlerts(prev => {
        const filtered = prev.filter(alert => alert.type !== 'PICKUP' && alert.type !== 'DROP_OFF');
        return filtered.length === prev.length ? prev : filtered;
      });
      return;
    }

    const generatedMissionAlerts = trips
      .filter(trip => trip.status !== TripStatus.CANCELLED && trip.status !== TripStatus.COMPLETED)
      .flatMap(trip => buildMissionAlerts(trip));

    setAlerts(prev => {
      const existingMissionById = new Map(
        prev
          .filter(alert => alert.type === 'PICKUP' || alert.type === 'DROP_OFF')
          .map(alert => [alert.id, alert] as const)
      );

      const nextMissionAlerts = generatedMissionAlerts.map(alert => {
        const existing = existingMissionById.get(alert.id);
        if (!existing) return alert;

        const existingTarget = parseISO(existing.targetTime);
        const generatedTarget = parseISO(alert.targetTime);
        const keepSnoozedTarget =
          !existing.triggered &&
          Number.isFinite(existingTarget.getTime()) &&
          Number.isFinite(generatedTarget.getTime()) &&
          existingTarget.getTime() > generatedTarget.getTime();

        return {
          ...alert,
          targetTime: keepSnoozedTarget ? existing.targetTime : alert.targetTime,
          snoozedUntil: keepSnoozedTarget
            ? (existing.snoozedUntil || existing.targetTime)
            : undefined,
          triggered: existing.triggered,
        };
      });

      const nonMissionAlerts = prev.filter(alert => alert.type !== 'PICKUP' && alert.type !== 'DROP_OFF');
      const nextAlerts = [...nonMissionAlerts, ...nextMissionAlerts];

      const prevSignature = prev
        .map(alert => `${alert.id}|${alert.targetTime}|${alert.snoozedUntil || ''}|${Number(alert.triggered)}`)
        .sort()
        .join('||');
      const nextSignature = nextAlerts
        .map(alert => `${alert.id}|${alert.targetTime}|${alert.snoozedUntil || ''}|${Number(alert.triggered)}`)
        .sort()
        .join('||');

      return prevSignature === nextSignature ? prev : nextAlerts;
    });
  }, [trips]);

  const dismissAlert = (id: string) => {
    setAlerts(prev => prev.filter(a => a.id !== id));
  };

  const snoozeAlert = (id: string, minutes: number = 10) => {
    const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 10;

    setAlerts(prev => prev.map(alert => {
      if (alert.id !== id) return alert;

      const nowMs = Date.now();
      const currentTargetMs = new Date(alert.targetTime).getTime();
      const baseMs = Number.isFinite(currentTargetMs) ? Math.max(currentTargetMs, nowMs) : nowMs;
      const nextTarget = new Date(baseMs + safeMinutes * 60 * 1000).toISOString();

      return {
        ...alert,
        triggered: false,
        targetTime: nextTarget,
        snoozedUntil: nextTarget,
      };
    }));
  };

  const resolveAlert = (id: string) => {
    setAlerts(prev => prev.map(alert => {
      if (alert.id !== id) return alert;
      return {
        ...alert,
        triggered: true,
        snoozedUntil: undefined,
      };
    }));
  };

  type FinanceEnrichmentPayload = {
    partyType: CreditPartyType;
    partyId?: string;
    partyName: string;
    timestamp: string;
    note: string;
    eventId: string;
    tripId?: number;
  };

  const appendProfileEvent = (existing: CustomerProfileEvent[] | undefined, event: CustomerProfileEvent): CustomerProfileEvent[] => {
    const timeline = Array.isArray(existing) ? [...existing] : [];
    const duplicate = timeline.some(item => item.id === event.id);
    if (duplicate) return timeline;
    return [event, ...timeline].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  };

  const enrichFinanceContext = ({ partyType, partyId, partyName, timestamp, note, eventId, tripId }: FinanceEnrichmentPayload) => {
    const event: CustomerProfileEvent = {
      id: eventId,
      timestamp,
      source: 'MANUAL',
      note,
      ...(typeof tripId === 'number' ? { tripId } : {}),
    };

    if (partyType === 'CLIENT') {
      const normalizedPartyId = customerPhoneKey(partyId || '');
      const target = customers.find(entry => {
        if (normalizedPartyId && customerPhoneKey(entry.phone) === normalizedPartyId) return true;
        return entry.name.trim().toLowerCase() === partyName.trim().toLowerCase();
      });

      if (!target) return;

      addCustomers([
        {
          id: target.id,
          name: target.name,
          phone: target.phone,
          source: target.source,
          createdAt: target.createdAt,
          profileTimeline: appendProfileEvent(target.profileTimeline, event),
          lastEnrichedAt: timestamp,
        },
      ]);
      return;
    }

    const targetDriver = drivers.find(entry => {
      if (partyId && entry.id === partyId) return true;
      return entry.name.trim().toLowerCase() === partyName.trim().toLowerCase();
    });

    if (!targetDriver) return;

    const updatedDriver: Driver = {
      ...targetDriver,
      profileTimeline: appendProfileEvent(targetDriver.profileTimeline, event),
      lastEnrichedAt: timestamp,
    };

    const nextDrivers = Storage.saveDriver(updatedDriver);
    setDrivers(nextDrivers);
  };

  const addTrip = (tripData: Omit<Trip, 'id' | 'createdAt'>) => {
    const normalizedPaymentMode: TripPaymentMode = tripData.paymentMode === 'CREDIT' ? 'CREDIT' : 'CASH';
    const normalizedSettlementStatus: TripSettlementStatus = tripData.settlementStatus || 'PENDING';
    const newTrip: Trip = {
      ...tripData,
      paymentMode: normalizedPaymentMode,
      settlementStatus: normalizedSettlementStatus,
      id: Date.now(),
      createdAt: new Date().toISOString(),
    };

    const normalizedPhone = customerPhoneKey(tripData.customerPhone);
    const existingCustomer = customers.find(c => customerPhoneKey(c.phone) === normalizedPhone);
    const shouldAppendTripNote = Boolean(newTrip.notes?.trim());
    const existingDefaultPaymentMode: TripPaymentMode = existingCustomer?.defaultPaymentMode === 'CREDIT' ? 'CREDIT' : 'CASH';
    const shouldSyncCustomerPaymentPreference = Boolean(existingCustomer && existingDefaultPaymentMode !== normalizedPaymentMode);
    const tripCustomer = buildCustomerFromTrip(newTrip, { includeTimelineEvent: shouldAppendTripNote });

    if (!existingCustomer) {
      addCustomers([tripCustomer]);
    } else if (shouldAppendTripNote || existingCustomer.name !== newTrip.customerName || shouldSyncCustomerPaymentPreference) {
      addCustomers([tripCustomer]);
    }

    const updated = Storage.saveDispatch('trip', newTrip) as Trip[];
    setTrips(updated);
    scheduleMissionAlerts(newTrip);
  };

  const updateTripField = (id: number, field: keyof Trip, value: Trip[keyof Trip]) => {
    const trip = trips.find(t => t.id === id);
    if (trip) {
      const updatedTrip = { ...trip, [field]: value };
      const updatedList = Storage.updateTrip(updatedTrip);
      setTrips(updatedList);
    }
  };

  const updateFullTrip = (trip: Trip) => {
    const previousTrip = trips.find(t => t.id === trip.id);
    const nowIso = new Date().toISOString();
    const normalizedPaymentMode: TripPaymentMode = trip.paymentMode === 'CREDIT' ? 'CREDIT' : 'CASH';
    const transitionedToCompleted = previousTrip?.status !== TripStatus.COMPLETED && trip.status === TripStatus.COMPLETED;
    const reopenedFromCompleted = previousTrip?.status === TripStatus.COMPLETED && trip.status !== TripStatus.COMPLETED;
    let nextTrip: Trip = {
      ...trip,
      paymentMode: normalizedPaymentMode,
      settlementStatus: trip.settlementStatus || 'PENDING',
    };

    if (transitionedToCompleted) {
      nextTrip = {
        ...nextTrip,
        completedAt: nextTrip.completedAt || nowIso,
      };
    }

    if (reopenedFromCompleted) {
      nextTrip = {
        ...nextTrip,
        completedAt: undefined,
      };
    }

    let nextLedger = creditLedger;
    let nextReceipts = receipts;
    const financeEnrichmentQueue: FinanceEnrichmentPayload[] = [];

    const buildReceiptNumber = (partyType: CreditPartyType, cycle: CreditCycle, issuedAtIso: string): string => {
      const issuedAt = new Date(issuedAtIso);
      const year = issuedAt.getFullYear();
      const periodLabel = cycle === 'MONTHLY'
        ? `${year}-${String(issuedAt.getMonth() + 1).padStart(2, '0')}`
        : (() => {
            const start = new Date(Date.UTC(issuedAt.getFullYear(), issuedAt.getMonth(), issuedAt.getDate()));
            start.setUTCDate(start.getUTCDate() + 4 - (start.getUTCDay() || 7));
            const isoYear = start.getUTCFullYear();
            const yearStart = new Date(Date.UTC(isoYear, 0, 1));
            const week = Math.ceil((((start.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
            return `${isoYear}-W${String(week).padStart(2, '0')}`;
          })();

      const receiptPrefix = `${partyType}-${cycle}-${periodLabel}`;
      const existingForPeriod = nextReceipts.filter(item => item.receiptNumber.startsWith(receiptPrefix)).length;
      return `${receiptPrefix}-${String(existingForPeriod + 1).padStart(3, '0')}`;
    };

    if (nextTrip.status === TripStatus.COMPLETED && normalizedPaymentMode === 'CREDIT' && !nextTrip.creditLedgerEntryId) {
      const rawTripDate = nextTrip.tripDate || nextTrip.createdAt;
      const tripDate = new Date(rawTripDate);
      const dueDateIso = Number.isFinite(tripDate.getTime())
        ? new Date(tripDate.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
        : undefined;

      const entry: CreditLedgerEntry = {
        id: `credit-trip-${nextTrip.id}-${Math.random().toString(36).slice(2, 8)}`,
        partyType: 'CLIENT',
        partyId: customerPhoneKey(nextTrip.customerPhone) || undefined,
        partyName: nextTrip.customerName,
        cycle: 'WEEKLY',
        amountUsd: Math.max(0, Number(nextTrip.fareUsd) || 0),
        ...(dueDateIso ? { dueDate: dueDateIso } : {}),
        notes: `Auto-linked from trip #${nextTrip.id}`,
        status: 'OPEN',
        createdAt: nowIso,
      };

      nextLedger = [entry, ...nextLedger];
      nextTrip = {
        ...nextTrip,
        creditLedgerEntryId: entry.id,
      };

      financeEnrichmentQueue.push({
        partyType: 'CLIENT',
        partyId: entry.partyId,
        partyName: entry.partyName,
        timestamp: entry.createdAt,
        note: `Credit opened: $${entry.amountUsd.toFixed(2)} (${entry.cycle}) · Trip #${nextTrip.id}`,
        eventId: `finance-credit-open-${entry.id}`,
        tripId: nextTrip.id,
      });
    }

    if (nextTrip.status === TripStatus.COMPLETED && normalizedPaymentMode === 'CASH' && nextTrip.settlementStatus === 'PENDING') {
      nextTrip = {
        ...nextTrip,
        settlementStatus: 'SETTLED',
        settledAt: nextTrip.settledAt || nowIso,
      };

      financeEnrichmentQueue.push({
        partyType: 'CLIENT',
        partyId: customerPhoneKey(nextTrip.customerPhone),
        partyName: nextTrip.customerName,
        timestamp: nextTrip.settledAt || nowIso,
        note: `Cash settled: $${Math.max(0, Number(nextTrip.fareUsd) || 0).toFixed(2)} · Trip #${nextTrip.id}`,
        eventId: `finance-cash-settled-trip-${nextTrip.id}`,
        tripId: nextTrip.id,
      });
    }

    if (nextTrip.settlementStatus === 'SETTLED' && !nextTrip.settledAt) {
      nextTrip = {
        ...nextTrip,
        settledAt: nowIso,
      };
    }

    if (nextTrip.settlementStatus === 'RECEIPTED' && !nextTrip.receiptId) {
      const issueAtIso = nowIso;

      if (normalizedPaymentMode === 'CREDIT' && nextTrip.creditLedgerEntryId) {
        const linkedEntry = nextLedger.find(item => item.id === nextTrip.creditLedgerEntryId);
        if (linkedEntry) {
          if (linkedEntry.status === 'PAID' && linkedEntry.receiptId) {
            nextTrip = {
              ...nextTrip,
              receiptId: linkedEntry.receiptId,
              settledAt: linkedEntry.paidAt || issueAtIso,
            };
          } else {
            const receipt: ReceiptRecord = {
              id: `receipt-trip-${nextTrip.id}-${Math.random().toString(36).slice(2, 8)}`,
              receiptNumber: buildReceiptNumber(linkedEntry.partyType, linkedEntry.cycle, issueAtIso),
              ledgerEntryId: linkedEntry.id,
              issuedAt: issueAtIso,
              partyType: linkedEntry.partyType,
              ...(linkedEntry.partyId ? { partyId: linkedEntry.partyId } : {}),
              partyName: linkedEntry.partyName,
              cycle: linkedEntry.cycle,
              amountUsd: linkedEntry.amountUsd,
              ...(linkedEntry.notes ? { notes: linkedEntry.notes } : {}),
            };

            nextLedger = nextLedger.map(item =>
              item.id === linkedEntry.id
                ? {
                    ...item,
                    status: 'PAID' as const,
                    paidAt: receipt.issuedAt,
                    receiptId: receipt.id,
                  }
                : item
            );
            nextReceipts = [receipt, ...nextReceipts];
            nextTrip = {
              ...nextTrip,
              receiptId: receipt.id,
              settledAt: receipt.issuedAt,
            };

            financeEnrichmentQueue.push({
              partyType: linkedEntry.partyType,
              partyId: linkedEntry.partyId,
              partyName: linkedEntry.partyName,
              timestamp: receipt.issuedAt,
              note: `Receipt issued: #${receipt.receiptNumber} · $${receipt.amountUsd.toFixed(2)} (${receipt.cycle})`,
              eventId: `finance-receipt-${receipt.id}`,
              tripId: nextTrip.id,
            });
          }
        }
      }

      if (!nextTrip.receiptId) {
        const receipt: ReceiptRecord = {
          id: `receipt-trip-${nextTrip.id}-${Math.random().toString(36).slice(2, 8)}`,
          receiptNumber: buildReceiptNumber('CLIENT', 'WEEKLY', issueAtIso),
          ledgerEntryId: nextTrip.creditLedgerEntryId || `trip-${nextTrip.id}-cash`,
          issuedAt: issueAtIso,
          partyType: 'CLIENT',
          partyId: customerPhoneKey(nextTrip.customerPhone),
          partyName: nextTrip.customerName,
          cycle: 'WEEKLY',
          amountUsd: Math.max(0, Number(nextTrip.fareUsd) || 0),
          notes: `Trip #${nextTrip.id}`,
        };
        nextReceipts = [receipt, ...nextReceipts];
        nextTrip = {
          ...nextTrip,
          receiptId: receipt.id,
          settledAt: receipt.issuedAt,
        };

        financeEnrichmentQueue.push({
          partyType: 'CLIENT',
          partyId: receipt.partyId,
          partyName: receipt.partyName,
          timestamp: receipt.issuedAt,
          note: `Receipt issued: #${receipt.receiptNumber} · $${receipt.amountUsd.toFixed(2)} (${receipt.cycle})`,
          eventId: `finance-receipt-${receipt.id}`,
          tripId: nextTrip.id,
        });
      }
    }

    if (
      nextTrip.settlementStatus === 'SETTLED' &&
      previousTrip?.settlementStatus !== 'SETTLED' &&
      normalizedPaymentMode === 'CASH'
    ) {
      financeEnrichmentQueue.push({
        partyType: 'CLIENT',
        partyId: customerPhoneKey(nextTrip.customerPhone),
        partyName: nextTrip.customerName,
        timestamp: nextTrip.settledAt || nowIso,
        note: `Cash settled: $${Math.max(0, Number(nextTrip.fareUsd) || 0).toFixed(2)} · Trip #${nextTrip.id}`,
        eventId: `finance-cash-settled-trip-${nextTrip.id}`,
        tripId: nextTrip.id,
      });
    }

    if (nextLedger !== creditLedger) {
      Storage.saveCreditLedger(nextLedger);
      setCreditLedger(nextLedger);
    }

    if (nextReceipts !== receipts) {
      Storage.saveReceipts(nextReceipts);
      setReceipts(nextReceipts);
    }

    const updatedList = Storage.updateTrip(nextTrip);
    setTrips([...updatedList]); // Deep copy to trigger redraws across components

    const currentNote = nextTrip.notes?.trim() || '';
    const previousNote = previousTrip?.notes?.trim() || '';
    const includeTimelineEvent = currentNote.length > 0 && currentNote !== previousNote;
    const customerPatch = buildCustomerFromTrip(nextTrip, { includeTimelineEvent });
    addCustomers([customerPatch]);

    financeEnrichmentQueue.forEach(enrichment => {
      enrichFinanceContext(enrichment);
    });

    scheduleMissionAlerts(nextTrip);
  };

  const deleteCancelledTrip = (id: number) => {
    const existing = trips.find(t => t.id === id);
    if (!existing) {
      return { ok: false, reason: 'Trip not found.' };
    }

    if (existing.status !== TripStatus.CANCELLED) {
      return { ok: false, reason: 'Only cancelled trips can be deleted.' };
    }

    const nextState = Storage.archiveCancelledTrip(id);
    setTrips(nextState.trips);
    setDeletedTrips(nextState.deletedTrips);
    setAlerts(prev => prev.filter(a => a.tripId !== id));
    return { ok: true };
  };

  const restoreDeletedTrip = (archiveId: string) => {
    const existing = deletedTrips.find(record => record.archiveId === archiveId);
    if (!existing) {
      return { ok: false, reason: 'Archived trip not found.' };
    }

    const nextState = Storage.restoreDeletedTrip(archiveId);
    setTrips(nextState.trips);
    setDeletedTrips(nextState.deletedTrips);
    scheduleMissionAlerts(existing.trip);
    return { ok: true };
  };

  const addCustomers = (newBatch: Customer[]) => {
    const existing = Storage.getCustomers();
    const merged = mergeCustomerCollections(existing, newBatch).customers;
    Storage.saveDispatch('customers', merged);
    setCustomers(merged);
  };

  const addCreditLedgerEntry = (payload: {
    partyType: CreditPartyType;
    partyName: string;
    cycle: CreditCycle;
    amountUsd: number;
    partyId?: string;
    dueDate?: string;
    notes?: string;
  }): { ok: boolean; reason?: string; entry?: CreditLedgerEntry } => {
    const safeAmount = Number(payload.amountUsd);
    if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
      return { ok: false, reason: 'Amount must be greater than zero.' };
    }

    const safeName = String(payload.partyName || '').trim();
    if (!safeName) {
      return { ok: false, reason: 'Party name is required.' };
    }

    const entry: CreditLedgerEntry = {
      id: `credit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      partyType: payload.partyType,
      partyName: safeName,
      cycle: payload.cycle,
      amountUsd: Math.max(0, safeAmount),
      ...(payload.partyId ? { partyId: payload.partyId } : {}),
      ...(payload.dueDate ? { dueDate: payload.dueDate } : {}),
      ...(payload.notes ? { notes: payload.notes } : {}),
      status: 'OPEN',
      createdAt: new Date().toISOString(),
    };

    const nextLedger = [entry, ...creditLedger];
    Storage.saveCreditLedger(nextLedger);
    setCreditLedger(nextLedger);

    enrichFinanceContext({
      partyType: entry.partyType,
      partyId: entry.partyId,
      partyName: entry.partyName,
      timestamp: entry.createdAt,
      note: `Credit opened: $${entry.amountUsd.toFixed(2)} (${entry.cycle})`,
      eventId: `finance-credit-open-${entry.id}`,
    });

    return { ok: true, entry };
  };

  const settleCreditLedgerEntry = (entryId: string): { ok: boolean; reason?: string; receipt?: ReceiptRecord } => {
    const current = creditLedger.find(item => item.id === entryId);
    if (!current) {
      return { ok: false, reason: 'Ledger entry not found.' };
    }

    if (current.status === 'PAID') {
      return { ok: false, reason: 'Entry is already settled.' };
    }

    const issuedAt = new Date();
    const year = issuedAt.getFullYear();
    const periodLabel = current.cycle === 'MONTHLY'
      ? `${year}-${String(issuedAt.getMonth() + 1).padStart(2, '0')}`
      : (() => {
          const start = new Date(Date.UTC(issuedAt.getFullYear(), issuedAt.getMonth(), issuedAt.getDate()));
          start.setUTCDate(start.getUTCDate() + 4 - (start.getUTCDay() || 7));
          const isoYear = start.getUTCFullYear();
          const yearStart = new Date(Date.UTC(isoYear, 0, 1));
          const week = Math.ceil((((start.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
          return `${isoYear}-W${String(week).padStart(2, '0')}`;
        })();

    const receiptPrefix = `${current.partyType}-${current.cycle}-${periodLabel}`;
    const existingForPeriod = receipts.filter(item => item.receiptNumber.startsWith(receiptPrefix)).length;
    const receiptNumber = `${receiptPrefix}-${String(existingForPeriod + 1).padStart(3, '0')}`;

    const receipt: ReceiptRecord = {
      id: `receipt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      receiptNumber,
      ledgerEntryId: current.id,
      issuedAt: issuedAt.toISOString(),
      partyType: current.partyType,
      ...(current.partyId ? { partyId: current.partyId } : {}),
      partyName: current.partyName,
      cycle: current.cycle,
      amountUsd: current.amountUsd,
      ...(current.notes ? { notes: current.notes } : {}),
    };

    const nextLedger = creditLedger.map(item =>
      item.id === current.id
        ? {
            ...item,
            status: 'PAID' as const,
            paidAt: receipt.issuedAt,
            receiptId: receipt.id,
          }
        : item
    );
    const nextReceipts = [receipt, ...receipts];

    Storage.saveCreditLedger(nextLedger);
    Storage.saveReceipts(nextReceipts);
    setCreditLedger(nextLedger);
    setReceipts(nextReceipts);

    enrichFinanceContext({
      partyType: current.partyType,
      partyId: current.partyId,
      partyName: current.partyName,
      timestamp: receipt.issuedAt,
      note: `Receipt issued: #${receipt.receiptNumber} · $${receipt.amountUsd.toFixed(2)} (${receipt.cycle})`,
      eventId: `finance-receipt-${receipt.id}`,
    });

    return { ok: true, receipt };
  };

  const removeCustomerByPhone = (phone: string): { ok: boolean; reason?: string } => {
    const normalized = customerPhoneKey(phone);
    if (!normalized) {
      return { ok: false, reason: 'Invalid customer phone.' };
    }

    const hasTripHistory = trips.some(trip => customerPhoneKey(trip.customerPhone) === normalized);
    if (hasTripHistory) {
      return { ok: false, reason: 'Cannot remove customer with trip history from CRM directory.' };
    }

    const nextCustomers = customers.filter(entry => customerPhoneKey(entry.phone) !== normalized);
    Storage.saveCustomers(nextCustomers);
    setCustomers(nextCustomers);
    return { ok: true };
  };

  const addDriver = (driver: Driver) => {
    const updated = Storage.saveDispatch('driver', driver) as Driver[];
    setDrivers(updated);
  };

  const editDriver = (driver: Driver) => {
    const updated = Storage.saveDispatch('driver', driver) as Driver[];
    setDrivers(updated);
    
    // Check if a refueling clearing event occurred
    if (driver.lastRefuelKm) {
       setAlerts(prev => prev.filter(a => !(a.driverId === driver.id && a.type === 'REFUEL')));
    }
  };

  const removeDriver = (id: string) => {
    const updated = Storage.deleteDriver(id);
    setDrivers(updated);
  };

  const updateSettings = (newSettings: Settings) => {
    Storage.saveSettings(newSettings);
    setSettings(newSettings);
  };

  const forceCloudSyncPublish = async (): Promise<{ ok: boolean; reason?: string }> => {
    const session = cloudSyncSessionRef.current;
    if (!session || !session.isEnabled) {
      return { ok: false, reason: 'Cloud sync is not enabled on this device.' };
    }

    const payload = Storage.getFullSystemData({ includeSettings: true });
    const signature = createSyncSignature(payload);
    const ok = await session.publish(payload, signature);

    if (!ok) {
      return { ok: false, reason: 'Cloud publish failed.' };
    }

    lastSyncedSignatureRef.current = signature;
    return { ok: true };
  };

  const hardResetCloudSync = async (): Promise<{ ok: boolean; nextDocId?: string; reason?: string }> => {
    try {
      if (publishDebounceRef.current !== null) {
        clearTimeout(publishDebounceRef.current);
        publishDebounceRef.current = null;
      }

      const currentDocId = getCloudSyncDocId();

      Storage.clearOperationalData();
      refreshData();

      const session = cloudSyncSessionRef.current;
      if (!session || !session.isEnabled) {
        return { ok: false, reason: 'Cloud sync is not enabled on this device.' };
      }

      const payload = Storage.getFullSystemData({ includeSettings: true });
      const signature = createSyncSignature(payload);
      const ok = await session.publish(payload, signature);
      if (!ok) {
        return { ok: false, reason: 'Cloud publish failed after reset.' };
      }

      lastSyncedSignatureRef.current = signature;

      return { ok: true, nextDocId: currentDocId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Hard reset failed.';
      return { ok: false, reason };
    }
  };

  return (
    <StoreContext.Provider value={{ 
      trips, deletedTrips, drivers, customers, creditLedger, receipts, settings, alerts, theme, toggleTheme,
      addTrip, updateTripField, updateFullTrip, deleteCancelledTrip, restoreDeletedTrip, dismissAlert, snoozeAlert, resolveAlert,
      addCustomers, removeCustomerByPhone, addCreditLedgerEntry, settleCreditLedgerEntry, addDriver, editDriver, removeDriver, updateSettings, refreshData, forceCloudSyncPublish, hardResetCloudSync 
    }}>
      {children}
    </StoreContext.Provider>
  );
};

export const useStore = () => {
  const context = useContext(StoreContext);
  if (!context) throw new Error('useStore must be used within a StoreProvider');
  return context;
};
