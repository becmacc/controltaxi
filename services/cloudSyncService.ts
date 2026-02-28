import { initializeApp, getApp, getApps } from 'firebase/app';
import { AuthError, getAuth, signInAnonymously } from 'firebase/auth';
import { doc, getDoc, getFirestore, serverTimestamp, setDoc } from 'firebase/firestore';

type SyncStatus = 'disabled' | 'connecting' | 'ready' | 'error';

interface StartCloudSyncOptions {
  clientId: string;
  onRemoteData: (payload: unknown, metadata: { updatedBy?: string; signature?: string; syncEpoch?: number; channel?: string }) => void;
  onStatusChange?: (status: SyncStatus, message?: string) => void;
}

export interface CloudSyncSession {
  isEnabled: boolean;
  isReady: () => boolean;
  publish: (payload: unknown, signature: string) => Promise<boolean>;
  stop: () => void;
}

export interface CloudSyncSignatureFetchResult {
  ok: boolean;
  signature?: string;
  syncEpoch?: number;
  reason?: string;
}

const SYNC_CLIENT_ID_KEY = '__control_sync_client_id__';
const CLOUD_COLLECTION = import.meta.env.VITE_FIREBASE_SYNC_COLLECTION || 'control-sync';
const CLOUD_DOC_ID = import.meta.env.VITE_FIREBASE_SYNC_DOC_ID || 'shared';
const POLL_INTERVAL_MS = 3000;

const getFirebaseConfig = () => ({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
});

const hasRequiredFirebaseConfig = () => {
  const cfg = getFirebaseConfig();
  return Boolean(
    cfg.apiKey &&
      cfg.authDomain &&
      cfg.projectId &&
      cfg.storageBucket &&
      cfg.messagingSenderId &&
      cfg.appId
  );
};

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isPermissionDeniedError = (error: unknown) => {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  return code === 'permission-denied';
};

const buildPermissionHint = (path: string) =>
  `permission-denied path=${path} (Check Firestore rules on /control-sync/{docId}, Anonymous Auth enabled, and Firestore App Check enforcement).`;

export const isCloudSyncConfigured = () => hasRequiredFirebaseConfig() && Boolean(CLOUD_DOC_ID);

export const getOrCreateCloudSyncClientId = () => {
  const existing = localStorage.getItem(SYNC_CLIENT_ID_KEY);
  if (existing) return existing;

  const created = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(SYNC_CLIENT_ID_KEY, created);
  return created;
};

export const createSyncSignature = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') return '{}';
  const record = payload as Record<string, unknown>;
  const syncEpoch = typeof record.syncEpoch === 'number' && Number.isFinite(record.syncEpoch)
    ? Math.max(0, Math.floor(record.syncEpoch))
    : 0;

  return JSON.stringify({
    version: typeof record.version === 'string' ? record.version : '0',
    syncEpoch,
    trips: Array.isArray(record.trips) ? record.trips : [],
    drivers: Array.isArray(record.drivers) ? record.drivers : [],
    customers: Array.isArray(record.customers) ? record.customers : [],
    alerts: Array.isArray(record.alerts) ? record.alerts : [],
    settings: record.settings && typeof record.settings === 'object' ? record.settings : {},
  });
};

export const fetchCloudSyncSignature = async (): Promise<CloudSyncSignatureFetchResult> => {
  if (!isCloudSyncConfigured()) {
    return { ok: false, reason: 'Cloud sync is not configured for this app.' };
  }

  try {
    const app = getApps().length ? getApp() : initializeApp(getFirebaseConfig());
    const auth = getAuth(app);

    if (!auth.currentUser) {
      try {
        await signInAnonymously(auth);
      } catch (error) {
        const authError = error as Partial<AuthError>;
        if (authError?.code === 'auth/configuration-not-found') {
          return { ok: false, reason: 'Anonymous Auth is disabled in Firebase Authentication.' };
        }
        throw error;
      }
    }

    const firestore = getFirestore(app);
    const syncRef = doc(firestore, CLOUD_COLLECTION, CLOUD_DOC_ID);
    const snapshot = await getDoc(syncRef);
    const data = snapshot.data();

    if (!data?.payload) {
      return {
        ok: false,
        reason: 'No remote sync payload found yet. Open the app on the other device and wait for cloud sync.',
      };
    }

    const signature = typeof data.signature === 'string' && data.signature
      ? data.signature
      : createSyncSignature(data.payload);

    const payloadRecord = data.payload && typeof data.payload === 'object'
      ? data.payload as Record<string, unknown>
      : null;
    const topLevelSyncEpoch = typeof data.syncEpoch === 'number' && Number.isFinite(data.syncEpoch)
      ? Math.max(0, Math.floor(data.syncEpoch))
      : null;
    const payloadSyncEpoch = payloadRecord && typeof payloadRecord.syncEpoch === 'number' && Number.isFinite(payloadRecord.syncEpoch)
      ? Math.max(0, Math.floor(payloadRecord.syncEpoch))
      : null;
    const syncEpoch = topLevelSyncEpoch ?? payloadSyncEpoch ?? 0;

    return { ok: true, signature, syncEpoch };
  } catch (error) {
    const path = `${CLOUD_COLLECTION}/${CLOUD_DOC_ID}`;
    if (isPermissionDeniedError(error)) {
      return { ok: false, reason: buildPermissionHint(path) };
    }

    return { ok: false, reason: `Failed to fetch cloud signature: ${getErrorMessage(error)}` };
  }
};

export const startCloudSync = async (options: StartCloudSyncOptions): Promise<CloudSyncSession> => {
  if (!isCloudSyncConfigured()) {
    options.onStatusChange?.('disabled', 'Firebase env config missing.');
    return {
      isEnabled: false,
      isReady: () => false,
      publish: async () => false,
      stop: () => undefined,
    };
  }

  options.onStatusChange?.('connecting');

  try {
    const app = getApps().length ? getApp() : initializeApp(getFirebaseConfig());
    const auth = getAuth(app);
    try {
      await signInAnonymously(auth);
      options.onStatusChange?.(
        'connecting',
        `auth uid=${auth.currentUser?.uid || 'none'} anon=${auth.currentUser?.isAnonymous ? 'yes' : 'no'}`
      );
    } catch (error) {
      const authError = error as Partial<AuthError>;
      if (authError?.code === 'auth/configuration-not-found') {
        options.onStatusChange?.(
          'disabled',
          'Firebase Authentication Anonymous sign-in is not enabled for this project.'
        );
        return {
          isEnabled: false,
          isReady: () => false,
          publish: async () => false,
          stop: () => undefined,
        };
      }
      throw error;
    }

    const firestore = getFirestore(app);
    const legacyRef = doc(firestore, CLOUD_COLLECTION, CLOUD_DOC_ID);

    let ready = false;
    let stopped = false;
    let permissionDenied = false;
    let seenLegacySignature: string | null = null;

    ready = true;
    options.onStatusChange?.('ready');

    try {
      await setDoc(
        legacyRef,
        {
          bootstrap: true,
          bootstrappedBy: options.clientId,
          bootstrappedAt: serverTimestamp(),
          bootstrappedAtMs: Date.now(),
        },
        { merge: true }
      );
    } catch (error) {
      if (isPermissionDeniedError(error)) {
        permissionDenied = true;
        ready = false;
        options.onStatusChange?.('error', buildPermissionHint(legacyRef.path));
      } else {
        options.onStatusChange?.('error', `bootstrap path=${legacyRef.path} ${getErrorMessage(error)}`);
      }
    }

    const pullLegacy = async (channel: 'legacy:init' | 'legacy:poll') => {
      if (stopped || permissionDenied) return;

      try {
        const snapshot = await getDoc(legacyRef);
        const data = snapshot.data();
        const signature = typeof data?.signature === 'string' ? data.signature : null;
        const payloadRecord = data?.payload && typeof data.payload === 'object'
          ? data.payload as Record<string, unknown>
          : null;
        const topLevelSyncEpoch = typeof data?.syncEpoch === 'number' && Number.isFinite(data.syncEpoch)
          ? Math.max(0, Math.floor(data.syncEpoch))
          : null;
        const payloadSyncEpoch = payloadRecord && typeof payloadRecord.syncEpoch === 'number' && Number.isFinite(payloadRecord.syncEpoch)
          ? Math.max(0, Math.floor(payloadRecord.syncEpoch))
          : null;
        const syncEpoch = topLevelSyncEpoch ?? payloadSyncEpoch ?? 0;

        if (!data?.payload) {
          return;
        }

        if (signature && signature === seenLegacySignature && channel === 'legacy:poll') {
          return;
        }

        seenLegacySignature = signature;
        options.onRemoteData(data.payload, {
          updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : undefined,
          signature: signature || undefined,
          syncEpoch,
          channel,
        });
      } catch (error) {
        if (isPermissionDeniedError(error)) {
          permissionDenied = true;
          ready = false;
          options.onStatusChange?.('error', buildPermissionHint(legacyRef.path));
          return;
        }

        const message = getErrorMessage(error);
        const normalized = message.toLowerCase();
        const isOffline =
          normalized.includes('client is offline') ||
          normalized.includes('network') ||
          normalized.includes('unavailable');

        if (isOffline) {
          options.onStatusChange?.('connecting', 'offline: waiting for connectivity');
          return;
        }

        options.onStatusChange?.('error', `legacy:poll path=${legacyRef.path} ${message}`);
      }
    };

    await pullLegacy('legacy:init');

    void pullLegacy('legacy:poll');
    const interval = window.setInterval(() => {
      void pullLegacy('legacy:poll');
    }, POLL_INTERVAL_MS);

    return {
      isEnabled: true,
      isReady: () => ready && !permissionDenied,
      publish: async (payload: unknown, signature: string) => {
        if (permissionDenied) {
          options.onStatusChange?.('error', buildPermissionHint(legacyRef.path));
          return false;
        }

        try {
          const nowMs = Date.now();

          await setDoc(
            legacyRef,
            {
              payload,
              signature,
              syncEpoch: typeof (payload as { syncEpoch?: unknown }).syncEpoch === 'number'
                ? Math.max(0, Math.floor((payload as { syncEpoch?: number }).syncEpoch || 0))
                : 0,
              updatedBy: options.clientId,
              updatedAt: serverTimestamp(),
              updatedAtMs: nowMs,
            },
            { merge: true }
          );

          return true;
        } catch (error) {
          if (isPermissionDeniedError(error)) {
            permissionDenied = true;
            ready = false;
            options.onStatusChange?.('error', buildPermissionHint(legacyRef.path));
            return false;
          }

          options.onStatusChange?.('error', `publish path=${legacyRef.path} ${getErrorMessage(error)}`);
          return false;
        }
      },
      stop: () => {
        stopped = true;
        clearInterval(interval);
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to initialize cloud sync';
    options.onStatusChange?.('error', message);
    return {
      isEnabled: false,
      isReady: () => false,
      publish: async () => false,
      stop: () => undefined,
    };
  }
};
