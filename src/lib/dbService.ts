import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { getFirestore, collection, addDoc, doc, updateDoc, getDocs, query, orderBy, setDoc, getDoc, getDocFromServer, writeBatch, onSnapshot, runTransaction } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { Reservation, ReservationStatus, Cake, CancellationNotification, SalesStopScheduleRule } from '../types';
import { CAKES } from '../data/cakes';

export class SoldOutConflictError extends Error {
  code = 'SOLD_OUT_CONFLICT';
  soldOutCakeIds: string[];
  soldOutCakeNames: string[];

  constructor(soldOutCakeIds: string[], soldOutCakeNames: string[]) {
    super(`申し訳ございません。「${soldOutCakeNames.join('」「')}」は現在売り切れ（オーダーストップ）のためご予約いただけません。`);
    this.name = 'SoldOutConflictError';
    this.soldOutCakeIds = soldOutCakeIds;
    this.soldOutCakeNames = soldOutCakeNames;
  }
}

// Supported operations for system logs
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

let appInstance: any = null;
let dbInstance: any = null;
let authInstance: any = null;
let isFirebaseReady = false;

function ensureFirebaseInitialized(): boolean {
  if (isFirebaseReady && dbInstance) {
    return true;
  }
  try {
    if (!firebaseConfig || !firebaseConfig.projectId) {
      return false;
    }
    if (getApps().length === 0) {
      appInstance = initializeApp(firebaseConfig);
    } else {
      appInstance = getApp();
    }
    dbInstance = getFirestore(appInstance, (firebaseConfig as any).firestoreDatabaseId);
    authInstance = getAuth(appInstance);
    isFirebaseReady = true;
    return true;
  } catch (err) {
    console.warn('Firebase sync init error:', err);
    return false;
  }
}

// Initialize immediately at module load so all early fetches use Firestore
ensureFirebaseInitialized();

// Google Sheets support state
let googleAccessToken: string | null = null;

export function getCachedGoogleToken(): string | null {
  if (!googleAccessToken) {
    try {
      googleAccessToken = sessionStorage.getItem('google_access_token');
    } catch (e) {
      console.warn('sessionStorage is not accessible', e);
    }
  }
  return googleAccessToken;
}

export function setCachedGoogleToken(token: string | null): void {
  googleAccessToken = token;
  try {
    if (token) {
      sessionStorage.setItem('google_access_token', token);
    } else {
      sessionStorage.removeItem('google_access_token');
    }
  } catch (e) {
    console.warn('sessionStorage is not accessible', e);
  }
}

export async function saveSheetsConfig(spreadsheetId: string): Promise<void> {
  localStorage.setItem('sheets_config_id', spreadsheetId);
  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'sheets_config');
      await setDoc(configRef, { spreadsheetId, updatedAt: new Date().toISOString() });
    } catch (err) {
      console.warn('Notice saving sheets config to cloud:', err);
    }
  }
}

export async function clearSheetsConfig(): Promise<void> {
  localStorage.removeItem('sheets_config_id');
  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'sheets_config');
      await setDoc(configRef, { spreadsheetId: '', updatedAt: new Date().toISOString() });
    } catch (err) {
      console.warn('Notice clearing sheets config in cloud:', err);
    }
  }
}

export async function fetchSheetsConfig(): Promise<string | null> {
  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'sheets_config');
      const docSnap = await getDoc(configRef);
      if (docSnap.exists()) {
        const id = docSnap.data().spreadsheetId;
        if (typeof id === 'string' && id.trim().length > 0) {
          localStorage.setItem('sheets_config_id', id.trim());
          return id.trim();
        }
        return null;
      }
    } catch (err) {
      console.error('Failed to fetch sheets config:', err);
    }
  }
  const localId = localStorage.getItem('sheets_config_id');
  return localId && localId.trim().length > 0 ? localId.trim() : null;
}

// 1. Safe Error Handling Wrapper as Mandated
function getAuthDiagnostics() {
  if (!authInstance || !authInstance.currentUser) {
    return { userId: null, email: null, emailVerified: false, isAnonymous: false };
  }
  const user = authInstance.currentUser;
  return {
    userId: user.uid,
    email: user.email,
    emailVerified: user.emailVerified,
    isAnonymous: user.isAnonymous,
    tenantId: (user as any).tenantId || null,
    providerInfo: user.providerData?.map(provider => ({
      providerId: provider.providerId,
      email: provider.email,
    })) || []
  };
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: getAuthDiagnostics(),
    operationType,
    path
  };
  console.error('Firestore Error Captured:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// 2. Firebase Dynamic Runtime Initializer
export async function initializeDatabase(): Promise<{ available: boolean }> {
  try {
    const ready = ensureFirebaseInitialized();
    if (!ready || !dbInstance) {
      isFirebaseReady = false;
      return { available: false };
    }

    // Validate connection against server asynchronously as mandated
    getDocFromServer(doc(dbInstance, 'test', 'connection')).catch((error) => {
      if (error instanceof Error && error.message.includes('the client is offline')) {
        console.error('Please check your Firebase configuration.');
      }
    });

    console.log('Firebase integration enabled and active.');
    return { available: true };
  } catch (err) {
    console.warn('Fallback activated: Firestore configuration missing or offline. Using LocalStorage.');
    isFirebaseReady = false;
    return { available: false };
  }
}

// Local Storage Keys
const LOCAL_STORAGE_KEY = 'cake_reservations';
const SALES_SCHEDULER_STORAGE_KEY = 'sales_scheduler_rules';
const ADMIN_EMAIL = 'kanamori@happy-sweets.jp';

export function isScheduledStopTimeElapsed(scheduledAt?: string): boolean {
  if (!scheduledAt || typeof scheduledAt !== 'string' || !scheduledAt.trim()) {
    return false;
  }
  const ts = new Date(scheduledAt.trim()).getTime();
  if (isNaN(ts)) return false;
  return Date.now() >= ts;
}

// Sanitizers to prevent any runtime crash from legacy or malformed storage objects
function sanitizeCake(c: any, idx: number): Cake {
  const stopSellingAt =
    typeof c?.stopSellingAt === 'string' && c.stopSellingAt.trim()
      ? c.stopSellingAt.trim()
      : undefined;
  const scheduleElapsed = isScheduledStopTimeElapsed(stopSellingAt);
  const isSoldOut = Boolean(c?.isSoldOut) || scheduleElapsed;
  const autoStoppedAt =
    typeof c?.autoStoppedAt === 'string' && c.autoStoppedAt.trim()
      ? c.autoStoppedAt.trim()
      : scheduleElapsed
      ? new Date().toISOString()
      : undefined;

  return {
    id: typeof c?.id === 'string' && c.id ? c.id : `cake-${idx}`,
    name: typeof c?.name === 'string' ? c.name : (typeof c?.jpName === 'string' ? c.jpName : 'Cake'),
    jpName: typeof c?.jpName === 'string' && c.jpName ? c.jpName : 'ケーキ',
    description: typeof c?.description === 'string' ? c.description : '',
    price: typeof c?.price === 'number' && !isNaN(c.price) ? c.price : (Number(c?.price) || 0),
    imageUrl: typeof c?.imageUrl === 'string' && c.imageUrl
      ? c.imageUrl
      : 'https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=600&auto=format&fit=crop&q=80',
    category: (c?.category === 'hall' || c?.category === 'cut' || c?.category === 'seasonal' || c?.category === 'tart')
      ? c.category
      : 'cut',
    tags: Array.isArray(c?.tags) ? c.tags.filter(Boolean).map((t: any) => String(t)) : [],
    isSoldOut,
    ...(c?.portionLabel ? { portionLabel: String(c.portionLabel) } : {}),
    ...(stopSellingAt ? { stopSellingAt } : {}),
    ...(autoStoppedAt ? { autoStoppedAt } : {}),
  };
}

function sanitizeScheduleRule(r: any, idx: number): SalesStopScheduleRule {
  const validScopes = ['all', 'hall', 'cut', 'custom'] as const;
  const targetScope = validScopes.includes(r?.targetScope) ? r.targetScope : 'all';
  const targetCakeIds = Array.isArray(r?.targetCakeIds)
    ? r.targetCakeIds.filter(Boolean).map((id: any) => String(id))
    : [];
  return {
    id: typeof r?.id === 'string' && r.id ? r.id : `sched_${idx}_${Date.now()}`,
    label: typeof r?.label === 'string' && r.label.trim() ? r.label.trim() : '自動販売停止スケジュール',
    scheduledAt: typeof r?.scheduledAt === 'string' ? r.scheduledAt.trim() : '',
    targetScope,
    ...(targetCakeIds.length > 0 ? { targetCakeIds } : {}),
    enabled: r?.enabled !== undefined ? Boolean(r.enabled) : true,
    executed: Boolean(r?.executed),
    ...(typeof r?.executedAt === 'string' && r.executedAt ? { executedAt: r.executedAt } : {}),
    createdAt: typeof r?.createdAt === 'string' && r.createdAt ? r.createdAt : new Date().toISOString(),
  };
}

function sanitizeReservation(r: any, idx: number): Reservation {
  const rawItems = Array.isArray(r?.items) ? r.items : [];
  const items = rawItems.filter(Boolean).map((item: any) => ({
    cakeId: String(item?.cakeId || ''),
    cakeName: String(item?.cakeName || 'ケーキ'),
    quantity: Number(item?.quantity) || 1,
    price: Number(item?.price) || 0,
  }));
  const computedTotal = items.reduce((s: number, i: any) => s + i.price * i.quantity, 0);
  const totalPrice = typeof r?.totalPrice === 'number' && !isNaN(r.totalPrice)
    ? r.totalPrice
    : (Number(r?.totalPrice) || computedTotal || 0);
  const validStatuses: ReservationStatus[] = ['pending', 'confirmed', 'cancelled', 'completed'];
  const status: ReservationStatus = validStatuses.includes(r?.status) ? r.status : 'pending';
  return {
    id: typeof r?.id === 'string' && r.id ? r.id : `res_${idx}`,
    name: typeof r?.name === 'string' ? r.name : 'お客様',
    nameKana: typeof r?.nameKana === 'string' ? r.nameKana : '',
    email: typeof r?.email === 'string' ? r.email : '',
    phone: typeof r?.phone === 'string' ? r.phone : '',
    date: typeof r?.date === 'string' ? r.date : '',
    time: typeof r?.time === 'string' ? r.time : '',
    items,
    totalPrice,
    ...(typeof r?.notes === 'string' && r.notes ? { notes: r.notes } : {}),
    status,
    createdAt: typeof r?.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
    updatedAt: typeof r?.updatedAt === 'string' ? r.updatedAt : new Date().toISOString(),
    ...(r?.cancelledAt ? { cancelledAt: String(r.cancelledAt) } : {}),
  };
}

function sanitizeNotification(n: any, idx: number): CancellationNotification {
  return {
    id: typeof n?.id === 'string' && n.id ? n.id : `cancel_notif_${idx}`,
    reservationId: typeof n?.reservationId === 'string' ? n.reservationId : '',
    customerName: typeof n?.customerName === 'string' ? n.customerName : 'お客様',
    ...(typeof n?.customerKana === 'string' && n.customerKana ? { customerKana: n.customerKana } : {}),
    phone: typeof n?.phone === 'string' ? n.phone : '',
    date: typeof n?.date === 'string' ? n.date : '',
    time: typeof n?.time === 'string' ? n.time : '',
    itemsSummary: typeof n?.itemsSummary === 'string' ? n.itemsSummary : '',
    totalPrice: typeof n?.totalPrice === 'number' && !isNaN(n.totalPrice) ? n.totalPrice : (Number(n?.totalPrice) || 0),
    cancelledAt: typeof n?.cancelledAt === 'string' ? n.cancelledAt : new Date().toISOString(),
    read: Boolean(n?.read),
  };
}

// Get and Set local bookings
function getLocalReservations(): Reservation[] {
  const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(Boolean).map((r, idx) => sanitizeReservation(r, idx));
  } catch {
    return [];
  }
}

function saveLocalReservations(data: Reservation[]) {
  try {
    const clean = (Array.isArray(data) ? data : []).map((r, idx) => sanitizeReservation(r, idx));
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(clean));
  } catch (e) {
    console.warn('Failed saving local reservations:', e);
  }
}

// 3. Database Operations
export async function createReservation(reservation: Omit<Reservation, 'id' | 'createdAt' | 'updatedAt' | 'status'>): Promise<Reservation> {
  ensureFirebaseInitialized();
  const timestamp = new Date().toISOString();
  const id = 'res_' + Math.random().toString(36).substr(2, 9);
  
  const newReservation: Reservation = sanitizeReservation({
    ...reservation,
    id,
    status: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp
  }, 0);

  // 1. Atomic stock verification & reservation creation in Firestore (排他制御)
  if (isFirebaseReady && dbInstance) {
    const resRef = doc(dbInstance, 'reservations', id);
    const catalogRef = doc(dbInstance, 'settings', 'cakes_catalog');

    const transactionPromise = runTransaction(dbInstance, async (transaction) => {
      const catalogSnap = await transaction.get(catalogRef);
      let latestCatalog: Cake[] = CAKES;

      if (catalogSnap.exists() && Array.isArray(catalogSnap.data().cakes) && catalogSnap.data().cakes.length > 0) {
        const rawList = catalogSnap.data().cakes.filter(Boolean).map((c: any, idx: number) => sanitizeCake(c, idx));
        latestCatalog = reconcileWithDefaultCakes(rawList).cakes;
        // Keep local cache synced with latest transactional snapshot
        try {
          localStorage.setItem('cakes_catalog_list', JSON.stringify(latestCatalog));
        } catch {}
      } else {
        const localRaw = localStorage.getItem('cakes_catalog_list');
        if (localRaw) {
          try {
            const parsed = JSON.parse(localRaw);
            if (Array.isArray(parsed) && parsed.length > 0) {
              const rawList = parsed.filter(Boolean).map((c: any, idx: number) => sanitizeCake(c, idx));
              latestCatalog = reconcileWithDefaultCakes(rawList).cakes;
            }
          } catch {}
        }
      }

      // Check every item in the reservation against the latest catalog in Firestore
      const soldOutIds: string[] = [];
      const soldOutNames: string[] = [];

      for (const item of newReservation.items) {
        const targetCake = latestCatalog.find(c => c.id === item.cakeId);
        if (!targetCake || targetCake.isSoldOut) {
          soldOutIds.push(item.cakeId);
          soldOutNames.push(targetCake?.jpName || item.cakeName || '選択されたケーキ');
        }
      }

      if (soldOutIds.length > 0) {
        throw new SoldOutConflictError(soldOutIds, soldOutNames);
      }

      transaction.set(resRef, { ...newReservation });
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Firestore reservation transaction timeout')), 8000)
    );

    try {
      await Promise.race([transactionPromise, timeoutPromise]);
    } catch (error) {
      // Never swallow SoldOutConflictError — rethrow immediately to block the reservation
      if (error instanceof SoldOutConflictError || (error as any)?.code === 'SOLD_OUT_CONFLICT') {
        throw error;
      }
      console.warn('Firestore reservation transaction notice (falling back to direct check):', error);
      // Fallback: still check latest cakes before allowing local save
      const fallbackCakes = await fetchCakes(true);
      const soldOutIds: string[] = [];
      const soldOutNames: string[] = [];
      for (const item of newReservation.items) {
        const targetCake = fallbackCakes.find(c => c.id === item.cakeId);
        if (!targetCake || targetCake.isSoldOut) {
          soldOutIds.push(item.cakeId);
          soldOutNames.push(targetCake?.jpName || item.cakeName || '選択されたケーキ');
        }
      }
      if (soldOutIds.length > 0) {
        throw new SoldOutConflictError(soldOutIds, soldOutNames);
      }
      try {
        await setDoc(resRef, { ...newReservation });
      } catch (writeErr) {
        console.warn('Firestore direct reservation write notice:', writeErr);
      }
    }
  } else {
    // Offline/Local fallback: still verify against local catalog
    const latestCatalog = await fetchCakes();
    const soldOutIds: string[] = [];
    const soldOutNames: string[] = [];
    for (const item of newReservation.items) {
      const targetCake = latestCatalog.find(c => c.id === item.cakeId);
      if (!targetCake || targetCake.isSoldOut) {
        soldOutIds.push(item.cakeId);
        soldOutNames.push(targetCake?.jpName || item.cakeName || '選択されたケーキ');
      }
    }
    if (soldOutIds.length > 0) {
      throw new SoldOutConflictError(soldOutIds, soldOutNames);
    }
  }

  // 2. Persist to LocalStorage only after stock check succeeds
  const current = getLocalReservations();
  current.unshift(newReservation);
  saveLocalReservations(current);

  return newReservation;
}

export async function fetchReservations(userEmail?: string): Promise<Reservation[]> {
  ensureFirebaseInitialized();
  const localItems = getLocalReservations();
  let mergedItems: Reservation[] = [...localItems];

  if (isFirebaseReady && dbInstance) {
    const path = 'reservations';
    try {
      const resCollection = collection(dbInstance, path);
      const fetchPromise = getDocs(resCollection);
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), 6000)
      );
      const snapshot = await Promise.race([fetchPromise, timeoutPromise]);
      if (snapshot) {
        const cloudItems: Reservation[] = [];
        const cloudIds = new Set<string>();
        snapshot.forEach((d) => {
          cloudIds.add(d.id);
          cloudItems.push(sanitizeReservation({ id: d.id, ...d.data() }, cloudItems.length));
        });

        // Merge cloudItems and localItems by ID, keeping the one with the latest updatedAt
        const mapById = new Map<string, Reservation>();
        for (const item of localItems) {
          mapById.set(item.id, item);
          // Auto-migrate any local reservation that was created before Firestore was provisioned
          if (!cloudIds.has(item.id)) {
            setDoc(doc(dbInstance, 'reservations', item.id), { ...sanitizeReservation(item, 0) }).catch(() => {});
          }
        }
        for (const item of cloudItems) {
          const existing = mapById.get(item.id);
          if (!existing || (item.updatedAt || '') >= (existing.updatedAt || '')) {
            mapById.set(item.id, item);
          }
        }
        mergedItems = Array.from(mapById.values());
        saveLocalReservations(mergedItems);
      }
    } catch (error) {
      console.warn('Firestore reservations fetch notice (using local cache):', error);
    }
  }

  const sorted = mergedItems.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  if (userEmail && userEmail !== ADMIN_EMAIL) {
    const q = userEmail.toLowerCase().trim();
    const qDigits = q.replace(/[-\s]/g, '');
    return sorted.filter(item => {
      const itemEmail = (item.email || '').toLowerCase().trim();
      const itemPhoneDigits = (item.phone || '').replace(/[-\s]/g, '');
      return itemEmail === q || (qDigits.length >= 7 && itemPhoneDigits.includes(qDigits));
    });
  }

  return sorted;
}

export async function updateReservationStatus(id: string, status: ReservationStatus): Promise<void> {
  const timestamp = new Date().toISOString();

  // 1. Update LocalStorage immediately
  const current = getLocalReservations();
  const foundIndex = current.findIndex(r => r.id === id);
  let targetReservation: Reservation | null = null;
  if (foundIndex !== -1) {
    current[foundIndex].status = status;
    current[foundIndex].updatedAt = timestamp;
    if (status === 'cancelled') {
      current[foundIndex].cancelledAt = timestamp;
    }
    targetReservation = current[foundIndex];
    saveLocalReservations(current);
  }

  // If status changed to cancelled, record a staff cancellation notification
  if (status === 'cancelled' && targetReservation) {
    await recordCancellationNotification(targetReservation, timestamp);
  }

  // 2. Sync status update to Firestore with timeout guard
  if (isFirebaseReady && dbInstance) {
    try {
      const docRef = doc(dbInstance, 'reservations', id);
      const payload: Record<string, any> = {
        status,
        updatedAt: timestamp
      };
      if (status === 'cancelled') {
        payload.cancelledAt = timestamp;
      }
      const updatePromise = setDoc(docRef, payload, { merge: true });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Firestore status update timeout')), 1500)
      );
      await Promise.race([updatePromise, timeoutPromise]);
    } catch (error) {
      console.warn('Firestore reservation status update notice (updated locally):', error);
    }
  }
}

const CANCEL_NOTIFICATIONS_KEY = 'staff_cancel_notifications';

export function getLocalCancellationNotifications(): CancellationNotification[] {
  const raw = localStorage.getItem(CANCEL_NOTIFICATIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean).map((n, idx) => sanitizeNotification(n, idx)) : [];
  } catch {
    return [];
  }
}

function saveLocalCancellationNotifications(list: CancellationNotification[]) {
  try {
    const clean = (Array.isArray(list) ? list : []).map((n, idx) => sanitizeNotification(n, idx));
    localStorage.setItem(CANCEL_NOTIFICATIONS_KEY, JSON.stringify(clean));
  } catch (e) {
    console.warn('Failed saving local cancellation notifications:', e);
  }
}

export async function recordCancellationNotification(res: Reservation, cancelledAt: string): Promise<CancellationNotification> {
  const existing = getLocalCancellationNotifications();
  const itemsSummary = (res.items || []).map(i => `${i.cakeName}×${i.quantity}`).join('、');
  const notif: CancellationNotification = {
    id: `cancel_notif_${res.id}_${Date.now()}`,
    reservationId: res.id,
    customerName: res.name,
    customerKana: res.nameKana,
    phone: res.phone,
    date: res.date,
    time: res.time,
    itemsSummary,
    totalPrice: res.totalPrice,
    cancelledAt,
    read: false
  };

  // Replace any older notification for the same reservationId with this latest unread one
  const filtered = existing.filter(n => n.reservationId !== res.id);
  const updated = [notif, ...filtered];
  saveLocalCancellationNotifications(updated);

  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'cancellation_notifications');
      const writePromise = setDoc(configRef, {
        notifications: updated.slice(0, 100),
        updatedAt: cancelledAt
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Firestore cancel notifications timeout')), 1500)
      );
      await Promise.race([writePromise, timeoutPromise]);
    } catch (err) {
      console.warn('Failed to sync cancellation notifications to Firestore:', err);
    }
  }

  return notif;
}

export async function fetchCancellationNotifications(reservationsList?: Reservation[]): Promise<CancellationNotification[]> {
  let localList = getLocalCancellationNotifications();

  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'cancellation_notifications');
      const fetchPromise = getDoc(configRef);
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), 1500)
      );
      const docSnap = await Promise.race([fetchPromise, timeoutPromise]);
      if (docSnap && docSnap.exists() && Array.isArray(docSnap.data().notifications)) {
        const cloudList: CancellationNotification[] = docSnap.data().notifications;
        const mapByResId = new Map<string, CancellationNotification>();
        for (const item of localList) {
          mapByResId.set(item.reservationId, item);
        }
        for (const item of cloudList) {
          const prev = mapByResId.get(item.reservationId);
          if (!prev) {
            mapByResId.set(item.reservationId, item);
          } else {
            // If either is marked read and has same cancelledAt, preserve read state
            if (item.cancelledAt > prev.cancelledAt) {
              mapByResId.set(item.reservationId, item);
            } else if (prev.read || item.read) {
              mapByResId.set(item.reservationId, { ...prev, read: true });
            }
          }
        }
        localList = Array.from(mapByResId.values());
      }
    } catch (err) {
      console.warn('Notice fetching cancellation notifications from Firestore:', err);
    }
  }

  // Ensure every cancelled reservation in reservationsList is represented
  const sourceReservations = reservationsList || getLocalReservations();
  let modified = false;
  for (const res of sourceReservations) {
    if (res.status === 'cancelled') {
      const hasNotif = localList.some(n => n.reservationId === res.id);
      if (!hasNotif) {
        const itemsSummary = (res.items || []).map(i => `${i.cakeName}×${i.quantity}`).join('、');
        localList.unshift({
          id: `cancel_notif_${res.id}`,
          reservationId: res.id,
          customerName: res.name,
          customerKana: res.nameKana,
          phone: res.phone,
          date: res.date,
          time: res.time,
          itemsSummary,
          totalPrice: res.totalPrice,
          cancelledAt: res.cancelledAt || res.updatedAt || res.createdAt,
          read: false
        });
        modified = true;
      }
    }
  }

  localList.sort((a, b) => (b.cancelledAt || '').localeCompare(a.cancelledAt || ''));
  if (modified) {
    saveLocalCancellationNotifications(localList);
  } else {
    saveLocalCancellationNotifications(localList);
  }
  return localList;
}

export async function markCancellationNotificationRead(reservationId: string): Promise<CancellationNotification[]> {
  const current = getLocalCancellationNotifications();
  const updated = current.map(n =>
    n.reservationId === reservationId || n.id === reservationId ? { ...n, read: true } : n
  );
  saveLocalCancellationNotifications(updated);

  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'cancellation_notifications');
      const writePromise = setDoc(configRef, {
        notifications: updated.slice(0, 100),
        updatedAt: new Date().toISOString()
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Firestore cancel notifications mark read timeout')), 1500)
      );
      await Promise.race([writePromise, timeoutPromise]);
    } catch (err) {
      console.warn('Notice marking notification read in Firestore:', err);
    }
  }

  return updated;
}

export async function markAllCancellationNotificationsRead(): Promise<CancellationNotification[]> {
  const current = getLocalCancellationNotifications();
  const updated = current.map(n => ({ ...n, read: true }));
  saveLocalCancellationNotifications(updated);

  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'cancellation_notifications');
      const writePromise = setDoc(configRef, {
        notifications: updated.slice(0, 100),
        updatedAt: new Date().toISOString()
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Firestore cancel notifications mark all read timeout')), 1500)
      );
      await Promise.race([writePromise, timeoutPromise]);
    } catch (err) {
      console.warn('Notice marking all notifications read in Firestore:', err);
    }
  }

  return updated;
}

export function subscribeToReservations(
  onUpdate: (reservations: Reservation[], notifications: CancellationNotification[], newlyCancelled: Reservation[]) => void
): () => void {
  let knownCancelledIds = new Set<string>(
    getLocalReservations().filter(r => r.status === 'cancelled').map(r => r.id)
  );
  let isInitialSnapshot = true;

  const processIncoming = async (incomingReservations: Reservation[]) => {
    const newlyCancelled: Reservation[] = [];
    for (const r of incomingReservations) {
      if (r.status === 'cancelled' && !knownCancelledIds.has(r.id)) {
        knownCancelledIds.add(r.id);
        if (!isInitialSnapshot) {
          newlyCancelled.push(r);
        }
      } else if (r.status !== 'cancelled' && knownCancelledIds.has(r.id)) {
        knownCancelledIds.delete(r.id);
      }
    }
    isInitialSnapshot = false;
    const sorted = [...incomingReservations].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const notifs = await fetchCancellationNotifications(sorted);
    onUpdate(sorted, notifs, newlyCancelled);
  };

  let unsubscribeFirestore: (() => void) | null = null;
  if (isFirebaseReady && dbInstance) {
    try {
      const resCollection = collection(dbInstance, 'reservations');
      unsubscribeFirestore = onSnapshot(
        resCollection,
        (snapshot) => {
          const localItems = getLocalReservations();
          const mapById = new Map<string, Reservation>();
          for (const item of localItems) {
            mapById.set(item.id, item);
          }
          snapshot.forEach((d) => {
            const cloudItem = { id: d.id, ...d.data() } as Reservation;
            const existing = mapById.get(cloudItem.id);
            if (!existing || (cloudItem.updatedAt || '') >= (existing.updatedAt || '')) {
              mapById.set(cloudItem.id, cloudItem);
            }
          });
          const merged = Array.from(mapById.values());
          saveLocalReservations(merged);
          processIncoming(merged);
        },
        (err) => {
          console.warn('Realtime reservations listener notice:', err);
        }
      );
    } catch (err) {
      console.warn('Failed setting up realtime reservations listener:', err);
    }
  }

  const handleStorageEvent = (e: StorageEvent) => {
    if (e.key === LOCAL_STORAGE_KEY || e.key === CANCEL_NOTIFICATIONS_KEY) {
      const latest = getLocalReservations();
      processIncoming(latest);
    }
  };
  window.addEventListener('storage', handleStorageEvent);

  return () => {
    if (unsubscribeFirestore) unsubscribeFirestore();
    window.removeEventListener('storage', handleStorageEvent);
  };
}

// 4. Authenticaton Helper
export async function googleLogin(options?: {
  forceConsent?: boolean;
  preserveManagerSession?: boolean;
}): Promise<{ user: User | null; email: string | null; isManager: boolean; accessToken?: string | null }> {
  ensureFirebaseInitialized();
  if (isFirebaseReady && authInstance) {
    try {
      const provider = new GoogleAuthProvider();
      provider.addScope('https://www.googleapis.com/auth/spreadsheets');
      provider.addScope('https://www.googleapis.com/auth/drive.file');
      provider.setCustomParameters({
        prompt: options?.forceConsent ? 'consent select_account' : 'select_account',
      });
      
      const result = await signInWithPopup(authInstance, provider);
      let existingMockIsManager = false;
      try {
        const rawMock = sessionStorage.getItem('mock_user_session');
        if (rawMock) {
          const parsed = JSON.parse(rawMock);
          existingMockIsManager = Boolean(parsed?.isManager);
        }
      } catch {
        existingMockIsManager = false;
      }

      const isManager =
        Boolean(options?.preserveManagerSession) ||
        existingMockIsManager ||
        result.user.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();
      
      if (isManager) {
        saveMockSession({
          email: result.user.email || ADMIN_EMAIL,
          isManager: true,
          displayName: '管理者１',
          uid: result.user.uid,
        });
      }

      const credential = GoogleAuthProvider.credentialFromResult(result);
      const token = credential?.accessToken || null;
      if (token) {
        setCachedGoogleToken(token);
      }
      
      return {
        user: result.user,
        email: result.user.email,
        isManager,
        accessToken: token,
      };
    } catch (error) {
      console.error('Google Sign In authentication error:', error);
      throw error;
    }
  }
  
  // Non-Firebase Mock Login
  return {
    user: {
      uid: 'mock_uid_' + Math.random().toString(36).substr(2, 9),
      email: ADMIN_EMAIL,
      displayName: '管理者１',
      emailVerified: true,
    } as any,
    email: ADMIN_EMAIL,
    isManager: true,
    accessToken: null,
  };
}

export async function userSignOut(): Promise<void> {
  setCachedGoogleToken(null);
  if (isFirebaseReady && authInstance) {
    await signOut(authInstance);
    return;
  }
}

export function subscribeToAuth(callback: (userData: { email: string | null; isManager: boolean; displayName: string | null; uid: string | null } | null) => void) {
  const getMockUser = () => {
    const sessionUser = sessionStorage.getItem('mock_user_session');
    if (sessionUser) {
      try {
        const data = JSON.parse(sessionUser);
        if (data && data.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
          data.displayName = '管理者１';
        }
        return data;
      } catch {
        return null;
      }
    }
    return null;
  };

  if (isFirebaseReady && authInstance) {
    return onAuthStateChanged(authInstance, (user) => {
      const mockUser = getMockUser();
      if (user) {
        const isManager =
          Boolean(mockUser?.isManager) ||
          user.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();
        callback({
          email: user.email,
          isManager,
          displayName: isManager ? '管理者１' : user.displayName,
          uid: user.uid
        });
      } else {
        callback(mockUser);
      }
    });
  }
  
  callback(getMockUser());
  return () => {};
}

export function saveMockSession(userData: { email: string | null; isManager: boolean; displayName: string | null; uid: string | null } | null) {
  if (userData) {
    if (userData.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
      userData.displayName = '管理者１';
    }
    sessionStorage.setItem('mock_user_session', JSON.stringify(userData));
  } else {
    sessionStorage.removeItem('mock_user_session');
  }
}

export async function saveBusinessDays(days: string[]): Promise<void> {
  ensureFirebaseInitialized();
  const cleanDays = Array.from(
    new Set((Array.isArray(days) ? days : []).filter((d): d is string => typeof d === 'string' && d.length > 0))
  ).sort();
  const updatedAt = new Date().toISOString();

  // 1. Immediately persist locally so the user never experiences delay
  localStorage.setItem('business_days_list', JSON.stringify(cleanDays));
  localStorage.setItem('business_days_updated_at', updatedAt);

  // 2. Persist to Firestore with an 8-second timeout guard
  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'business_days');
      const writePromise = setDoc(configRef, { 
        days: cleanDays, 
        updatedAt
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Firestore write timeout')), 8000)
      );
      await Promise.race([writePromise, timeoutPromise]);
    } catch (err) {
      console.warn('Firestore business days save notice (saved to local cache successfully):', err);
    }
  }
}

export async function fetchBusinessDays(): Promise<string[]> {
  ensureFirebaseInitialized();
  const local = localStorage.getItem('business_days_list');
  let fallbackDays: string[] = [];
  if (local) {
    try {
      const parsed = JSON.parse(local);
      fallbackDays = Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string').sort() : [];
    } catch (e) {
      fallbackDays = [];
    }
  }

  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'business_days');
      const fetchPromise = getDocFromServer(configRef).catch(() => getDoc(configRef));
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), 6000)
      );
      const docSnap = await Promise.race([fetchPromise, timeoutPromise]);
      if (docSnap) {
        if (docSnap.exists()) {
          const rawDays = docSnap.data().days;
          const cloudDays = Array.isArray(rawDays)
            ? rawDays.filter((d): d is string => typeof d === 'string').sort()
            : [];
          localStorage.setItem('business_days_list', JSON.stringify(cloudDays));
          if (docSnap.data().updatedAt) {
            localStorage.setItem('business_days_updated_at', String(docSnap.data().updatedAt));
          }
          return cloudDays;
        } else if (fallbackDays.length > 0) {
          // Auto-migrate admin's existing localStorage business days to Firestore if cloud doc doesn't exist yet
          setDoc(configRef, {
            days: fallbackDays,
            updatedAt: new Date().toISOString()
          }).catch((e) => console.warn('Auto-migrate business days notice:', e));
          return fallbackDays;
        }
      }
    } catch (err) {
      console.warn('Failed to fetch business days from Firebase, using local cache:', err);
    }
  }

  return fallbackDays;
}

export function subscribeToBusinessDays(onUpdate: (days: string[]) => void): () => void {
  ensureFirebaseInitialized();
  let unsubscribeFirestore: (() => void) | null = null;

  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'business_days');
      unsubscribeFirestore = onSnapshot(
        configRef,
        (docSnap) => {
          if (docSnap.exists()) {
            const rawDays = docSnap.data().days;
            const cloudDays = Array.isArray(rawDays)
              ? rawDays.filter((d): d is string => typeof d === 'string').sort()
              : [];
            localStorage.setItem('business_days_list', JSON.stringify(cloudDays));
            onUpdate(cloudDays);
          } else {
            // If cloud doc doesn't exist yet, check if this browser has local business days to migrate
            const local = localStorage.getItem('business_days_list');
            if (local) {
              try {
                const parsed = JSON.parse(local);
                const localDays = Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string').sort() : [];
                if (localDays.length > 0) {
                  setDoc(configRef, { days: localDays, updatedAt: new Date().toISOString() }).catch(() => {});
                  onUpdate(localDays);
                  return;
                }
              } catch {}
            }
            onUpdate([]);
          }
        },
        (err) => {
          console.warn('Realtime business days listener notice:', err);
        }
      );
    } catch (err) {
      console.warn('Failed setting up realtime business days listener:', err);
    }
  }

  const handleStorage = (e: StorageEvent) => {
    if (e.key === 'business_days_list' && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue);
        if (Array.isArray(parsed)) {
          onUpdate(parsed.filter((d): d is string => typeof d === 'string').sort());
        }
      } catch {}
    }
  };
  window.addEventListener('storage', handleStorage);

  return () => {
    if (unsubscribeFirestore) unsubscribeFirestore();
    window.removeEventListener('storage', handleStorage);
  };
}

export async function checkDuplicateReservation(email: string, phone: string): Promise<boolean> {
  const all = await fetchReservations();
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedPhone = phone.replace(/[-\s]/g, '');
  
  return all.some(res => {
    if (res.status === 'cancelled') return false;
    const resEmail = res.email.trim().toLowerCase();
    const resPhone = res.phone.replace(/[-\s]/g, '');
    return resEmail === normalizedEmail || resPhone === normalizedPhone;
  });
}

// Helper to guarantee that all default cakes defined in code (CAKES) exist in the catalog
// and are never lost if Firestore or localStorage had older or partial data (e.g. gateau-au-chocolat, rice-chou)
export function reconcileWithDefaultCakes(loadedCakes: Cake[]): { cakes: Cake[]; needsSave: boolean } {
  const cleanLoaded = (Array.isArray(loadedCakes) ? loadedCakes : []).filter(Boolean);
  const loadedMap = new Map<string, Cake>();
  for (const c of cleanLoaded) {
    if (c?.id) loadedMap.set(c.id, c);
  }

  let needsSave = false;
  const merged: Cake[] = [];

  for (const defCake of CAKES) {
    const existing = loadedMap.get(defCake.id);
    if (!existing) {
      // Default cake was completely missing in database (e.g. gateau-au-chocolat, rice-chou)
      merged.push({ ...defCake });
      needsSave = true;
    } else {
      // Cake exists in database: keep sales/admin status, but ensure all fields are complete
      const mergedCake: Cake = {
        ...defCake,
        ...existing,
        // Fall back to defCake if existing field is empty or missing
        imageUrl: existing.imageUrl && existing.imageUrl.trim() ? existing.imageUrl.trim() : defCake.imageUrl,
        jpName: existing.jpName || defCake.jpName,
        name: existing.name || defCake.name,
        price: typeof existing.price === 'number' && existing.price > 0 ? existing.price : defCake.price,
        description: existing.description || defCake.description,
        portionLabel: existing.portionLabel || defCake.portionLabel,
        category: existing.category || defCake.category,
        tags: Array.isArray(existing.tags) && existing.tags.length > 0 ? existing.tags : defCake.tags,
      };
      merged.push(mergedCake);
      loadedMap.delete(defCake.id);
    }
  }

  // Include any custom cakes added via Admin
  for (const customCake of loadedMap.values()) {
    merged.push(customCake);
  }

  return { cakes: merged, needsSave };
}

// 5. Dynamic Cake Catalog & Order-Stop (売り切れ) Management
export async function fetchCakes(forceServer: boolean = false): Promise<Cake[]> {
  ensureFirebaseInitialized();
  const local = localStorage.getItem('cakes_catalog_list');
  let localCakes: Cake[] | null = null;
  if (local) {
    try {
      const parsed = JSON.parse(local);
      if (Array.isArray(parsed) && parsed.length > 0) {
        localCakes = parsed.filter(Boolean).map((c, idx) => sanitizeCake(c, idx));
      }
    } catch (e) {
      console.warn('Failed parsing local cakes', e);
    }
  }

  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'cakes_catalog');
      const fetchPromise = forceServer
        ? getDocFromServer(configRef).catch(() => getDoc(configRef))
        : getDocFromServer(configRef).catch(() => getDoc(configRef));
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), 6000)
      );
      const docSnap = await Promise.race([fetchPromise, timeoutPromise]);
      if (docSnap) {
        if (docSnap.exists() && Array.isArray(docSnap.data().cakes) && docSnap.data().cakes.length > 0) {
          const rawCloud: Cake[] = docSnap.data().cakes.filter(Boolean).map((c: any, idx: number) => sanitizeCake(c, idx));
          const { cakes: cloudCakes, needsSave } = reconcileWithDefaultCakes(rawCloud);
          const cloudUpdatedAt: string = docSnap.data().updatedAt || '';
          localStorage.setItem('cakes_catalog_list', JSON.stringify(cloudCakes));
          if (cloudUpdatedAt) {
            localStorage.setItem('cakes_catalog_updated_at', cloudUpdatedAt);
          }
          if (needsSave) {
            saveCakes(cloudCakes).catch((e) => console.warn('Auto-save reconciled cakes notice:', e));
          }
          return cloudCakes;
        } else if (!docSnap.exists()) {
          // Auto-migrate admin's existing local cakes or default CAKES to Firestore
          const baseList = localCakes && localCakes.length > 0 ? localCakes : CAKES;
          const { cakes: reconciled } = reconcileWithDefaultCakes(baseList);
          const updatedAt = new Date().toISOString();
          setDoc(configRef, { cakes: reconciled, updatedAt }).catch((e) =>
            console.warn('Auto-migrate cakes catalog notice:', e)
          );
          localStorage.setItem('cakes_catalog_list', JSON.stringify(reconciled));
          return reconciled;
        }
      }
    } catch (err) {
      console.warn('Failed to fetch cakes catalog from Firebase:', err);
    }
  }

  if (localCakes && localCakes.length > 0) {
    const { cakes: reconciled, needsSave } = reconcileWithDefaultCakes(localCakes);
    if (needsSave) {
      localStorage.setItem('cakes_catalog_list', JSON.stringify(reconciled));
    }
    return reconciled;
  }
  return CAKES;
}

export async function saveCakes(cakes: Cake[]): Promise<void> {
  ensureFirebaseInitialized();
  const updatedAt = new Date().toISOString();
  const cleanCakes = (Array.isArray(cakes) ? cakes : []).filter(Boolean).map((c, idx) => sanitizeCake(c, idx));
  localStorage.setItem('cakes_catalog_list', JSON.stringify(cleanCakes));
  localStorage.setItem('cakes_catalog_updated_at', updatedAt);
  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'cakes_catalog');
      const writePromise = setDoc(configRef, { cakes: cleanCakes, updatedAt });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Firestore cakes save timeout')), 8000)
      );
      await Promise.race([writePromise, timeoutPromise]);
    } catch (err) {
      console.warn('Failed to save cakes to Firebase (saved locally):', err);
    }
  }
}

export function subscribeToCakes(onUpdate: (cakes: Cake[]) => void): () => void {
  ensureFirebaseInitialized();
  let unsubscribeFirestore: (() => void) | null = null;

  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'cakes_catalog');
      unsubscribeFirestore = onSnapshot(
        configRef,
        (docSnap) => {
          if (docSnap.exists() && Array.isArray(docSnap.data().cakes) && docSnap.data().cakes.length > 0) {
            const rawCloud: Cake[] = docSnap.data().cakes.filter(Boolean).map((c: any, idx: number) => sanitizeCake(c, idx));
            const { cakes: cloudCakes, needsSave } = reconcileWithDefaultCakes(rawCloud);
            localStorage.setItem('cakes_catalog_list', JSON.stringify(cloudCakes));
            if (docSnap.data().updatedAt) {
              localStorage.setItem('cakes_catalog_updated_at', String(docSnap.data().updatedAt));
            }
            if (needsSave) {
              saveCakes(cloudCakes).catch((e) => console.warn('Auto-save reconciled cakes on snapshot notice:', e));
            }
            onUpdate(cloudCakes);
          } else if (!docSnap.exists()) {
            const local = localStorage.getItem('cakes_catalog_list');
            if (local) {
              try {
                const parsed = JSON.parse(local);
                if (Array.isArray(parsed) && parsed.length > 0) {
                  const cleanLocal = parsed.filter(Boolean).map((c, idx) => sanitizeCake(c, idx));
                  const { cakes: reconciled } = reconcileWithDefaultCakes(cleanLocal);
                  setDoc(configRef, { cakes: reconciled, updatedAt: new Date().toISOString() }).catch(() => {});
                  onUpdate(reconciled);
                  return;
                }
              } catch {}
            }
          }
        },
        (err) => {
          console.warn('Realtime cakes catalog listener notice:', err);
        }
      );
    } catch (err) {
      console.warn('Failed setting up realtime cakes catalog listener:', err);
    }
  }

  const handleStorage = (e: StorageEvent) => {
    if (e.key === 'cakes_catalog_list' && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue);
        if (Array.isArray(parsed) && parsed.length > 0) {
          onUpdate(parsed.filter(Boolean).map((c, idx) => sanitizeCake(c, idx)));
        }
      } catch {}
    }
  };
  window.addEventListener('storage', handleStorage);

  return () => {
    if (unsubscribeFirestore) unsubscribeFirestore();
    window.removeEventListener('storage', handleStorage);
  };
}

export async function updateCakeSoldOut(cakeId: string, isSoldOut: boolean): Promise<Cake[]> {
  const current = await fetchCakes();
  const updated = current.map(c => {
    if (c.id !== cakeId) return c;
    const nextCake: Cake = { ...c, isSoldOut };
    // When admin manually resumes sales, clear any elapsed stopSellingAt / autoStoppedAt so it doesn't immediately re-lock
    if (!isSoldOut) {
      delete nextCake.autoStoppedAt;
      if (nextCake.stopSellingAt && isScheduledStopTimeElapsed(nextCake.stopSellingAt)) {
        delete nextCake.stopSellingAt;
      }
    }
    return nextCake;
  });
  await saveCakes(updated);
  return updated;
}

export async function updateCakeSchedule(cakeId: string, stopSellingAt: string | null): Promise<Cake[]> {
  const current = await fetchCakes();
  const cleanTime = stopSellingAt && stopSellingAt.trim() ? stopSellingAt.trim() : undefined;
  const elapsed = isScheduledStopTimeElapsed(cleanTime);
  const nowIso = new Date().toISOString();

  const updated = current.map(c => {
    if (c.id !== cakeId) return c;
    const nextCake: Cake = { ...c };
    if (cleanTime) {
      nextCake.stopSellingAt = cleanTime;
      if (elapsed) {
        nextCake.isSoldOut = true;
        nextCake.autoStoppedAt = nowIso;
      }
    } else {
      delete nextCake.stopSellingAt;
      delete nextCake.autoStoppedAt;
    }
    return nextCake;
  });
  await saveCakes(updated);
  return updated;
}

export async function bulkUpdateCakesSoldOut(
  targetScope: 'all' | 'hall' | 'cut',
  isSoldOut: boolean
): Promise<Cake[]> {
  const current = await fetchCakes();
  const updated = current.map(c => {
    const matches =
      targetScope === 'all' ||
      (targetScope === 'hall' && c.category === 'hall') ||
      (targetScope === 'cut' && c.category === 'cut');
    if (!matches) return c;
    const nextCake: Cake = { ...c, isSoldOut };
    if (!isSoldOut) {
      delete nextCake.autoStoppedAt;
      if (nextCake.stopSellingAt && isScheduledStopTimeElapsed(nextCake.stopSellingAt)) {
        delete nextCake.stopSellingAt;
      }
    }
    return nextCake;
  });
  await saveCakes(updated);
  return updated;
}

export async function saveCakeItem(cake: Cake): Promise<Cake[]> {
  const current = await fetchCakes();
  const exists = current.some(c => c.id === cake.id);
  let updated: Cake[];
  if (exists) {
    updated = current.map(c => c.id === cake.id ? cake : c);
  } else {
    updated = [...current, cake];
  }
  await saveCakes(updated);
  return updated;
}

export async function deleteCakeItem(cakeId: string): Promise<Cake[]> {
  const current = await fetchCakes();
  const updated = current.filter(c => c.id !== cakeId);
  await saveCakes(updated);
  return updated;
}

export async function syncCakesFromDefaultCode(): Promise<Cake[]> {
  ensureFirebaseInitialized();
  const current = await fetchCakes();
  const currentMap = new Map(current.map(c => [c.id, c]));

  // Merge default CAKES from code with current state (preserving sold-out and schedule settings)
  const merged: Cake[] = CAKES.map((defCake) => {
    const existing = currentMap.get(defCake.id);
    if (existing) {
      return {
        ...defCake,
        isSoldOut: existing.isSoldOut,
        ...(existing.stopSellingAt ? { stopSellingAt: existing.stopSellingAt } : {}),
        ...(existing.autoStoppedAt ? { autoStoppedAt: existing.autoStoppedAt } : {}),
      };
    }
    return defCake;
  });

  // Retain any custom cakes created via admin
  const defaultIds = new Set(CAKES.map(c => c.id));
  const customCakes = current.filter(c => !defaultIds.has(c.id));
  const finalCakes = [...merged, ...customCakes];

  await saveCakes(finalCakes);
  return finalCakes;
}

// 6. Auto Sales-Stop Scheduler (指定日時での自動販売停止スケジューラー)
function getLocalScheduleRules(): SalesStopScheduleRule[] {
  const raw = localStorage.getItem(SALES_SCHEDULER_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(Boolean).map((r, idx) => sanitizeScheduleRule(r, idx));
  } catch {
    return [];
  }
}

export async function fetchSalesStopRules(): Promise<SalesStopScheduleRule[]> {
  ensureFirebaseInitialized();
  const localRules = getLocalScheduleRules();

  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'sales_scheduler');
      const fetchPromise = getDocFromServer(configRef).catch(() => getDoc(configRef));
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
      const docSnap = await Promise.race([fetchPromise, timeoutPromise]);
      if (docSnap && docSnap.exists() && Array.isArray(docSnap.data().rules)) {
        const cloudRules = docSnap.data().rules.filter(Boolean).map((r: any, idx: number) => sanitizeScheduleRule(r, idx));
        localStorage.setItem(SALES_SCHEDULER_STORAGE_KEY, JSON.stringify(cloudRules));
        return cloudRules;
      } else if (docSnap && !docSnap.exists() && localRules.length > 0) {
        setDoc(configRef, { rules: localRules, updatedAt: new Date().toISOString() }).catch(() => {});
        return localRules;
      }
    } catch (err) {
      console.warn('Failed to fetch sales scheduler rules from Firestore:', err);
    }
  }
  return localRules;
}

export async function saveSalesStopRules(rules: SalesStopScheduleRule[]): Promise<SalesStopScheduleRule[]> {
  ensureFirebaseInitialized();
  const cleanRules = (Array.isArray(rules) ? rules : [])
    .filter(Boolean)
    .map((r, idx) => sanitizeScheduleRule(r, idx))
    .sort((a, b) => (a.scheduledAt || '').localeCompare(b.scheduledAt || ''));

  const updatedAt = new Date().toISOString();
  localStorage.setItem(SALES_SCHEDULER_STORAGE_KEY, JSON.stringify(cleanRules));

  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'sales_scheduler');
      const writePromise = setDoc(configRef, { rules: cleanRules, updatedAt });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Firestore sales_scheduler save timeout')), 8000)
      );
      await Promise.race([writePromise, timeoutPromise]);
    } catch (err) {
      console.warn('Failed to save sales scheduler rules to Firestore (saved locally):', err);
    }
  }
  return cleanRules;
}

export function subscribeToSalesStopRules(onUpdate: (rules: SalesStopScheduleRule[]) => void): () => void {
  ensureFirebaseInitialized();
  let unsubscribeFirestore: (() => void) | null = null;

  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'sales_scheduler');
      unsubscribeFirestore = onSnapshot(
        configRef,
        (docSnap) => {
          if (docSnap.exists() && Array.isArray(docSnap.data().rules)) {
            const cloudRules = docSnap.data().rules.filter(Boolean).map((r: any, idx: number) => sanitizeScheduleRule(r, idx));
            localStorage.setItem(SALES_SCHEDULER_STORAGE_KEY, JSON.stringify(cloudRules));
            onUpdate(cloudRules);
          }
        },
        (err) => {
          console.warn('Realtime sales scheduler listener notice:', err);
        }
      );
    } catch (err) {
      console.warn('Failed setting up realtime sales scheduler listener:', err);
    }
  }

  const handleStorage = (e: StorageEvent) => {
    if (e.key === SALES_SCHEDULER_STORAGE_KEY && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue);
        if (Array.isArray(parsed)) {
          onUpdate(parsed.filter(Boolean).map((r, idx) => sanitizeScheduleRule(r, idx)));
        }
      } catch {}
    }
  };
  window.addEventListener('storage', handleStorage);

  return () => {
    if (unsubscribeFirestore) unsubscribeFirestore();
    window.removeEventListener('storage', handleStorage);
  };
}

function doesRuleMatchCake(rule: SalesStopScheduleRule, cake: Cake): boolean {
  if (rule.targetScope === 'all') return true;
  if (rule.targetScope === 'hall') return cake.category === 'hall';
  if (rule.targetScope === 'cut') return cake.category === 'cut';
  if (rule.targetScope === 'custom') {
    return Array.isArray(rule.targetCakeIds) && rule.targetCakeIds.includes(cake.id);
  }
  return false;
}

export async function addSalesStopRule(input: {
  label: string;
  scheduledAt: string;
  targetScope: 'all' | 'hall' | 'cut' | 'custom';
  targetCakeIds?: string[];
}): Promise<{ rules: SalesStopScheduleRule[]; cakes: Cake[]; executedImmediately: boolean }> {
  const [currentRules, currentCakes] = await Promise.all([
    fetchSalesStopRules(),
    fetchCakes(),
  ]);

  const nowIso = new Date().toISOString();
  const alreadyElapsed = isScheduledStopTimeElapsed(input.scheduledAt);

  const newRule: SalesStopScheduleRule = sanitizeScheduleRule({
    id: `sched_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    label: input.label.trim() || '自動販売停止スケジュール',
    scheduledAt: input.scheduledAt.trim(),
    targetScope: input.targetScope,
    targetCakeIds: input.targetCakeIds,
    enabled: true,
    executed: alreadyElapsed,
    ...(alreadyElapsed ? { executedAt: nowIso } : {}),
    createdAt: nowIso,
  }, currentRules.length);

  const nextRules = await saveSalesStopRules([...currentRules, newRule]);

  // Also stamp stopSellingAt (and isSoldOut if already elapsed) on matching cakes
  const nextCakes = currentCakes.map(cake => {
    if (!doesRuleMatchCake(newRule, cake)) return cake;
    const updatedCake: Cake = {
      ...cake,
      stopSellingAt: newRule.scheduledAt,
    };
    if (alreadyElapsed) {
      updatedCake.isSoldOut = true;
      updatedCake.autoStoppedAt = nowIso;
    }
    return updatedCake;
  });

  await saveCakes(nextCakes);
  return { rules: nextRules, cakes: nextCakes, executedImmediately: alreadyElapsed };
}

export async function toggleSalesStopRule(
  ruleId: string,
  enabled: boolean
): Promise<{ rules: SalesStopScheduleRule[]; cakes: Cake[] }> {
  const [currentRules, currentCakes] = await Promise.all([
    fetchSalesStopRules(),
    fetchCakes(),
  ]);

  const targetRule = currentRules.find(r => r.id === ruleId);
  const nextRules = await saveSalesStopRules(
    currentRules.map(r => (r.id === ruleId ? { ...r, enabled } : r))
  );

  let nextCakes = currentCakes;
  if (targetRule) {
    if (!enabled) {
      // Clear stopSellingAt on matching cakes if it matched this rule's scheduledAt
      nextCakes = currentCakes.map(cake => {
        if (doesRuleMatchCake(targetRule, cake) && cake.stopSellingAt === targetRule.scheduledAt) {
          const copy: Cake = { ...cake };
          delete copy.stopSellingAt;
          return copy;
        }
        return cake;
      });
      await saveCakes(nextCakes);
    } else if (!targetRule.executed) {
      nextCakes = currentCakes.map(cake => {
        if (doesRuleMatchCake(targetRule, cake)) {
          return { ...cake, stopSellingAt: targetRule.scheduledAt };
        }
        return cake;
      });
      await saveCakes(nextCakes);
    }
  }

  return { rules: nextRules, cakes: nextCakes };
}

export async function deleteSalesStopRule(
  ruleId: string
): Promise<{ rules: SalesStopScheduleRule[]; cakes: Cake[] }> {
  const [currentRules, currentCakes] = await Promise.all([
    fetchSalesStopRules(),
    fetchCakes(),
  ]);

  const targetRule = currentRules.find(r => r.id === ruleId);
  const remainingRules = await saveSalesStopRules(currentRules.filter(r => r.id !== ruleId));

  let nextCakes = currentCakes;
  if (targetRule) {
    nextCakes = currentCakes.map(cake => {
      if (doesRuleMatchCake(targetRule, cake) && cake.stopSellingAt === targetRule.scheduledAt) {
        const copy: Cake = { ...cake };
        delete copy.stopSellingAt;
        return copy;
      }
      return cake;
    });
    await saveCakes(nextCakes);
  }

  return { rules: remainingRules, cakes: nextCakes };
}

/**
 * Evaluates all active sales-stop schedule rules and per-cake stopSellingAt timestamps.
 * If any scheduled date/time has elapsed, transitions matching cakes to sold-out (販売停止)
 * and persists the updated status to Firestore.
 */
export async function evaluateAndExecuteSalesSchedules(): Promise<{
  triggered: boolean;
  cakes: Cake[];
  rules: SalesStopScheduleRule[];
  triggeredCakeNames: string[];
}> {
  ensureFirebaseInitialized();
  const [rules, rawCakes] = await Promise.all([
    fetchSalesStopRules(),
    fetchCakes(),
  ]);

  const nowIso = new Date().toISOString();
  let rulesChanged = false;
  let cakesChanged = false;
  const triggeredNameSet = new Set<string>();

  // 1. Check rule-level schedules
  const updatedRules = rules.map(rule => {
    if (rule.enabled && !rule.executed && isScheduledStopTimeElapsed(rule.scheduledAt)) {
      rulesChanged = true;
      return {
        ...rule,
        executed: true,
        executedAt: nowIso,
      };
    }
    return rule;
  });

  // 2. Check both triggered rules and individual cake stopSellingAt
  const updatedCakes = rawCakes.map(cake => {
    const matchedElapsedRule = rules.find(
      rule => rule.enabled && !rule.executed && isScheduledStopTimeElapsed(rule.scheduledAt) && doesRuleMatchCake(rule, cake)
    );
    const individualElapsed = cake.stopSellingAt && isScheduledStopTimeElapsed(cake.stopSellingAt);

    if (matchedElapsedRule || individualElapsed) {
      if (!cake.isSoldOut || !cake.autoStoppedAt) {
        cakesChanged = true;
        triggeredNameSet.add(cake.jpName);
        return {
          ...cake,
          isSoldOut: true,
          autoStoppedAt: cake.autoStoppedAt || nowIso,
        };
      }
    }
    return cake;
  });

  if (rulesChanged) {
    await saveSalesStopRules(updatedRules);
  }
  if (cakesChanged) {
    await saveCakes(updatedCakes);
  }

  return {
    triggered: rulesChanged || cakesChanged,
    cakes: updatedCakes,
    rules: updatedRules,
    triggeredCakeNames: Array.from(triggeredNameSet),
  };
}

