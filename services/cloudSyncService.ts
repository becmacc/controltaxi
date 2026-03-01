import { initializeApp, getApp, getApps } from 'firebase/app';
import { AuthError, getAuth, signInAnonymously } from 'firebase/auth';
import { deleteField, doc, getDoc, getFirestore, serverTimestamp, setDoc } from 'firebase/firestore';

type SyncStatus = 'disabled' | 'connecting' | 'ready' | 'error';

interface StartCloudSyncOptions {
  clientId: string;
  onRemoteData: (payload: unknown, metadata: { updatedBy?: string; signature?: string; syncEpoch?: number; resetToken?: string; channel?: string }) => void;
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
  resetToken?: string;
  code?: 'not-configured' | 'auth-disabled' | 'no-remote-payload' | 'permission-denied' | 'fetch-failed';
  reason?: string;
}

const SYNC_CLIENT_ID_KEY = '__control_sync_client_id__';
const CLOUD_COLLECTION = import.meta.env.VITE_FIREBASE_SYNC_COLLECTION || 'control-sync';
const DEFAULT_CLOUD_DOC_ID = import.meta.env.VITE_FIREBASE_SYNC_DOC_ID || 'shared';
const POLL_INTERVAL_MS = 3000;
const PAYLOAD_CHUNK_COLLECTION = 'payloadChunks';
const PAYLOAD_CHUNK_CHAR_SIZE = 240000;

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

const chunkString = (text: string, chunkSize: number): string[] => {
  if (!text) return [''];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }
  return chunks;
};

const hasChunkedPayload = (data: Record<string, unknown> | undefined): boolean => {
  if (!data) return false;
  return data.payloadChunked === true && typeof data.payloadChunkCount === 'number' && Number(data.payloadChunkCount) > 0;
};

const resolveRemotePayload = async (
  firestore: ReturnType<typeof getFirestore>,
  docId: string,
  data: Record<string, unknown> | undefined
): Promise<unknown | null> => {
  if (!data) return null;

  if ('payload' in data && data.payload !== undefined && data.payload !== null) {
    return data.payload;
  }

  if (!hasChunkedPayload(data)) {
    return null;
  }

  const chunkCount = Math.max(0, Math.floor(Number(data.payloadChunkCount) || 0));
  if (chunkCount === 0) return null;

  const chunkSnapshots = await Promise.all(
    Array.from({ length: chunkCount }, (_, index) =>
      getDoc(doc(firestore, CLOUD_COLLECTION, docId, PAYLOAD_CHUNK_COLLECTION, `chunk-${String(index).padStart(5, '0')}`))
    )
  );

  const payloadText = chunkSnapshots
    .map((snapshot, index) => {
      if (!snapshot.exists()) {
        throw new Error(`Missing payload chunk ${index + 1}/${chunkCount}`);
      }
      const chunk = snapshot.data();
      if (typeof chunk?.data !== 'string') {
        throw new Error(`Invalid payload chunk ${index + 1}/${chunkCount}`);
      }
      return chunk.data;
    })
    .join('');

  if (!payloadText.trim()) return null;

  try {
    return JSON.parse(payloadText);
  } catch (error) {
    throw new Error(`Failed to parse chunked payload: ${getErrorMessage(error)}`);
  }
};

export const getCloudSyncDocId = () => {
  return DEFAULT_CLOUD_DOC_ID || 'shared';
};

export const isCloudSyncConfigured = () => hasRequiredFirebaseConfig() && Boolean(getCloudSyncDocId());

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
  const resetToken = typeof record.resetToken === 'string' ? record.resetToken.trim() : '';

  return JSON.stringify({
    version: typeof record.version === 'string' ? record.version : '0',
    syncEpoch,
    resetToken,
    trips: Array.isArray(record.trips) ? record.trips : [],
    deletedTrips: Array.isArray(record.deletedTrips) ? record.deletedTrips : [],
    drivers: Array.isArray(record.drivers) ? record.drivers : [],
    customers: Array.isArray(record.customers) ? record.customers : [],
    alerts: Array.isArray(record.alerts) ? record.alerts : [],
    creditLedger: Array.isArray(record.creditLedger) ? record.creditLedger : [],
    receipts: Array.isArray(record.receipts) ? record.receipts : [],
    settings: record.settings && typeof record.settings === 'object' ? record.settings : {},
  });
};

export const fetchCloudSyncSignature = async (): Promise<CloudSyncSignatureFetchResult> => {
  if (!isCloudSyncConfigured()) {
    return { ok: false, code: 'not-configured', reason: 'Cloud sync is not configured for this app.' };
  }

  try {
    const activeDocId = getCloudSyncDocId();
    const app = getApps().length ? getApp() : initializeApp(getFirebaseConfig());
    const auth = getAuth(app);

    if (!auth.currentUser) {
      try {
        await signInAnonymously(auth);
      } catch (error) {
        const authError = error as Partial<AuthError>;
        if (authError?.code === 'auth/configuration-not-found') {
          return { ok: false, code: 'auth-disabled', reason: 'Anonymous Auth is disabled in Firebase Authentication.' };
        }
        throw error;
      }
    }

    const firestore = getFirestore(app);
    const syncRef = doc(firestore, CLOUD_COLLECTION, activeDocId);
    const snapshot = await getDoc(syncRef);
    const data = snapshot.data() as Record<string, unknown> | undefined;
    const hasRemotePayload = Boolean(data?.payload) || hasChunkedPayload(data);

    if (!hasRemotePayload) {
      return {
        ok: false,
        code: 'no-remote-payload',
        reason: 'No remote sync payload found yet. Open the app on the other device and wait for cloud sync.',
      };
    }

    const resolvedPayload = await resolveRemotePayload(firestore, activeDocId, data);

    const signature = typeof data?.signature === 'string' && data.signature
      ? data.signature
      : createSyncSignature(resolvedPayload || {});

    const payloadRecord = resolvedPayload && typeof resolvedPayload === 'object'
      ? resolvedPayload as Record<string, unknown>
      : null;
    const topLevelSyncEpoch = typeof data?.syncEpoch === 'number' && Number.isFinite(data.syncEpoch)
      ? Math.max(0, Math.floor(data.syncEpoch))
      : null;
    const payloadSyncEpoch = payloadRecord && typeof payloadRecord.syncEpoch === 'number' && Number.isFinite(payloadRecord.syncEpoch)
      ? Math.max(0, Math.floor(payloadRecord.syncEpoch))
      : null;
    const syncEpoch = topLevelSyncEpoch ?? payloadSyncEpoch ?? 0;

    const topLevelResetToken = typeof data?.resetToken === 'string' ? data.resetToken.trim() : '';
    const payloadResetToken = payloadRecord && typeof payloadRecord.resetToken === 'string'
      ? String(payloadRecord.resetToken).trim()
      : '';
    const resetToken = topLevelResetToken || payloadResetToken || undefined;

    return { ok: true, signature, syncEpoch, resetToken };
  } catch (error) {
    const path = `${CLOUD_COLLECTION}/${getCloudSyncDocId()}`;
    if (isPermissionDeniedError(error)) {
      return { ok: false, code: 'permission-denied', reason: buildPermissionHint(path) };
    }

    return { ok: false, code: 'fetch-failed', reason: `Failed to fetch cloud signature: ${getErrorMessage(error)}` };
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
    const activeDocId = getCloudSyncDocId();
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
    const legacyRef = doc(firestore, CLOUD_COLLECTION, activeDocId);

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
        const data = snapshot.data() as Record<string, unknown> | undefined;
        const signature = typeof data?.signature === 'string' ? data.signature : null;
        const hasRemotePayload = Boolean(data?.payload) || hasChunkedPayload(data);

        if (!hasRemotePayload) {
          return;
        }

        if (signature && signature === seenLegacySignature && channel === 'legacy:poll') {
          return;
        }

        const resolvedPayload = await resolveRemotePayload(firestore, activeDocId, data);
        if (!resolvedPayload) {
          return;
        }

        const payloadRecord = resolvedPayload && typeof resolvedPayload === 'object'
          ? resolvedPayload as Record<string, unknown>
          : null;
        const topLevelSyncEpoch = typeof data?.syncEpoch === 'number' && Number.isFinite(data.syncEpoch)
          ? Math.max(0, Math.floor(data.syncEpoch))
          : null;
        const payloadSyncEpoch = payloadRecord && typeof payloadRecord.syncEpoch === 'number' && Number.isFinite(payloadRecord.syncEpoch)
          ? Math.max(0, Math.floor(payloadRecord.syncEpoch))
          : null;
        const syncEpoch = topLevelSyncEpoch ?? payloadSyncEpoch ?? 0;
        const topLevelResetToken = typeof data?.resetToken === 'string' ? data.resetToken.trim() : '';
        const payloadResetToken = payloadRecord && typeof payloadRecord.resetToken === 'string'
          ? String(payloadRecord.resetToken).trim()
          : '';
        const resetToken = topLevelResetToken || payloadResetToken || undefined;

        seenLegacySignature = signature;
        options.onRemoteData(resolvedPayload, {
          updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : undefined,
          signature: signature || createSyncSignature(resolvedPayload),
          syncEpoch,
          resetToken,
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
          const payloadText = JSON.stringify(payload);
          const chunks = chunkString(payloadText, PAYLOAD_CHUNK_CHAR_SIZE);
          const shouldChunk = chunks.length > 1;

          if (shouldChunk) {
            await Promise.all(
              chunks.map((chunk, index) =>
                setDoc(
                  doc(firestore, CLOUD_COLLECTION, activeDocId, PAYLOAD_CHUNK_COLLECTION, `chunk-${String(index).padStart(5, '0')}`),
                  {
                    index,
                    data: chunk,
                    signature,
                    updatedBy: options.clientId,
                    updatedAt: serverTimestamp(),
                    updatedAtMs: nowMs,
                  },
                  { merge: true }
                )
              )
            );
          }

          await setDoc(
            legacyRef,
            {
              ...(shouldChunk
                ? {
                    payload: deleteField(),
                    payloadChunked: true,
                    payloadChunkCount: chunks.length,
                    payloadEncoding: 'json',
                  }
                : {
                    payload,
                    payloadChunked: false,
                    payloadChunkCount: 0,
                    payloadEncoding: 'inline',
                  }),
              signature,
              syncEpoch: typeof (payload as { syncEpoch?: unknown }).syncEpoch === 'number'
                ? Math.max(0, Math.floor((payload as { syncEpoch?: number }).syncEpoch || 0))
                : 0,
              resetToken: typeof (payload as { resetToken?: unknown }).resetToken === 'string'
                ? String((payload as { resetToken?: string }).resetToken || '').trim()
                : '',
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
