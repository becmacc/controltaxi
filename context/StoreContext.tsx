
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Trip, Settings, Driver, Customer, MissionAlert, TripStatus, DeletedTripRecord } from '../types';
import * as Storage from '../services/storageService';
import { addMinutes, parseISO, isAfter } from 'date-fns';
import { buildCustomerFromTrip, customerPhoneKey, mergeCustomerCollections } from '../services/customerProfile';
import {
  CloudSyncSession,
  createSyncSignature,
  fetchCloudSyncSignature,
  getCloudSyncDocId,
  getOrCreateCloudSyncClientId,
  rotateCloudSyncDocId,
  startCloudSync,
} from '../services/cloudSyncService';

interface StoreContextType {
  trips: Trip[];
  deletedTrips: DeletedTripRecord[];
  drivers: Driver[];
  customers: Customer[];
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
              (Array.isArray(payloadRecord.alerts) && payloadRecord.alerts.length > 0);

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
  }, [alerts, cloudSyncReady, cloudSyncSessionVersion, customers, deletedTrips, drivers, settings, trips]);

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
      
      let updatedAlerts = dedupedCurrentAlerts.map(alert => {
        if (!alert.triggered && isAfter(now, parseISO(alert.targetTime))) {
          const signature = alertSignature(alert);
          const lastNotifiedAt = notificationCooldownRef.current[signature] || 0;
          const withinCooldown = now.getTime() - lastNotifiedAt < ALERT_NOTIFICATION_COOLDOWN_MS;

          if (!withinCooldown) {
            triggerNotification(alert);
            notificationCooldownRef.current[signature] = now.getTime();
          }

          changed = true;
          return { ...alert, triggered: true, snoozedUntil: undefined };
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
    if (trips.length === 0) return;

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

  const addTrip = (tripData: Omit<Trip, 'id' | 'createdAt'>) => {
    const newTrip: Trip = {
      ...tripData,
      id: Date.now(),
      createdAt: new Date().toISOString(),
    };

    const normalizedPhone = customerPhoneKey(tripData.customerPhone);
    const existingCustomer = customers.find(c => customerPhoneKey(c.phone) === normalizedPhone);
    const shouldAppendTripNote = Boolean(newTrip.notes?.trim());
    const tripCustomer = buildCustomerFromTrip(newTrip, { includeTimelineEvent: shouldAppendTripNote });

    if (!existingCustomer) {
      addCustomers([tripCustomer]);
    } else if (shouldAppendTripNote || existingCustomer.name !== newTrip.customerName) {
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
    const updatedList = Storage.updateTrip(trip);
    setTrips([...updatedList]); // Deep copy to trigger redraws across components

    const currentNote = trip.notes?.trim() || '';
    const previousNote = previousTrip?.notes?.trim() || '';
    const includeTimelineEvent = currentNote.length > 0 && currentNote !== previousNote;
    const customerPatch = buildCustomerFromTrip(trip, { includeTimelineEvent });
    addCustomers([customerPatch]);

    scheduleMissionAlerts(trip);
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

      cloudSyncSessionRef.current?.stop();
      cloudSyncSessionRef.current = null;
      setCloudSyncReady(false);

      const currentDocId = getCloudSyncDocId();
      const baseDocId = currentDocId.replace(/-\d+$/, '') || 'shared';
      const nextDocId = rotateCloudSyncDocId(baseDocId);

      Storage.clearOperationalData();
      refreshData();
      lastSyncedSignatureRef.current = null;

      return { ok: true, nextDocId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Hard reset failed.';
      return { ok: false, reason };
    }
  };

  return (
    <StoreContext.Provider value={{ 
      trips, deletedTrips, drivers, customers, settings, alerts, theme, toggleTheme,
      addTrip, updateTripField, updateFullTrip, deleteCancelledTrip, restoreDeletedTrip, dismissAlert, snoozeAlert, resolveAlert,
      addCustomers, addDriver, editDriver, removeDriver, updateSettings, refreshData, forceCloudSyncPublish, hardResetCloudSync 
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
