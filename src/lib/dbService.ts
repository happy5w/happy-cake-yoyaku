import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { getFirestore, collection, addDoc, doc, updateDoc, getDocs, query, orderBy, where, setDoc, getDoc, getDocFromServer, writeBatch, onSnapshot, runTransaction, deleteDoc, deleteField } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { Reservation, ReservationStatus, Cake, CancellationNotification, SalesStopScheduleRule } from '../types';
import { CAKES } from '../data/cakes';

export class SoldOutConflictError extends Error {
  code = 'SOLD_OUT_CONFLICT';
  soldOutCakeIds: string[];
  soldOutCakeNames: string[];

  constructor(soldOutCakeIds: string[], soldOutCakeNames: string[], customMessage?: string) {
    super(
      customMessage ||
        `申し訳ございません。「${soldOutCakeNames.join('」「')}」は現在売り切れ（オーダーストップ）のためご予約いただけません。`
    );
    this.name = 'SoldOutConflictError';
    this.soldOutCakeIds = soldOutCakeIds;
    this.soldOutCakeNames = soldOutCakeNames;
  }
}

export class FirestoreQuotaError extends Error {
  code = 'resource-exhausted';
  constructor(message = 'ただいまアクセスが集中しています。少し時間をおいて再度お試しください。') {
    super(message);
    this.name = 'FirestoreQuotaError';
  }
}

export class FirestoreConnectionError extends Error {
  code = 'unavailable';
  constructor(message = '通信が混雑しているか不安定なため、サーバーに接続できませんでした。少し時間をおいて再度お試しください。') {
    super(message);
    this.name = 'FirestoreConnectionError';
  }
}

export function isQuotaExceededError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof FirestoreQuotaError) return true;
  const code = String((err as any)?.code || '').toLowerCase();
  const msg = String((err as any)?.message || err || '').toLowerCase();
  return (
    code === 'resource-exhausted' ||
    msg.includes('resource-exhausted') ||
    msg.includes('quota exceeded') ||
    msg.includes('quota')
  );
}

export function getFriendlyFirebaseErrorMessage(err: unknown, context: 'load' | 'write'): string {
  if (err instanceof SoldOutConflictError || (err as any)?.code === 'SOLD_OUT_CONFLICT') {
    return (err as Error).message;
  }
  const quota = isQuotaExceededError(err);
  if (context === 'write') {
    if (quota) {
      return '予約は完了していません。ただいまアクセスが集中しているため予約を受け付けられませんでした。二重予約を防ぐため、少し時間をおいて「予約確認・変更」画面で予約が入っていないかご確認の上、再度お試しください。';
    }
    return '予約は完了していません。通信が混雑しているか不安定なため、予約の確定を確認できませんでした。少し時間をおいて再度お試しください。';
  }
  if (quota) {
    return 'ただいまアクセスが集中しています。少し時間をおいて再度お試しください。';
  }
  return 'ただいまアクセスが集中しているか、通信が不安定なため読み込めませんでした。少し時間をおいて再度お試しください。';
}

// In-memory short TTL cache to reduce redundant Firestore reads on Spark plan
const READ_CACHE_TTL_MS = 60_000;
let cachedBusinessDays: { data: string[]; fetchedAt: number } | null = null;
let inFlightBusinessDaysPromise: Promise<string[]> | null = null;
let cachedCakes: { data: Cake[]; fetchedAt: number } | null = null;
let inFlightCakesPromise: Promise<Cake[]> | null = null;
let cachedSalesStopRules: { data: SalesStopScheduleRule[]; fetchedAt: number } | null = null;
let inFlightSalesStopRulesPromise: Promise<SalesStopScheduleRule[]> | null = null;

const DELETED_DEFAULT_CAKES_KEY = 'cakes_deleted_default_ids';
const MAX_CAKES_CATALOG_BYTES = 880_000;

function getLocalDeletedDefaultIds(): string[] {
  try {
    const raw = localStorage.getItem(DELETED_DEFAULT_CAKES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
  } catch {
    return [];
  }
}

function saveLocalDeletedDefaultIds(ids: string[]): void {
  try {
    localStorage.setItem(DELETED_DEFAULT_CAKES_KEY, JSON.stringify(Array.from(new Set(ids))));
  } catch {}
}

export async function compressImageDataUrlToBudget(
  dataUrl: string,
  targetMaxChars: number = 72_000
): Promise<string> {
  if (
    !dataUrl ||
    !dataUrl.startsWith('data:image/') ||
    dataUrl.length <= targetMaxChars ||
    typeof document === 'undefined'
  ) {
    return dataUrl;
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const steps = [
        { maxDim: 520, quality: 0.72 },
        { maxDim: 420, quality: 0.62 },
        { maxDim: 340, quality: 0.52 },
        { maxDim: 260, quality: 0.45 },
      ];
      let best = dataUrl;
      for (const step of steps) {
        let width = img.width || step.maxDim;
        let height = img.height || step.maxDim;
        if (width > step.maxDim || height > step.maxDim) {
          if (width > height) {
            height = Math.max(1, Math.round((height * step.maxDim) / width));
            width = step.maxDim;
          } else {
            width = Math.max(1, Math.round((width * step.maxDim) / height));
            height = step.maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) break;
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        const candidate = canvas.toDataURL('image/jpeg', step.quality);
        if (candidate.length < best.length) {
          best = candidate;
        }
        if (best.length <= targetMaxChars) {
          break;
        }
      }
      resolve(best);
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function getUtf8ByteLength(obj: unknown): number {
  const json = JSON.stringify(obj);
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(json).length;
  }
  return json.length * 2;
}

async function fitCakesPayloadUnderFirestoreLimit(
  cakes: Cake[],
  deletedDefaultIds: string[],
  updatedAt: string
): Promise<Cake[]> {
  let working = cakes;
  const checkSize = (list: Cake[]) =>
    getUtf8ByteLength({ cakes: list, deletedDefaultIds, updatedAt });

  if (checkSize(working) <= MAX_CAKES_CATALOG_BYTES || typeof document === 'undefined') {
    return working;
  }

  // Progressively compress inline Data URL images so all cakes fit comfortably inside Firestore's 1 MiB document limit
  const budgets = [65_000, 42_000, 26_000];
  for (const budget of budgets) {
    working = await Promise.all(
      working.map(async (cake) => {
        if (!cake.imageUrl || !cake.imageUrl.startsWith('data:image/') || cake.imageUrl.length <= budget) {
          return cake;
        }
        const compressed = await compressImageDataUrlToBudget(cake.imageUrl, budget);
        return { ...cake, imageUrl: compressed };
      })
    );
    if (checkSize(working) <= MAX_CAKES_CATALOG_BYTES) {
      break;
    }
  }
  return working;
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

export function getJstTodayStr(): string {
  const todayJst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  return `${todayJst.getFullYear()}-${String(todayJst.getMonth() + 1).padStart(2, '0')}-${String(todayJst.getDate()).padStart(2, '0')}`;
}

export function getDaysDiffFromTodayJst(dateStr: string, todayStr: string = getJstTodayStr()): number {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return -9999;
  const targetMs = new Date(`${dateStr}T00:00:00+09:00`).getTime();
  const todayMs = new Date(`${todayStr}T00:00:00+09:00`).getTime();
  if (isNaN(targetMs) || isNaN(todayMs)) return -9999;
  return Math.round((targetMs - todayMs) / (1000 * 60 * 60 * 24));
}

export const RESERVATION_DEADLINE_DATE = '2026-12-18';
export const RESERVATION_DEADLINE_LABEL = '12/18（金）まで';

export function isReservationDeadlinePassed(todayStr: string = getJstTodayStr()): boolean {
  return todayStr > RESERVATION_DEADLINE_DATE;
}

export function isBusinessDayClosed(dateStr: string, todayStr: string = getJstTodayStr()): boolean {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return true;
  return isReservationDeadlinePassed(todayStr) || dateStr <= todayStr;
}

export function getReservableBusinessDays(businessDays: string[]): string[] {
  const todayStr = getJstTodayStr();
  return Array.from(
    new Set((Array.isArray(businessDays) ? businessDays : []).filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)))
  )
    .sort()
    .filter((d) => !isBusinessDayClosed(d, todayStr));
}

export function getUpcomingBusinessDays(businessDays: string[]): string[] {
  const todayStr = getJstTodayStr();
  return Array.from(
    new Set((Array.isArray(businessDays) ? businessDays : []).filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)))
  )
    .sort()
    .filter((d) => d >= todayStr);
}

export function formatBusinessDateLabel(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(`${dateStr}T00:00:00+09:00`);
    if (isNaN(d.getTime())) return dateStr;
    const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
    return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日 (${weekdays[d.getDay()]})`;
  } catch {
    return dateStr;
  }
}

export function formatShortBusinessDateLabel(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(`${dateStr}T00:00:00+09:00`);
    if (isNaN(d.getTime())) return dateStr;
    const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
    return `${d.getMonth() + 1}/${d.getDate()}(${weekdays[d.getDay()]})`;
  } catch {
    return dateStr;
  }
}

export function sanitizeStockByDate(raw: any): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const todayStr = getJstTodayStr();
  const result: Record<string, number> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    // Prune entries older than 30 days to keep Firestore document lightweight
    if (getDaysDiffFromTodayJst(key, todayStr) < -30) continue;
    if (typeof val === 'number' && !isNaN(val) && isFinite(val)) {
      result[key] = Math.max(0, Math.floor(val));
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function getEffectiveStockForDate(cake: Cake | undefined | null, dateStr?: string): number | undefined {
  if (!cake) return undefined;
  if (dateStr && cake.stockByDate && typeof cake.stockByDate[dateStr] === 'number' && !isNaN(cake.stockByDate[dateStr])) {
    return Math.max(0, Math.floor(cake.stockByDate[dateStr]));
  }
  if (typeof cake.stock === 'number' && !isNaN(cake.stock)) {
    return Math.max(0, Math.floor(cake.stock));
  }
  return undefined;
}

export function isCakeSoldOutForDate(cake: Cake | undefined | null, dateStr?: string): boolean {
  if (!cake) return true;
  if (cake.isSoldOut) return true;
  const effectiveStock = getEffectiveStockForDate(cake, dateStr);
  return typeof effectiveStock === 'number' && effectiveStock <= 0;
}

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
  const hasStock = typeof c?.stock === 'number' && !isNaN(c.stock) && isFinite(c.stock);
  const stock = hasStock ? Math.max(0, Math.floor(c.stock)) : undefined;
  const stockByDate = sanitizeStockByDate(c?.stockByDate);
  const hasPositiveDateStock = Boolean(stockByDate && Object.values(stockByDate).some((v) => v > 0));
  const stockDepleted = stock !== undefined && stock <= 0 && !hasPositiveDateStock;
  const isSoldOut = Boolean(c?.isSoldOut) || stockDepleted;
  const autoStoppedAt =
    isSoldOut && typeof c?.autoStoppedAt === 'string' && c.autoStoppedAt.trim()
      ? c.autoStoppedAt.trim()
      : undefined;

  const hasPortionLabel = c?.portionLabel !== undefined && c?.portionLabel !== null;

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
    ...(stock !== undefined ? { stock } : {}),
    ...(stockByDate ? { stockByDate } : {}),
    ...(hasPortionLabel ? { portionLabel: String(c.portionLabel) } : {}),
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
export async function createReservation(
  reservation: Omit<Reservation, 'id' | 'createdAt' | 'updatedAt' | 'status'>,
  customId?: string
): Promise<Reservation> {
  ensureFirebaseInitialized();
  const todayStr = getJstTodayStr();
  if (isReservationDeadlinePassed(todayStr)) {
    throw new SoldOutConflictError([], [], '予約は完了していません。ご予約受付は12/18（金）をもって終了いたしました。');
  }
  if (!reservation.date || isBusinessDayClosed(reservation.date, todayStr)) {
    throw new SoldOutConflictError([], [], '予約は完了していません。選択されたお受取り日はご予約受付を終了しております。');
  }

  const timestamp = new Date().toISOString();
  const id = (customId && customId.trim()) ? customId.trim() : ('res_' + Math.random().toString(36).substr(2, 9));
  
  const newReservation: Reservation = sanitizeReservation({
    ...reservation,
    id,
    status: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp
  }, 0);

  const applyStockDeduction = (
    catalog: Cake[],
    items: Reservation['items'],
    reservationDate: string,
    ts: string,
    activeRules: SalesStopScheduleRule[] = []
  ): { updatedCatalog: Cake[]; stockChanged: boolean } => {
    const effectiveCatalog = applySalesStopRulesInMemory(catalog, activeRules);
    const rulesTriggeredAny = effectiveCatalog.some((c, i) => Boolean(c.isSoldOut) !== Boolean(catalog[i]?.isSoldOut));

    const qtyByCakeId = new Map<string, number>();
    for (const item of items) {
      qtyByCakeId.set(item.cakeId, (qtyByCakeId.get(item.cakeId) || 0) + (Number(item.quantity) || 0));
    }

    const soldOutIds: string[] = [];
    const soldOutNames: string[] = [];
    const insufficientIds: string[] = [];
    const insufficientNames: string[] = [];
    const insufficientMsgs: string[] = [];

    for (const [cakeId, orderedQty] of qtyByCakeId.entries()) {
      const targetCake = effectiveCatalog.find(c => c.id === cakeId);
      const itemSample = items.find(i => i.cakeId === cakeId);
      const displayName = targetCake?.jpName || itemSample?.cakeName || '選択されたケーキ';
      const effectiveStock = getEffectiveStockForDate(targetCake, reservationDate);

      if (!targetCake || targetCake.isSoldOut || (typeof effectiveStock === 'number' && effectiveStock <= 0)) {
        soldOutIds.push(cakeId);
        soldOutNames.push(displayName);
      } else if (typeof effectiveStock === 'number' && orderedQty > effectiveStock) {
        insufficientIds.push(cakeId);
        insufficientNames.push(displayName);
        const dateSuffix = reservationDate ? `（${formatShortBusinessDateLabel(reservationDate)}分）` : '';
        if (effectiveStock <= 10) {
          insufficientMsgs.push(`「${displayName}」${dateSuffix}は残りわずかのため、ご希望数（${orderedQty}個）をご用意できません`);
        } else {
          insufficientMsgs.push(`「${displayName}」${dateSuffix}の在庫上限（${effectiveStock}個）を超えています（ご注文数：${orderedQty}個）`);
        }
      }
    }

    if (soldOutIds.length > 0) {
      throw new SoldOutConflictError(soldOutIds, soldOutNames);
    }
    if (insufficientIds.length > 0) {
      throw new SoldOutConflictError(
        insufficientIds,
        insufficientNames,
        `予約は完了していません。${insufficientMsgs.join(' / ')}。数量を減らして再度お試しください。`
      );
    }

    let stockChanged = rulesTriggeredAny;
    const updatedCatalog = effectiveCatalog.map((cake) => {
      const orderedQty = qtyByCakeId.get(cake.id);
      if (!orderedQty) return cake;

      const hasDateStock =
        Boolean(reservationDate) &&
        Boolean(cake.stockByDate) &&
        typeof cake.stockByDate?.[reservationDate] === 'number';

      if (hasDateStock && cake.stockByDate) {
        stockChanged = true;
        const nextDateStock = Math.max(0, cake.stockByDate[reservationDate] - orderedQty);
        return {
          ...cake,
          stockByDate: {
            ...cake.stockByDate,
            [reservationDate]: nextDateStock,
          },
        };
      }

      if (typeof cake.stock === 'number') {
        stockChanged = true;
        const nextStock = Math.max(0, cake.stock - orderedQty);
        const hasPositiveDateEntries = Boolean(
          cake.stockByDate && Object.values(cake.stockByDate).some((v) => typeof v === 'number' && v > 0)
        );
        const reachedGlobalZero = nextStock <= 0 && !hasPositiveDateEntries;
        return {
          ...cake,
          stock: nextStock,
          isSoldOut: Boolean(cake.isSoldOut) || reachedGlobalZero,
          ...(reachedGlobalZero && !cake.autoStoppedAt ? { autoStoppedAt: ts } : {}),
        };
      }

      return cake;
    });

    return { updatedCatalog, stockChanged };
  };

  // 1. Atomic stock verification, deduction & reservation creation in Firestore (排他制御)
  if (isFirebaseReady && dbInstance) {
    const resRef = doc(dbInstance, 'reservations', id);
    const catalogRef = doc(dbInstance, 'settings', 'cakes_catalog');
    const schedulerRef = doc(dbInstance, 'settings', 'sales_scheduler');
    let committedCatalog: Cake[] | null = null;

    const transactionPromise = runTransaction(dbInstance, async (transaction) => {
      const [resSnap, catalogSnap, schedulerSnap] = await Promise.all([
        transaction.get(resRef),
        transaction.get(catalogRef),
        transaction.get(schedulerRef),
      ]);

      // Idempotency guard: if this exact reservation ID was already saved, do not deduct stock twice
      if (resSnap.exists()) {
        return;
      }

      let latestCatalog: Cake[] = CAKES;
      let txDeletedIds: string[] = getLocalDeletedDefaultIds();
      if (catalogSnap.exists() && Array.isArray(catalogSnap.data().cakes)) {
        if (Array.isArray(catalogSnap.data().deletedDefaultIds)) {
          txDeletedIds = catalogSnap.data().deletedDefaultIds.filter((d: any): d is string => typeof d === 'string');
        }
        const rawList = catalogSnap.data().cakes.filter(Boolean).map((c: any, idx: number) => sanitizeCake(c, idx));
        latestCatalog = reconcileWithDefaultCakes(rawList, txDeletedIds).cakes;
      } else {
        const localRaw = localStorage.getItem('cakes_catalog_list');
        if (localRaw) {
          try {
            const parsed = JSON.parse(localRaw);
            if (Array.isArray(parsed) && parsed.length > 0) {
              const rawList = parsed.filter(Boolean).map((c: any, idx: number) => sanitizeCake(c, idx));
              latestCatalog = reconcileWithDefaultCakes(rawList, txDeletedIds).cakes;
            }
          } catch {}
        }
      }

      const activeRules: SalesStopScheduleRule[] =
        schedulerSnap.exists() && Array.isArray(schedulerSnap.data().rules)
          ? schedulerSnap.data().rules.filter(Boolean).map((r: any, idx: number) => sanitizeScheduleRule(r, idx))
          : getLocalScheduleRules();

      const { updatedCatalog, stockChanged } = applyStockDeduction(
        latestCatalog,
        newReservation.items,
        newReservation.date,
        timestamp,
        activeRules
      );
      committedCatalog = updatedCatalog;

      if (stockChanged || !catalogSnap.exists()) {
        transaction.set(catalogRef, { cakes: updatedCatalog, deletedDefaultIds: txDeletedIds, updatedAt: timestamp }, { merge: true });
      }
      transaction.set(resRef, { ...newReservation });
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new FirestoreConnectionError('Firestore reservation transaction timeout')), 12000)
    );

    try {
      await Promise.race([transactionPromise, timeoutPromise]);
      if (committedCatalog) {
        cachedCakes = { data: committedCatalog, fetchedAt: Date.now() };
        try {
          localStorage.setItem('cakes_catalog_list', JSON.stringify(committedCatalog));
          localStorage.setItem('cakes_catalog_updated_at', timestamp);
        } catch {}
      }
    } catch (error) {
      // Never swallow SoldOutConflictError — rethrow immediately to block the reservation
      if (error instanceof SoldOutConflictError || (error as any)?.code === 'SOLD_OUT_CONFLICT') {
        throw error;
      }
      // Never retry or fall back to fake success if Spark quota is exhausted
      if (isQuotaExceededError(error)) {
        throw new FirestoreQuotaError(getFriendlyFirebaseErrorMessage(error, 'write'));
      }
      console.warn('Firestore reservation transaction notice (attempting verified fallback):', error);

      // Check if reservation already landed on server before attempting direct fallback
      try {
        const existingSnap = await getDoc(resRef);
        if (existingSnap.exists()) {
          const freshCatalog = await fetchCakesStrict(true);
          cachedCakes = { data: freshCatalog, fetchedAt: Date.now() };
          try {
            localStorage.setItem('cakes_catalog_list', JSON.stringify(freshCatalog));
          } catch {}
          // Already committed on server
          const current = getLocalReservations();
          const filtered = current.filter(r => r.id !== newReservation.id);
          filtered.unshift(newReservation);
          saveLocalReservations(filtered);
          return newReservation;
        }
      } catch (checkErr) {
        if (isQuotaExceededError(checkErr)) {
          throw new FirestoreQuotaError(getFriendlyFirebaseErrorMessage(checkErr, 'write'));
        }
      }

      // Verify latest catalog & scheduler strictly before direct write fallback
      const [fallbackCakes, fallbackRules] = await Promise.all([
        fetchCakesStrict(true),
        fetchSalesStopRules(true),
      ]);
      const { updatedCatalog, stockChanged } = applyStockDeduction(
        fallbackCakes,
        newReservation.items,
        newReservation.date,
        timestamp,
        fallbackRules
      );

      try {
        const writePromises: Promise<any>[] = [setDoc(resRef, { ...newReservation })];
        if (stockChanged) {
          writePromises.push(
            setDoc(catalogRef, { cakes: updatedCatalog, deletedDefaultIds: getLocalDeletedDefaultIds(), updatedAt: timestamp }, { merge: true })
          );
        }
        const directWrite = Promise.all(writePromises);
        const writeTimeout = new Promise((_, reject) =>
          setTimeout(() => reject(new FirestoreConnectionError('Firestore direct reservation write timeout')), 8000)
        );
        await Promise.race([directWrite, writeTimeout]);
        if (stockChanged) {
          cachedCakes = { data: updatedCatalog, fetchedAt: Date.now() };
          try {
            localStorage.setItem('cakes_catalog_list', JSON.stringify(updatedCatalog));
            localStorage.setItem('cakes_catalog_updated_at', timestamp);
          } catch {}
        }
      } catch (writeErr) {
        console.error('Firestore direct reservation write failed:', writeErr);
        if (isQuotaExceededError(writeErr)) {
          throw new FirestoreQuotaError(getFriendlyFirebaseErrorMessage(writeErr, 'write'));
        }
        throw new FirestoreConnectionError(getFriendlyFirebaseErrorMessage(writeErr, 'write'));
      }
    }
  } else {
    // Non-Firebase local preview mode only: verify & deduct against local catalog
    const [latestCatalog, latestRules] = await Promise.all([fetchCakes(), fetchSalesStopRules()]);
    const { updatedCatalog, stockChanged } = applyStockDeduction(
      latestCatalog,
      newReservation.items,
      newReservation.date,
      timestamp,
      latestRules
    );
    if (stockChanged) {
      await saveCakes(updatedCatalog);
    }
  }

  // 2. Persist to LocalStorage ONLY after Firestore write & stock check succeeded
  const current = getLocalReservations();
  const filtered = current.filter(r => r.id !== newReservation.id);
  filtered.unshift(newReservation);
  saveLocalReservations(filtered);

  return newReservation;
}

function buildPhoneQueryCandidates(rawInput: string): string[] {
  const trimmed = rawInput.trim();
  const digits = trimmed.replace(/[-\s　()（）]/g, '');
  const candidates = new Set<string>();
  if (trimmed) candidates.add(trimmed);
  if (digits) candidates.add(digits);
  if (digits.length === 11) {
    candidates.add(`${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`);
  } else if (digits.length === 10) {
    candidates.add(`${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`);
    candidates.add(`${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`);
    candidates.add(`${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`);
  }
  return Array.from(candidates).slice(0, 10);
}

export async function fetchReservations(userEmail?: string): Promise<Reservation[]> {
  ensureFirebaseInitialized();
  const localItems = getLocalReservations();
  const isCustomerScoped = Boolean(userEmail && userEmail !== ADMIN_EMAIL);

  if (isCustomerScoped && userEmail) {
    const rawQuery = userEmail.trim();
    const qLower = rawQuery.toLowerCase();
    const qDigits = rawQuery.replace(/[-\s　()（）]/g, '');

    if (isFirebaseReady && dbInstance) {
      const resCollection = collection(dbInstance, 'reservations');
      const queries = [];
      if (rawQuery.includes('@')) {
        queries.push(query(resCollection, where('email', '==', rawQuery)));
        if (rawQuery !== qLower) {
          queries.push(query(resCollection, where('email', '==', qLower)));
        }
      } else {
        const phoneCandidates = buildPhoneQueryCandidates(rawQuery);
        if (phoneCandidates.length > 0) {
          queries.push(query(resCollection, where('phone', 'in', phoneCandidates)));
        }
      }

      if (queries.length > 0) {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new FirestoreConnectionError('Firestore reservation lookup timeout')), 6000)
        );
        try {
          const snapshots = await Promise.race([
            Promise.all(queries.map(q => getDocs(q))),
            timeoutPromise
          ]);
          const cloudMap = new Map<string, Reservation>();
          for (const snap of snapshots) {
            snap.forEach((d) => {
              const cloudItem = sanitizeReservation({ id: d.id, ...(d.data() as Record<string, any>) }, cloudMap.size);
              const existing = cloudMap.get(cloudItem.id);
              if (!existing || (cloudItem.updatedAt || '') >= (existing.updatedAt || '')) {
                cloudMap.set(cloudItem.id, cloudItem);
              }
            });
          }
          // Sync matching localStorage entries with authoritative cloud results so deleted records never linger
          const filteredLocal = localItems.filter((item) => {
            const itemEmail = (item.email || '').toLowerCase().trim();
            const itemPhoneDigits = (item.phone || '').replace(/[-\s　()（）]/g, '');
            const matchesScope = rawQuery.includes('@')
              ? itemEmail === qLower
              : (qDigits.length >= 7 && itemPhoneDigits.includes(qDigits));
            return !matchesScope;
          });
          saveLocalReservations([...cloudMap.values(), ...filteredLocal]);
          return Array.from(cloudMap.values()).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        } catch (error) {
          if (isQuotaExceededError(error)) {
            throw new FirestoreQuotaError(getFriendlyFirebaseErrorMessage(error, 'load'));
          }
          throw new FirestoreConnectionError(getFriendlyFirebaseErrorMessage(error, 'load'));
        }
      }
      return [];
    }

    // Non-Firebase local preview mode fallback
    const localMatches = localItems.filter((item) => {
      const itemEmail = (item.email || '').toLowerCase().trim();
      const itemPhoneDigits = (item.phone || '').replace(/[-\s　()（）]/g, '');
      return itemEmail === qLower || (qDigits.length >= 7 && itemPhoneDigits.includes(qDigits));
    });
    return localMatches.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  if (isFirebaseReady && dbInstance) {
    const path = 'reservations';
    try {
      const resCollection = collection(dbInstance, path);
      const fetchPromise = getDocs(resCollection);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new FirestoreConnectionError('Firestore reservations fetch timeout')), 6000)
      );
      const snapshot = await Promise.race([fetchPromise, timeoutPromise]);
      const cloudItems: Reservation[] = [];
      snapshot.forEach((d) => {
        cloudItems.push(sanitizeReservation({ id: d.id, ...d.data() }, cloudItems.length));
      });
      // Cloud Firestore is authoritative: replace localStorage cache so deleted reservations never resurrect
      saveLocalReservations(cloudItems);
      return cloudItems.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    } catch (error) {
      if (isQuotaExceededError(error)) {
        throw new FirestoreQuotaError(getFriendlyFirebaseErrorMessage(error, 'load'));
      }
      console.warn('Firestore reservations fetch notice (using local cache):', error);
    }
  }

  return [...localItems].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function updateReservationStatus(
  id: string,
  status: ReservationStatus,
  options?: { isCustomerRequest?: boolean }
): Promise<void> {
  ensureFirebaseInitialized();
  if (options?.isCustomerRequest && status === 'cancelled' && isReservationDeadlinePassed()) {
    throw new Error('12/18（金）の予約締切を過ぎたため、Webからのキャンセルはできません。お電話（043-239-2520／平日 9：00～17：30）にてご連絡ください。');
  }
  const timestamp = new Date().toISOString();

  // 1. Snapshot LocalStorage prior state (only finalize local update after Firestore succeeds when online)
  const previousLocal = getLocalReservations();
  const current = previousLocal.map(r => ({ ...r }));
  const foundIndex = current.findIndex(r => r.id === id);
  let targetReservation: Reservation | null = null;
  let wasAlreadyCancelledLocally = false;
  if (foundIndex !== -1) {
    wasAlreadyCancelledLocally = current[foundIndex].status === 'cancelled';
    current[foundIndex].status = status;
    current[foundIndex].updatedAt = timestamp;
    if (status === 'cancelled') {
      current[foundIndex].cancelledAt = timestamp;
    } else {
      delete current[foundIndex].cancelledAt;
    }
    targetReservation = current[foundIndex];
  }

  // 2. Sync status update (and stock restoration/re-deduction) to Firestore
  if (isFirebaseReady && dbInstance) {
    let cloudPrevStatus: ReservationStatus | null = null;
    let cloudResData: Reservation | null = targetReservation;

    try {
      const resRef = doc(dbInstance, 'reservations', id);
      const catalogRef = doc(dbInstance, 'settings', 'cakes_catalog');
      let updatedCatalogForCache: Cake[] | null = null;

      const txPromise = runTransaction(dbInstance, async (transaction) => {
        const resSnap = await transaction.get(resRef);
        const prevStatus: ReservationStatus | null = resSnap.exists()
          ? (resSnap.data().status as ReservationStatus)
          : (wasAlreadyCancelledLocally ? 'cancelled' : null);
        cloudPrevStatus = prevStatus;

        const baseRes: Reservation | null = resSnap.exists()
          ? sanitizeReservation({ id: resSnap.id, ...resSnap.data() }, 0)
          : targetReservation;
        if (baseRes) {
          cloudResData = {
            ...baseRes,
            status,
            updatedAt: timestamp,
            ...(status === 'cancelled' ? { cancelledAt: timestamp } : {}),
          };
          if (status !== 'cancelled') {
            delete cloudResData.cancelledAt;
          }
        }

        const resDate: string = baseRes?.date || '';
        const items: Reservation['items'] = baseRes?.items || [];

        const needsStockRestore = prevStatus !== 'cancelled' && status === 'cancelled' && items.length > 0;
        const needsStockRededuct = prevStatus === 'cancelled' && status !== 'cancelled' && items.length > 0;

        if (needsStockRestore || needsStockRededuct) {
          const catalogSnap = await transaction.get(catalogRef);
          if (catalogSnap.exists() && Array.isArray(catalogSnap.data().cakes)) {
            const txDeletedIds: string[] = Array.isArray(catalogSnap.data().deletedDefaultIds)
              ? catalogSnap.data().deletedDefaultIds.filter((d: any): d is string => typeof d === 'string')
              : getLocalDeletedDefaultIds();
            const rawList = catalogSnap.data().cakes.filter(Boolean).map((c: any, idx: number) => sanitizeCake(c, idx));
            const latestCatalog = reconcileWithDefaultCakes(rawList, txDeletedIds).cakes;

            const qtyMap = new Map<string, number>();
            for (const item of items) {
              if (item?.cakeId) {
                qtyMap.set(item.cakeId, (qtyMap.get(item.cakeId) || 0) + (Number(item.quantity) || 0));
              }
            }

            if (needsStockRestore) {
              let catalogChanged = false;
              const nextCatalog = latestCatalog.map((cake) => {
                const restoreQty = qtyMap.get(cake.id);
                if (!restoreQty) return cake;

                if (resDate && cake.stockByDate && typeof cake.stockByDate[resDate] === 'number') {
                  catalogChanged = true;
                  return {
                    ...cake,
                    stockByDate: {
                      ...cake.stockByDate,
                      [resDate]: cake.stockByDate[resDate] + restoreQty,
                    },
                  };
                }

                if (typeof cake.stock === 'number') {
                  catalogChanged = true;
                  const nextStock = cake.stock + restoreQty;
                  const wasAutoZero = cake.stock <= 0 && nextStock > 0;
                  const nextCake: Cake = {
                    ...cake,
                    stock: nextStock,
                    isSoldOut: wasAutoZero ? false : cake.isSoldOut,
                  };
                  if (wasAutoZero) {
                    delete nextCake.autoStoppedAt;
                  }
                  return nextCake;
                }

                return cake;
              });
              if (catalogChanged) {
                updatedCatalogForCache = nextCatalog;
                transaction.set(
                  catalogRef,
                  { cakes: nextCatalog, deletedDefaultIds: txDeletedIds, updatedAt: timestamp },
                  { merge: true }
                );
              }
            } else if (needsStockRededuct) {
              const soldOutIds: string[] = [];
              const soldOutNames: string[] = [];
              const insufficientIds: string[] = [];
              const insufficientNames: string[] = [];
              const insufficientMsgs: string[] = [];

              for (const [cakeId, orderedQty] of qtyMap.entries()) {
                const targetCake = latestCatalog.find(c => c.id === cakeId);
                const itemSample = items.find(i => i.cakeId === cakeId);
                const displayName = targetCake?.jpName || itemSample?.cakeName || '選択されたケーキ';
                const effectiveStock = getEffectiveStockForDate(targetCake, resDate);

                if (!targetCake || targetCake.isSoldOut || (typeof effectiveStock === 'number' && effectiveStock <= 0)) {
                  soldOutIds.push(cakeId);
                  soldOutNames.push(displayName);
                } else if (typeof effectiveStock === 'number' && orderedQty > effectiveStock) {
                  insufficientIds.push(cakeId);
                  insufficientNames.push(displayName);
                  const dateSuffix = resDate ? `（${formatShortBusinessDateLabel(resDate)}分）` : '';
                  if (effectiveStock <= 10) {
                    insufficientMsgs.push(`「${displayName}」${dateSuffix}は残りわずかのため、元のステータスに戻せません`);
                  } else {
                    insufficientMsgs.push(`「${displayName}」${dateSuffix}の在庫上限（${effectiveStock}個）を超えるため戻せません（必要数：${orderedQty}個）`);
                  }
                }
              }

              if (soldOutIds.length > 0) {
                throw new SoldOutConflictError(
                  soldOutIds,
                  soldOutNames,
                  `「${soldOutNames.join('」「')}」が現在売り切れのため、キャンセルから有効な予約へ戻すことができません。`
                );
              }
              if (insufficientIds.length > 0) {
                throw new SoldOutConflictError(insufficientIds, insufficientNames, insufficientMsgs.join(' / '));
              }

              let catalogChanged = false;
              const nextCatalog = latestCatalog.map((cake) => {
                const orderedQty = qtyMap.get(cake.id);
                if (!orderedQty) return cake;

                if (resDate && cake.stockByDate && typeof cake.stockByDate[resDate] === 'number') {
                  catalogChanged = true;
                  return {
                    ...cake,
                    stockByDate: {
                      ...cake.stockByDate,
                      [resDate]: Math.max(0, cake.stockByDate[resDate] - orderedQty),
                    },
                  };
                }

                if (typeof cake.stock === 'number') {
                  catalogChanged = true;
                  const nextStock = Math.max(0, cake.stock - orderedQty);
                  const hasPositiveDateEntries = Boolean(
                    cake.stockByDate && Object.values(cake.stockByDate).some((v) => typeof v === 'number' && v > 0)
                  );
                  const reachedGlobalZero = nextStock <= 0 && !hasPositiveDateEntries;
                  return {
                    ...cake,
                    stock: nextStock,
                    isSoldOut: Boolean(cake.isSoldOut) || reachedGlobalZero,
                    ...(reachedGlobalZero && !cake.autoStoppedAt ? { autoStoppedAt: timestamp } : {}),
                  };
                }

                return cake;
              });
              if (catalogChanged) {
                updatedCatalogForCache = nextCatalog;
                transaction.set(
                  catalogRef,
                  { cakes: nextCatalog, deletedDefaultIds: txDeletedIds, updatedAt: timestamp },
                  { merge: true }
                );
              }
            }
          }
        }

        if (status === 'cancelled') {
          transaction.set(
            resRef,
            {
              status: 'cancelled',
              updatedAt: timestamp,
              cancelledAt: timestamp,
            },
            { merge: true }
          );
        } else {
          transaction.set(
            resRef,
            {
              status,
              updatedAt: timestamp,
              cancelledAt: deleteField(),
            },
            { merge: true }
          );
        }
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Firestore status transaction timeout')), 7000)
      );
      await Promise.race([txPromise, timeoutPromise]);

      if (updatedCatalogForCache) {
        cachedCakes = { data: updatedCatalogForCache, fetchedAt: Date.now() };
        try {
          localStorage.setItem('cakes_catalog_list', JSON.stringify(updatedCatalogForCache));
          localStorage.setItem('cakes_catalog_updated_at', timestamp);
        } catch {}
      }

      if (foundIndex !== -1) {
        saveLocalReservations(current);
      }
      if (status === 'cancelled' && cloudResData) {
        await recordCancellationNotification(cloudResData, timestamp);
      } else if (status !== 'cancelled' && cloudPrevStatus === 'cancelled') {
        await removeCancellationNotification(id);
      }
    } catch (error) {
      saveLocalReservations(previousLocal);
      if (error instanceof SoldOutConflictError || (error as any)?.code === 'SOLD_OUT_CONFLICT') {
        throw error;
      }
      console.error('Firestore reservation status update failed:', error);
      if (isQuotaExceededError(error)) {
        throw new FirestoreQuotaError(getFriendlyFirebaseErrorMessage(error, 'write'));
      }
      throw new FirestoreConnectionError(
        '通信が混雑しているか不安定なため、ステータスの更新をサーバーへ反映できませんでした。少し時間をおいて再度お試しください。'
      );
    }
  } else {
    // Non-Firebase local preview mode
    if (status === 'cancelled' && !wasAlreadyCancelledLocally && targetReservation?.items?.length) {
      const latestCatalog = await fetchCakes();
      const resDate = targetReservation.date || '';
      let changed = false;
      const restoreMap = new Map<string, number>();
      for (const item of targetReservation.items) {
        restoreMap.set(item.cakeId, (restoreMap.get(item.cakeId) || 0) + (Number(item.quantity) || 0));
      }
      const nextCatalog = latestCatalog.map((cake) => {
        const q = restoreMap.get(cake.id);
        if (!q) return cake;
        if (resDate && cake.stockByDate && typeof cake.stockByDate[resDate] === 'number') {
          changed = true;
          return {
            ...cake,
            stockByDate: {
              ...cake.stockByDate,
              [resDate]: cake.stockByDate[resDate] + q,
            },
          };
        }
        if (typeof cake.stock === 'number') {
          changed = true;
          const nextStock = cake.stock + q;
          const wasAutoZero = cake.stock <= 0 && nextStock > 0;
          const nextCake: Cake = { ...cake, stock: nextStock, isSoldOut: wasAutoZero ? false : cake.isSoldOut };
          if (wasAutoZero) delete nextCake.autoStoppedAt;
          return nextCake;
        }
        return cake;
      });
      if (changed) {
        await saveCakes(nextCatalog);
      }
    } else if (status !== 'cancelled' && wasAlreadyCancelledLocally && targetReservation?.items?.length) {
      const latestCatalog = await fetchCakes();
      const resDate = targetReservation.date || '';
      const qtyMap = new Map<string, number>();
      for (const item of targetReservation.items) {
        qtyMap.set(item.cakeId, (qtyMap.get(item.cakeId) || 0) + (Number(item.quantity) || 0));
      }
      for (const [cakeId, orderedQty] of qtyMap.entries()) {
        const c = latestCatalog.find(x => x.id === cakeId);
        const eff = getEffectiveStockForDate(c, resDate);
        if (!c || c.isSoldOut || (typeof eff === 'number' && orderedQty > eff)) {
          saveLocalReservations(previousLocal);
          throw new SoldOutConflictError([cakeId], [c?.jpName || 'ケーキ'], '在庫不足または売り切れのため、キャンセルから戻すことができません。');
        }
      }
      let changed = false;
      const nextCatalog = latestCatalog.map((cake) => {
        const q = qtyMap.get(cake.id);
        if (!q) return cake;
        if (resDate && cake.stockByDate && typeof cake.stockByDate[resDate] === 'number') {
          changed = true;
          return {
            ...cake,
            stockByDate: { ...cake.stockByDate, [resDate]: Math.max(0, cake.stockByDate[resDate] - q) },
          };
        }
        if (typeof cake.stock === 'number') {
          changed = true;
          const nextStock = Math.max(0, cake.stock - q);
          const hasPosDate = Boolean(cake.stockByDate && Object.values(cake.stockByDate).some(v => typeof v === 'number' && v > 0));
          const reachedZero = nextStock <= 0 && !hasPosDate;
          return { ...cake, stock: nextStock, isSoldOut: Boolean(cake.isSoldOut) || reachedZero };
        }
        return cake;
      });
      if (changed) {
        await saveCakes(nextCatalog);
      }
    }

    if (foundIndex !== -1) {
      saveLocalReservations(current);
    }
    if (status === 'cancelled' && targetReservation) {
      await recordCancellationNotification(targetReservation, timestamp);
    } else if (status !== 'cancelled' && wasAlreadyCancelledLocally) {
      await removeCancellationNotification(id);
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

async function fetchCloudNotificationsList(): Promise<CancellationNotification[] | null> {
  if (!isFirebaseReady || !dbInstance) return null;
  try {
    const configRef = doc(dbInstance, 'settings', 'cancellation_notifications');
    const fetchPromise = getDoc(configRef);
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 2000)
    );
    const docSnap = await Promise.race([fetchPromise, timeoutPromise]);
    if (docSnap && docSnap.exists() && Array.isArray(docSnap.data().notifications)) {
      return docSnap.data().notifications.filter(Boolean).map((n: any, idx: number) => sanitizeNotification(n, idx));
    }
    if (docSnap && !docSnap.exists()) {
      return [];
    }
  } catch (err) {
    console.warn('Notice reading cloud cancellation notifications:', err);
  }
  return null;
}

export async function recordCancellationNotification(res: Reservation, cancelledAt: string): Promise<CancellationNotification> {
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

  // Merge with latest cloud notifications first so customer devices never overwrite other notifications
  const cloudExisting = await fetchCloudNotificationsList();
  const baseList = cloudExisting !== null ? cloudExisting : getLocalCancellationNotifications();
  const filtered = baseList.filter(n => n.reservationId !== res.id);
  const updated = [notif, ...filtered].slice(0, 100);
  saveLocalCancellationNotifications(updated);

  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'cancellation_notifications');
      const writePromise = setDoc(configRef, {
        notifications: updated,
        updatedAt: cancelledAt
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Firestore cancel notifications timeout')), 2500)
      );
      await Promise.race([writePromise, timeoutPromise]);
    } catch (err) {
      console.warn('Failed to sync cancellation notifications to Firestore:', err);
    }
  }

  return notif;
}

export async function removeCancellationNotification(reservationId: string): Promise<CancellationNotification[]> {
  const cloudExisting = await fetchCloudNotificationsList();
  const baseList = cloudExisting !== null ? cloudExisting : getLocalCancellationNotifications();
  const updated = baseList.filter(n => n.reservationId !== reservationId && n.id !== reservationId);
  saveLocalCancellationNotifications(updated);

  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'cancellation_notifications');
      const writePromise = setDoc(configRef, {
        notifications: updated.slice(0, 100),
        updatedAt: new Date().toISOString()
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Firestore remove cancel notification timeout')), 2000)
      );
      await Promise.race([writePromise, timeoutPromise]);
    } catch (err) {
      console.warn('Notice removing cancellation notification in Firestore:', err);
    }
  }
  return updated;
}

export async function fetchCancellationNotifications(reservationsList?: Reservation[]): Promise<CancellationNotification[]> {
  const cloudList = await fetchCloudNotificationsList();
  // When cloud responds, treat cloudList as authoritative rather than merging stale local notifications
  const list: CancellationNotification[] = cloudList !== null
    ? [...cloudList]
    : [...getLocalCancellationNotifications()];

  // Ensure every cancelled reservation in reservationsList is represented
  const sourceReservations = reservationsList || getLocalReservations();
  const activeResIds = new Set(sourceReservations.map(r => r.id));
  // If reservationsList was explicitly provided, filter out orphaned notifications whose reservation was deleted
  const cleanedList = reservationsList
    ? list.filter(n => !n.reservationId || activeResIds.has(n.reservationId))
    : list;

  for (const res of sourceReservations) {
    if (res.status === 'cancelled') {
      const hasNotif = cleanedList.some(n => n.reservationId === res.id);
      if (!hasNotif) {
        const itemsSummary = (res.items || []).map(i => `${i.cakeName}×${i.quantity}`).join('、');
        cleanedList.unshift({
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
      }
    }
  }

  cleanedList.sort((a, b) => (b.cancelledAt || '').localeCompare(a.cancelledAt || ''));
  saveLocalCancellationNotifications(cleanedList);
  return cleanedList;
}

export async function markCancellationNotificationRead(reservationId: string): Promise<CancellationNotification[]> {
  const cloudExisting = await fetchCloudNotificationsList();
  const baseList = cloudExisting !== null ? cloudExisting : getLocalCancellationNotifications();
  const updated = baseList.map(n =>
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
        setTimeout(() => reject(new Error('Firestore cancel notifications mark read timeout')), 2000)
      );
      await Promise.race([writePromise, timeoutPromise]);
    } catch (err) {
      console.warn('Notice marking notification read in Firestore:', err);
    }
  }

  return updated;
}

export async function markAllCancellationNotificationsRead(): Promise<CancellationNotification[]> {
  const cloudExisting = await fetchCloudNotificationsList();
  const baseList = cloudExisting !== null ? cloudExisting : getLocalCancellationNotifications();
  const updated = baseList.map(n => ({ ...n, read: true }));
  saveLocalCancellationNotifications(updated);

  if (isFirebaseReady && dbInstance) {
    try {
      const configRef = doc(dbInstance, 'settings', 'cancellation_notifications');
      const writePromise = setDoc(configRef, {
        notifications: updated.slice(0, 100),
        updatedAt: new Date().toISOString()
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Firestore cancel notifications mark all read timeout')), 2000)
      );
      await Promise.race([writePromise, timeoutPromise]);
    } catch (err) {
      console.warn('Notice marking all notifications read in Firestore:', err);
    }
  }

  return updated;
}

export async function deleteReservation(
  id: string,
  options?: { restoreStock?: boolean }
): Promise<void> {
  ensureFirebaseInitialized();
  const timestamp = new Date().toISOString();
  const restoreStock = options?.restoreStock ?? false;

  const localList = getLocalReservations();
  let targetRes: Reservation | null = localList.find(r => r.id === id) || null;

  if (isFirebaseReady && dbInstance) {
    try {
      const resRef = doc(dbInstance, 'reservations', id);
      const resSnap = await getDoc(resRef);
      if (resSnap.exists()) {
        targetRes = sanitizeReservation({ id: resSnap.id, ...resSnap.data() }, 0);
      }

      if (restoreStock && targetRes && targetRes.status !== 'cancelled' && targetRes.items?.length) {
        const latestCatalog = await fetchLatestCakesForMutation();
        const resDate = targetRes.date || '';
        const restoreMap = new Map<string, number>();
        for (const item of targetRes.items) {
          if (item?.cakeId) {
            restoreMap.set(item.cakeId, (restoreMap.get(item.cakeId) || 0) + (Number(item.quantity) || 0));
          }
        }
        let changed = false;
        const nextCatalog = latestCatalog.map((cake) => {
          const q = restoreMap.get(cake.id);
          if (!q) return cake;
          if (resDate && cake.stockByDate && typeof cake.stockByDate[resDate] === 'number') {
            changed = true;
            return {
              ...cake,
              stockByDate: { ...cake.stockByDate, [resDate]: cake.stockByDate[resDate] + q },
            };
          }
          if (typeof cake.stock === 'number') {
            changed = true;
            const nextStock = cake.stock + q;
            const wasAutoZero = cake.stock <= 0 && nextStock > 0;
            const nextCake: Cake = { ...cake, stock: nextStock, isSoldOut: wasAutoZero ? false : cake.isSoldOut };
            if (wasAutoZero) delete nextCake.autoStoppedAt;
            return nextCake;
          }
          return cake;
        });
        if (changed) {
          await saveCakes(nextCatalog);
        }
      }

      await deleteDoc(resRef);
    } catch (error) {
      if (isQuotaExceededError(error)) {
        throw new FirestoreQuotaError(getFriendlyFirebaseErrorMessage(error, 'write'));
      }
      throw new FirestoreConnectionError('予約データの削除に失敗しました。通信状況をご確認の上、再度お試しください。');
    }
  } else if (restoreStock && targetRes && targetRes.status !== 'cancelled' && targetRes.items?.length) {
    const latestCatalog = await fetchCakes();
    const resDate = targetRes.date || '';
    const restoreMap = new Map<string, number>();
    for (const item of targetRes.items) {
      if (item?.cakeId) {
        restoreMap.set(item.cakeId, (restoreMap.get(item.cakeId) || 0) + (Number(item.quantity) || 0));
      }
    }
    let changed = false;
    const nextCatalog = latestCatalog.map((cake) => {
      const q = restoreMap.get(cake.id);
      if (!q) return cake;
      if (resDate && cake.stockByDate && typeof cake.stockByDate[resDate] === 'number') {
        changed = true;
        return {
          ...cake,
          stockByDate: { ...cake.stockByDate, [resDate]: cake.stockByDate[resDate] + q },
        };
      }
      if (typeof cake.stock === 'number') {
        changed = true;
        const nextStock = cake.stock + q;
        const wasAutoZero = cake.stock <= 0 && nextStock > 0;
        const nextCake: Cake = { ...cake, stock: nextStock, isSoldOut: wasAutoZero ? false : cake.isSoldOut };
        if (wasAutoZero) delete nextCake.autoStoppedAt;
        return nextCake;
      }
      return cake;
    });
    if (changed) {
      await saveCakes(nextCatalog);
    }
  }

  saveLocalReservations(localList.filter(r => r.id !== id));
  await removeCancellationNotification(id);
  cachedCakes = cachedCakes ? { ...cachedCakes, fetchedAt: Date.now() } : null;
  void timestamp;
}

export async function deleteAllReservations(options?: {
  restoreStock?: boolean;
}): Promise<{ deletedCount: number }> {
  ensureFirebaseInitialized();
  const restoreStock = options?.restoreStock ?? true;
  const timestamp = new Date().toISOString();

  let targetReservations: Reservation[] = getLocalReservations();
  let deletedCount = targetReservations.length;

  if (isFirebaseReady && dbInstance) {
    try {
      const resCollection = collection(dbInstance, 'reservations');
      const snapshot = await getDocs(resCollection);
      const cloudList: Reservation[] = [];
      snapshot.forEach((d) => {
        cloudList.push(sanitizeReservation({ id: d.id, ...d.data() }, cloudList.length));
      });
      targetReservations = cloudList;
      deletedCount = snapshot.size;

      // 1. Restore stock for any active (non-cancelled) reservations before wiping
      if (restoreStock && targetReservations.length > 0) {
        const activeList = targetReservations.filter(r => r.status !== 'cancelled');
        if (activeList.length > 0) {
          const latestCatalog = await fetchLatestCakesForMutation();
          const restoreByDateMap = new Map<string, number>(); // key: `${cakeId}::${date}`
          const restoreGlobalMap = new Map<string, number>();

          for (const res of activeList) {
            const resDate = res.date || '';
            for (const item of res.items || []) {
              if (!item?.cakeId) continue;
              const qty = Number(item.quantity) || 0;
              if (qty <= 0) continue;
              const cake = latestCatalog.find(c => c.id === item.cakeId);
              if (resDate && cake?.stockByDate && typeof cake.stockByDate[resDate] === 'number') {
                const key = `${item.cakeId}::${resDate}`;
                restoreByDateMap.set(key, (restoreByDateMap.get(key) || 0) + qty);
              } else if (typeof cake?.stock === 'number') {
                restoreGlobalMap.set(item.cakeId, (restoreGlobalMap.get(item.cakeId) || 0) + qty);
              }
            }
          }

          if (restoreByDateMap.size > 0 || restoreGlobalMap.size > 0) {
            const nextCatalog = latestCatalog.map((cake) => {
              let nextCake = { ...cake };
              if (cake.stockByDate) {
                const updatedByDate = { ...cake.stockByDate };
                let dateModified = false;
                for (const dKey of Object.keys(updatedByDate)) {
                  const addQty = restoreByDateMap.get(`${cake.id}::${dKey}`);
                  if (addQty) {
                    updatedByDate[dKey] = updatedByDate[dKey] + addQty;
                    dateModified = true;
                  }
                }
                if (dateModified) {
                  nextCake = { ...nextCake, stockByDate: updatedByDate };
                }
              }
              const addGlobal = restoreGlobalMap.get(cake.id);
              if (addGlobal && typeof nextCake.stock === 'number') {
                const nextStock = nextCake.stock + addGlobal;
                const wasAutoZero = nextCake.stock <= 0 && nextStock > 0;
                nextCake = {
                  ...nextCake,
                  stock: nextStock,
                  isSoldOut: wasAutoZero ? false : nextCake.isSoldOut,
                };
                if (wasAutoZero) {
                  delete nextCake.autoStoppedAt;
                }
              }
              return nextCake;
            });
            await saveCakes(nextCatalog);
          }
        }
      }

      // 2. Delete all reservation documents in batches (<= 450 per batch)
      const docRefs = snapshot.docs.map(d => d.ref);
      for (let i = 0; i < docRefs.length; i += 450) {
        const batch = writeBatch(dbInstance);
        for (const ref of docRefs.slice(i, i + 450)) {
          batch.delete(ref);
        }
        await batch.commit();
      }

      // 3. Clear cloud cancellation notifications
      await setDoc(doc(dbInstance, 'settings', 'cancellation_notifications'), {
        notifications: [],
        updatedAt: timestamp,
      });
    } catch (error) {
      if (isQuotaExceededError(error)) {
        throw new FirestoreQuotaError(getFriendlyFirebaseErrorMessage(error, 'write'));
      }
      throw new FirestoreConnectionError('すべての予約データの削除に失敗しました。通信状況をご確認の上、再度お試しください。');
    }
  } else if (restoreStock && targetReservations.length > 0) {
    const activeList = targetReservations.filter(r => r.status !== 'cancelled');
    if (activeList.length > 0) {
      const latestCatalog = await fetchCakes();
      const restoreByDateMap = new Map<string, number>();
      const restoreGlobalMap = new Map<string, number>();
      for (const res of activeList) {
        const resDate = res.date || '';
        for (const item of res.items || []) {
          if (!item?.cakeId) continue;
          const qty = Number(item.quantity) || 0;
          if (qty <= 0) continue;
          const cake = latestCatalog.find(c => c.id === item.cakeId);
          if (resDate && cake?.stockByDate && typeof cake.stockByDate[resDate] === 'number') {
            const key = `${item.cakeId}::${resDate}`;
            restoreByDateMap.set(key, (restoreByDateMap.get(key) || 0) + qty);
          } else if (typeof cake?.stock === 'number') {
            restoreGlobalMap.set(item.cakeId, (restoreGlobalMap.get(item.cakeId) || 0) + qty);
          }
        }
      }
      if (restoreByDateMap.size > 0 || restoreGlobalMap.size > 0) {
        const nextCatalog = latestCatalog.map((cake) => {
          let nextCake = { ...cake };
          if (cake.stockByDate) {
            const updatedByDate = { ...cake.stockByDate };
            let dateModified = false;
            for (const dKey of Object.keys(updatedByDate)) {
              const addQty = restoreByDateMap.get(`${cake.id}::${dKey}`);
              if (addQty) {
                updatedByDate[dKey] = updatedByDate[dKey] + addQty;
                dateModified = true;
              }
            }
            if (dateModified) nextCake = { ...nextCake, stockByDate: updatedByDate };
          }
          const addGlobal = restoreGlobalMap.get(cake.id);
          if (addGlobal && typeof nextCake.stock === 'number') {
            const nextStock = nextCake.stock + addGlobal;
            const wasAutoZero = nextCake.stock <= 0 && nextStock > 0;
            nextCake = { ...nextCake, stock: nextStock, isSoldOut: wasAutoZero ? false : nextCake.isSoldOut };
            if (wasAutoZero) delete nextCake.autoStoppedAt;
          }
          return nextCake;
        });
        await saveCakes(nextCatalog);
      }
    }
  }

  // 4. Clear browser localStorage cache completely
  try {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
    localStorage.removeItem(CANCEL_NOTIFICATIONS_KEY);
  } catch {}

  return { deletedCount };
}

export function subscribeToReservations(
  onUpdate: (reservations: Reservation[], notifications: CancellationNotification[], newlyCancelled: Reservation[]) => void,
  onError?: (err: unknown) => void
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
          // Cloud Firestore snapshot is authoritative: never re-inject stale localStorage reservations
          const cloudItems: Reservation[] = [];
          snapshot.forEach((d) => {
            cloudItems.push(sanitizeReservation({ id: d.id, ...d.data() }, cloudItems.length));
          });
          saveLocalReservations(cloudItems);
          processIncoming(cloudItems);
        },
        (err) => {
          console.warn('Realtime reservations listener notice:', err);
          if (onError) onError(err);
        }
      );
    } catch (err) {
      console.warn('Failed setting up realtime reservations listener:', err);
      if (onError) onError(err);
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
        Boolean(options?.preserveManagerSession && existingMockIsManager) ||
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

  throw new Error('Google認証の準備ができていません。通信状況をご確認のうえ再度お試しください。');
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

  // 1. Immediately persist locally & update short memory cache
  localStorage.setItem('business_days_list', JSON.stringify(cleanDays));
  localStorage.setItem('business_days_updated_at', updatedAt);
  cachedBusinessDays = { data: cleanDays, fetchedAt: Date.now() };

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

export async function fetchBusinessDaysStrict(forceServer: boolean = false): Promise<string[]> {
  ensureFirebaseInitialized();
  if (!forceServer && cachedBusinessDays && Date.now() - cachedBusinessDays.fetchedAt < READ_CACHE_TTL_MS) {
    return cachedBusinessDays.data;
  }

  if (!forceServer && inFlightBusinessDaysPromise) {
    return inFlightBusinessDaysPromise;
  }

  const local = localStorage.getItem('business_days_list');
  let fallbackDays: string[] = [];
  if (local) {
    try {
      const parsed = JSON.parse(local);
      fallbackDays = Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string').sort() : [];
    } catch {
      fallbackDays = [];
    }
  }

  const runFetch = async (): Promise<string[]> => {
    if (isFirebaseReady && dbInstance) {
      const configRef = doc(dbInstance, 'settings', 'business_days');
      const fetchPromise = forceServer ? getDocFromServer(configRef) : getDoc(configRef);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new FirestoreConnectionError('Firestore business_days read timeout')), 6000)
      );
      try {
        const docSnap = await Promise.race([fetchPromise, timeoutPromise]);
        if (docSnap.exists()) {
          const rawDays = docSnap.data().days;
          const cloudDays = Array.isArray(rawDays)
            ? rawDays.filter((d): d is string => typeof d === 'string').sort()
            : [];
          localStorage.setItem('business_days_list', JSON.stringify(cloudDays));
          if (docSnap.data().updatedAt) {
            localStorage.setItem('business_days_updated_at', String(docSnap.data().updatedAt));
          }
          cachedBusinessDays = { data: cloudDays, fetchedAt: Date.now() };
          return cloudDays;
        } else if (fallbackDays.length > 0) {
          setDoc(configRef, {
            days: fallbackDays,
            updatedAt: new Date().toISOString()
          }).catch((e) => console.warn('Auto-migrate business days notice:', e));
          cachedBusinessDays = { data: fallbackDays, fetchedAt: Date.now() };
          return fallbackDays;
        }
        cachedBusinessDays = { data: [], fetchedAt: Date.now() };
        return [];
      } catch (err) {
        if (isQuotaExceededError(err)) {
          throw new FirestoreQuotaError(getFriendlyFirebaseErrorMessage(err, 'load'));
        }
        throw new FirestoreConnectionError(getFriendlyFirebaseErrorMessage(err, 'load'));
      }
    }
    return fallbackDays;
  };

  if (forceServer) {
    return runFetch();
  }

  inFlightBusinessDaysPromise = runFetch().finally(() => {
    inFlightBusinessDaysPromise = null;
  });
  return inFlightBusinessDaysPromise;
}

export async function fetchBusinessDays(forceServer: boolean = false): Promise<string[]> {
  try {
    return await fetchBusinessDaysStrict(forceServer);
  } catch (err) {
    console.warn('Failed to fetch business days from Firebase, using local cache:', err);
    if (cachedBusinessDays) return cachedBusinessDays.data;
    const local = localStorage.getItem('business_days_list');
    if (local) {
      try {
        const parsed = JSON.parse(local);
        return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string').sort() : [];
      } catch {
        return [];
      }
    }
    return [];
  }
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
// unless intentionally deleted via Admin, while preserving all edited fields on existing cakes
export function reconcileWithDefaultCakes(
  loadedCakes: Cake[],
  deletedDefaultIds: string[] = []
): { cakes: Cake[]; needsSave: boolean } {
  const cleanLoaded = (Array.isArray(loadedCakes) ? loadedCakes : []).filter(Boolean);
  const loadedMap = new Map<string, Cake>();
  for (const c of cleanLoaded) {
    if (c?.id) loadedMap.set(c.id, c);
  }
  const deletedSet = new Set(Array.isArray(deletedDefaultIds) ? deletedDefaultIds : []);

  let needsSave = false;
  const merged: Cake[] = [];

  for (const defCake of CAKES) {
    const existing = loadedMap.get(defCake.id);
    if (!existing) {
      if (!deletedSet.has(defCake.id)) {
        // Default cake was missing from legacy database (e.g. gateau-au-chocolat, rice-chou)
        merged.push({ ...defCake });
        needsSave = true;
      }
    } else {
      // Cake exists in database: keep all edited fields intact
      const mergedCake: Cake = {
        ...defCake,
        ...existing,
        imageUrl: existing.imageUrl && existing.imageUrl.trim() ? existing.imageUrl.trim() : defCake.imageUrl,
        jpName: existing.jpName || defCake.jpName,
        name: existing.name !== undefined ? existing.name : defCake.name,
        price: typeof existing.price === 'number' && existing.price > 0 ? existing.price : defCake.price,
        description: existing.description !== undefined ? existing.description : defCake.description,
        portionLabel: existing.portionLabel !== undefined ? existing.portionLabel : defCake.portionLabel,
        category: existing.category || defCake.category,
        tags: existing.tags !== undefined ? existing.tags : defCake.tags,
        ...(existing.stockByDate ? { stockByDate: existing.stockByDate } : {}),
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
export async function fetchCakesStrict(forceServer: boolean = false): Promise<Cake[]> {
  ensureFirebaseInitialized();
  if (!forceServer && cachedCakes && Date.now() - cachedCakes.fetchedAt < READ_CACHE_TTL_MS) {
    return cachedCakes.data.map((c, idx) => sanitizeCake(c, idx));
  }

  if (!forceServer && inFlightCakesPromise) {
    return inFlightCakesPromise;
  }

  const localDeletedIds = getLocalDeletedDefaultIds();
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

  const runFetch = async (): Promise<Cake[]> => {
    if (isFirebaseReady && dbInstance) {
      const configRef = doc(dbInstance, 'settings', 'cakes_catalog');
      const fetchPromise = forceServer ? getDocFromServer(configRef) : getDoc(configRef);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new FirestoreConnectionError('Firestore cakes read timeout')), 6000)
      );
      try {
        const docSnap = await Promise.race([fetchPromise, timeoutPromise]);
        if (docSnap.exists() && Array.isArray(docSnap.data().cakes)) {
          const cloudDeletedIds: string[] = Array.isArray(docSnap.data().deletedDefaultIds)
            ? docSnap.data().deletedDefaultIds.filter((id: any): id is string => typeof id === 'string')
            : localDeletedIds;
          saveLocalDeletedDefaultIds(cloudDeletedIds);

          const rawCloud: Cake[] = docSnap.data().cakes.filter(Boolean).map((c: any, idx: number) => sanitizeCake(c, idx));
          const { cakes: cloudCakes, needsSave } = reconcileWithDefaultCakes(rawCloud, cloudDeletedIds);
          const cloudUpdatedAt: string = docSnap.data().updatedAt || '';
          try {
            localStorage.setItem('cakes_catalog_list', JSON.stringify(cloudCakes));
            if (cloudUpdatedAt) {
              localStorage.setItem('cakes_catalog_updated_at', cloudUpdatedAt);
            }
          } catch {}
          if (needsSave) {
            saveCakes(cloudCakes, { deletedDefaultIds: cloudDeletedIds }).catch((e) =>
              console.warn('Auto-save reconciled cakes notice:', e)
            );
          }
          cachedCakes = { data: cloudCakes, fetchedAt: Date.now() };
          return cloudCakes;
        } else if (!docSnap.exists()) {
          const baseList = localCakes && localCakes.length > 0 ? localCakes : CAKES;
          const { cakes: reconciled } = reconcileWithDefaultCakes(baseList, localDeletedIds);
          const updatedAt = new Date().toISOString();
          setDoc(configRef, { cakes: reconciled, deletedDefaultIds: localDeletedIds, updatedAt }).catch((e) =>
            console.warn('Auto-migrate cakes catalog notice:', e)
          );
          try {
            localStorage.setItem('cakes_catalog_list', JSON.stringify(reconciled));
          } catch {}
          cachedCakes = { data: reconciled, fetchedAt: Date.now() };
          return reconciled;
        }
      } catch (err) {
        if (isQuotaExceededError(err)) {
          throw new FirestoreQuotaError(getFriendlyFirebaseErrorMessage(err, 'load'));
        }
        throw new FirestoreConnectionError(getFriendlyFirebaseErrorMessage(err, 'load'));
      }
    }

    if (localCakes && localCakes.length > 0) {
      const { cakes: reconciled, needsSave } = reconcileWithDefaultCakes(localCakes, localDeletedIds);
      if (needsSave) {
        try {
          localStorage.setItem('cakes_catalog_list', JSON.stringify(reconciled));
        } catch {}
      }
      return reconciled;
    }
    return CAKES;
  };

  if (forceServer) {
    return runFetch();
  }

  inFlightCakesPromise = runFetch().finally(() => {
    inFlightCakesPromise = null;
  });
  return inFlightCakesPromise;
}

export async function fetchCakes(forceServer: boolean = false): Promise<Cake[]> {
  try {
    return await fetchCakesStrict(forceServer);
  } catch (err) {
    console.warn('Failed to fetch cakes catalog from Firebase:', err);
    if (cachedCakes) return cachedCakes.data;
    const localDeletedIds = getLocalDeletedDefaultIds();
    const local = localStorage.getItem('cakes_catalog_list');
    if (local) {
      try {
        const parsed = JSON.parse(local);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const localCakes = parsed.filter(Boolean).map((c, idx) => sanitizeCake(c, idx));
          return reconcileWithDefaultCakes(localCakes, localDeletedIds).cakes;
        }
      } catch {}
    }
    return CAKES;
  }
}

export async function saveCakes(
  cakes: Cake[],
  options?: { deletedDefaultIds?: string[] }
): Promise<Cake[]> {
  ensureFirebaseInitialized();
  const updatedAt = new Date().toISOString();
  const deletedDefaultIds = options?.deletedDefaultIds ?? getLocalDeletedDefaultIds();
  saveLocalDeletedDefaultIds(deletedDefaultIds);

  const sanitizedCakes = (Array.isArray(cakes) ? cakes : []).filter(Boolean).map((c, idx) => sanitizeCake(c, idx));
  const cleanCakes = await fitCakesPayloadUnderFirestoreLimit(sanitizedCakes, deletedDefaultIds, updatedAt);

  try {
    localStorage.setItem('cakes_catalog_list', JSON.stringify(cleanCakes));
    localStorage.setItem('cakes_catalog_updated_at', updatedAt);
  } catch (e) {
    console.warn('localStorage cakes cache quota notice (continuing Firestore save):', e);
  }

  if (isFirebaseReady && dbInstance) {
    const payload = { cakes: cleanCakes, deletedDefaultIds, updatedAt };
    const payloadBytes = getUtf8ByteLength(payload);
    if (payloadBytes > 980_000) {
      throw new Error(
        '商品画像などの合計サイズが上限（1MB）を超えているため保存できませんでした。画像のサイズを小さくするか、別の画像をお試しください。'
      );
    }
    try {
      const configRef = doc(dbInstance, 'settings', 'cakes_catalog');
      const writePromise = setDoc(configRef, payload);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new FirestoreConnectionError('Firestore cakes save timeout')), 10000)
      );
      await Promise.race([writePromise, timeoutPromise]);
    } catch (err: any) {
      console.error('Failed to save cakes to Firebase:', err);
      if (isQuotaExceededError(err)) {
        throw new FirestoreQuotaError(
          'ただいまアクセスが集中しているか、本日の保存上限に達したため商品情報を保存できませんでした。少し時間をおいて再度お試しください。'
        );
      }
      const errMsg = String(err?.message || '').toLowerCase();
      const errCode = String(err?.code || '').toLowerCase();
      if (errCode === 'invalid-argument' || errMsg.includes('exceeds') || errMsg.includes('size')) {
        throw new Error(
          '商品データのサイズが大きすぎるためデータベースに保存できませんでした。画像を別のものに変更するか、少し小さい画像を選択してください。'
        );
      }
      throw new FirestoreConnectionError(
        'データベースへの保存に失敗しました。通信状況をご確認のうえ、もう一度「変更を保存」をお試しください。'
      );
    }
  }

  cachedCakes = { data: cleanCakes, fetchedAt: Date.now() };
  return cleanCakes;
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
          if (docSnap.exists() && Array.isArray(docSnap.data().cakes)) {
            const cloudDeletedIds: string[] = Array.isArray(docSnap.data().deletedDefaultIds)
              ? docSnap.data().deletedDefaultIds.filter((id: any): id is string => typeof id === 'string')
              : getLocalDeletedDefaultIds();
            saveLocalDeletedDefaultIds(cloudDeletedIds);
            const rawCloud: Cake[] = docSnap.data().cakes.filter(Boolean).map((c: any, idx: number) => sanitizeCake(c, idx));
            const { cakes: cloudCakes, needsSave } = reconcileWithDefaultCakes(rawCloud, cloudDeletedIds);
            try {
              localStorage.setItem('cakes_catalog_list', JSON.stringify(cloudCakes));
              if (docSnap.data().updatedAt) {
                localStorage.setItem('cakes_catalog_updated_at', String(docSnap.data().updatedAt));
              }
            } catch {}
            if (needsSave) {
              saveCakes(cloudCakes, { deletedDefaultIds: cloudDeletedIds }).catch((e) =>
                console.warn('Auto-save reconciled cakes on snapshot notice:', e)
              );
            }
            cachedCakes = { data: cloudCakes, fetchedAt: Date.now() };
            onUpdate(cloudCakes);
          } else if (!docSnap.exists()) {
            const local = localStorage.getItem('cakes_catalog_list');
            if (local) {
              try {
                const parsed = JSON.parse(local);
                if (Array.isArray(parsed) && parsed.length > 0) {
                  const cleanLocal = parsed.filter(Boolean).map((c, idx) => sanitizeCake(c, idx));
                  const localDeletedIds = getLocalDeletedDefaultIds();
                  const { cakes: reconciled } = reconcileWithDefaultCakes(cleanLocal, localDeletedIds);
                  setDoc(configRef, {
                    cakes: reconciled,
                    deletedDefaultIds: localDeletedIds,
                    updatedAt: new Date().toISOString(),
                  }).catch(() => {});
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

async function fetchLatestCakesForMutation(): Promise<Cake[]> {
  try {
    return await fetchCakesStrict(true);
  } catch (err) {
    if (isQuotaExceededError(err)) {
      throw err;
    }
    return await fetchCakes();
  }
}

export async function updateCakeStock(cakeId: string, stock: number | null): Promise<Cake[]> {
  const current = await fetchLatestCakesForMutation();
  const normalizedStock =
    stock === null || stock === undefined || isNaN(stock)
      ? undefined
      : Math.max(0, Math.floor(stock));

  const updated = current.map(c => {
    if (c.id !== cakeId) return c;
    const nextCake: Cake = { ...c };
    if (normalizedStock === undefined) {
      delete nextCake.stock;
      if (c.stock !== undefined && c.stock <= 0) {
        nextCake.isSoldOut = false;
        delete nextCake.autoStoppedAt;
      }
    } else {
      nextCake.stock = normalizedStock;
      if (normalizedStock <= 0) {
        nextCake.isSoldOut = true;
      } else {
        nextCake.isSoldOut = false;
        delete nextCake.autoStoppedAt;
      }
    }
    return nextCake;
  });
  return await saveCakes(updated);
}

export async function updateCakeStockByDate(
  cakeId: string,
  stockByDate: Record<string, number> | null
): Promise<Cake[]> {
  const current = await fetchLatestCakesForMutation();
  const cleanMap = stockByDate ? sanitizeStockByDate(stockByDate) : undefined;

  const updated = current.map(c => {
    if (c.id !== cakeId) return c;
    const nextCake: Cake = { ...c };
    // Retire legacy single-number stock once per-date stock is updated so per-date rules govern cleanly
    delete nextCake.stock;

    if (cleanMap) {
      nextCake.stockByDate = cleanMap;
      const hasPositive = Object.values(cleanMap).some(v => v > 0);
      // If previously auto-sold-out solely due to depleted stock === 0, resume sales
      if (hasPositive && typeof c.stock === 'number' && c.stock <= 0) {
        nextCake.isSoldOut = false;
        delete nextCake.autoStoppedAt;
      }
    } else {
      delete nextCake.stockByDate;
      if (typeof c.stock === 'number' && c.stock <= 0) {
        nextCake.isSoldOut = false;
        delete nextCake.autoStoppedAt;
      }
    }
    return nextCake;
  });
  return await saveCakes(updated);
}

export async function updateCakeSoldOut(cakeId: string, isSoldOut: boolean): Promise<Cake[]> {
  const current = await fetchLatestCakesForMutation();
  const updated = current.map(c => {
    if (c.id !== cakeId) return c;
    const nextCake: Cake = { ...c, isSoldOut };
    if (!isSoldOut) {
      delete nextCake.autoStoppedAt;
      if (typeof nextCake.stock === 'number' && nextCake.stock <= 0) {
        delete nextCake.stock;
      }
    }
    return nextCake;
  });
  return await saveCakes(updated);
}

export async function bulkUpdateCakesSoldOut(
  targetScope: 'all' | 'hall' | 'cut',
  isSoldOut: boolean
): Promise<Cake[]> {
  const current = await fetchLatestCakesForMutation();
  const updated = current.map(c => {
    const matches =
      targetScope === 'all' ||
      (targetScope === 'hall' && c.category === 'hall') ||
      (targetScope === 'cut' && c.category === 'cut');
    if (!matches) return c;
    const nextCake: Cake = { ...c, isSoldOut };
    if (!isSoldOut) {
      delete nextCake.autoStoppedAt;
      if (typeof nextCake.stock === 'number' && nextCake.stock <= 0) {
        delete nextCake.stock;
      }
    }
    return nextCake;
  });
  return await saveCakes(updated);
}

export async function saveCakeItem(cake: Cake): Promise<Cake[]> {
  const current = await fetchLatestCakesForMutation();
  const cleanCake = sanitizeCake(cake, current.length);
  const exists = current.some(c => c.id === cleanCake.id);
  let updated: Cake[];
  if (exists) {
    updated = current.map(c => c.id === cleanCake.id ? cleanCake : c);
  } else {
    updated = [...current, cleanCake];
  }
  const nextDeleted = getLocalDeletedDefaultIds().filter(id => id !== cleanCake.id);
  return await saveCakes(updated, { deletedDefaultIds: nextDeleted });
}

export async function deleteCakeItem(cakeId: string): Promise<Cake[]> {
  const current = await fetchLatestCakesForMutation();
  const updated = current.filter(c => c.id !== cakeId);
  const isDefault = CAKES.some(c => c.id === cakeId);
  const prevDeleted = getLocalDeletedDefaultIds();
  const nextDeleted = isDefault && !prevDeleted.includes(cakeId)
    ? [...prevDeleted, cakeId]
    : prevDeleted;
  return await saveCakes(updated, { deletedDefaultIds: nextDeleted });
}

export async function syncCakesFromDefaultCode(): Promise<Cake[]> {
  ensureFirebaseInitialized();
  const current = await fetchLatestCakesForMutation();
  const currentMap = new Map(current.map(c => [c.id, c]));

  // Merge default CAKES from code with current state (preserving sold-out and stock settings)
  const merged: Cake[] = CAKES.map((defCake) => {
    const existing = currentMap.get(defCake.id);
    if (existing) {
      return {
        ...defCake,
        isSoldOut: existing.isSoldOut,
        ...(typeof existing.stock === 'number' ? { stock: existing.stock } : {}),
        ...(existing.stockByDate ? { stockByDate: existing.stockByDate } : {}),
        ...(existing.autoStoppedAt ? { autoStoppedAt: existing.autoStoppedAt } : {}),
      };
    }
    return defCake;
  });

  // Retain any custom cakes created via admin
  const defaultIds = new Set(CAKES.map(c => c.id));
  const customCakes = current.filter(c => !defaultIds.has(c.id));
  const finalCakes = [...merged, ...customCakes];

  return await saveCakes(finalCakes, { deletedDefaultIds: [] });
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

export async function fetchSalesStopRules(forceServer: boolean = false): Promise<SalesStopScheduleRule[]> {
  ensureFirebaseInitialized();
  if (!forceServer && cachedSalesStopRules && Date.now() - cachedSalesStopRules.fetchedAt < READ_CACHE_TTL_MS) {
    return cachedSalesStopRules.data;
  }
  if (!forceServer && inFlightSalesStopRulesPromise) {
    return inFlightSalesStopRulesPromise;
  }

  const localRules = getLocalScheduleRules();

  const runFetch = async (): Promise<SalesStopScheduleRule[]> => {
    if (isFirebaseReady && dbInstance) {
      try {
        const configRef = doc(dbInstance, 'settings', 'sales_scheduler');
        const fetchPromise = forceServer ? getDocFromServer(configRef) : getDoc(configRef);
        const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
        const docSnap = await Promise.race([fetchPromise, timeoutPromise]);
        if (docSnap && docSnap.exists() && Array.isArray(docSnap.data().rules)) {
          const cloudRules = docSnap.data().rules.filter(Boolean).map((r: any, idx: number) => sanitizeScheduleRule(r, idx));
          localStorage.setItem(SALES_SCHEDULER_STORAGE_KEY, JSON.stringify(cloudRules));
          cachedSalesStopRules = { data: cloudRules, fetchedAt: Date.now() };
          return cloudRules;
        } else if (docSnap && !docSnap.exists() && localRules.length > 0) {
          setDoc(configRef, { rules: localRules, updatedAt: new Date().toISOString() }).catch(() => {});
          cachedSalesStopRules = { data: localRules, fetchedAt: Date.now() };
          return localRules;
        }
      } catch (err) {
        console.warn('Failed to fetch sales scheduler rules from Firestore:', err);
      }
    }
    return localRules;
  };

  if (forceServer) {
    return runFetch();
  }

  inFlightSalesStopRulesPromise = runFetch().finally(() => {
    inFlightSalesStopRulesPromise = null;
  });
  return inFlightSalesStopRulesPromise;
}

export async function saveSalesStopRules(rules: SalesStopScheduleRule[]): Promise<SalesStopScheduleRule[]> {
  ensureFirebaseInitialized();
  const cleanRules = (Array.isArray(rules) ? rules : [])
    .filter(Boolean)
    .map((r, idx) => sanitizeScheduleRule(r, idx))
    .sort((a, b) => (a.scheduledAt || '').localeCompare(b.scheduledAt || ''));

  const updatedAt = new Date().toISOString();
  localStorage.setItem(SALES_SCHEDULER_STORAGE_KEY, JSON.stringify(cleanRules));
  cachedSalesStopRules = { data: cleanRules, fetchedAt: Date.now() };

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

export function applySalesStopRulesInMemory(
  cakes: Cake[],
  rules: SalesStopScheduleRule[]
): Cake[] {
  if (!Array.isArray(rules) || rules.length === 0) return cakes;
  const elapsedRules = rules.filter(
    (rule) => rule && rule.enabled && !rule.executed && isScheduledStopTimeElapsed(rule.scheduledAt)
  );
  if (elapsedRules.length === 0) return cakes;

  const nowIso = new Date().toISOString();
  return cakes.map((cake) => {
    const matched = elapsedRules.some((rule) => doesRuleMatchCake(rule, cake));
    if (matched && !cake.isSoldOut) {
      return {
        ...cake,
        isSoldOut: true,
        autoStoppedAt: cake.autoStoppedAt || nowIso,
      };
    }
    return cake;
  });
}

export async function addSalesStopRule(input: {
  label: string;
  scheduledAt: string;
  targetScope: 'all' | 'hall' | 'cut' | 'custom';
  targetCakeIds?: string[];
}): Promise<{ rules: SalesStopScheduleRule[]; cakes: Cake[]; executedImmediately: boolean }> {
  const [currentRules, currentCakes] = await Promise.all([
    fetchSalesStopRules(true),
    fetchLatestCakesForMutation(),
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

  let nextCakes = currentCakes;
  if (alreadyElapsed) {
    nextCakes = currentCakes.map(cake => {
      if (!doesRuleMatchCake(newRule, cake)) return cake;
      return {
        ...cake,
        isSoldOut: true,
        autoStoppedAt: cake.autoStoppedAt || nowIso,
      };
    });
    await saveCakes(nextCakes);
  }

  return { rules: nextRules, cakes: nextCakes, executedImmediately: alreadyElapsed };
}

export async function toggleSalesStopRule(
  ruleId: string,
  enabled: boolean
): Promise<{ rules: SalesStopScheduleRule[]; cakes: Cake[] }> {
  const [currentRules, currentCakes] = await Promise.all([
    fetchSalesStopRules(),
    fetchLatestCakesForMutation(),
  ]);

  const targetRule = currentRules.find(r => r.id === ruleId);
  const nowIso = new Date().toISOString();
  const shouldExecuteNow = Boolean(enabled && targetRule && !targetRule.executed && isScheduledStopTimeElapsed(targetRule.scheduledAt));

  const nextRules = await saveSalesStopRules(
    currentRules.map(r =>
      r.id === ruleId
        ? {
            ...r,
            enabled,
            ...(shouldExecuteNow ? { executed: true, executedAt: nowIso } : {}),
          }
        : r
    )
  );

  let nextCakes = currentCakes;
  if (shouldExecuteNow && targetRule) {
    nextCakes = currentCakes.map(cake => {
      if (!doesRuleMatchCake(targetRule, cake)) return cake;
      return {
        ...cake,
        isSoldOut: true,
        autoStoppedAt: cake.autoStoppedAt || nowIso,
      };
    });
    await saveCakes(nextCakes);
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

  const remainingRules = await saveSalesStopRules(currentRules.filter(r => r.id !== ruleId));
  return { rules: remainingRules, cakes: currentCakes };
}

/**
 * Evaluates all active global sales-stop schedule rules.
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

  const elapsedRules = rules.filter(
    rule => rule.enabled && !rule.executed && isScheduledStopTimeElapsed(rule.scheduledAt)
  );
  if (elapsedRules.length === 0) {
    return {
      triggered: false,
      cakes: rawCakes,
      rules,
      triggeredCakeNames: [],
    };
  }

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

  const latestCakes = await fetchLatestCakesForMutation();
  const updatedCakes = latestCakes.map(cake => {
    const matchedElapsedRule = elapsedRules.find(rule => doesRuleMatchCake(rule, cake));
    if (matchedElapsedRule && (!cake.isSoldOut || !cake.autoStoppedAt)) {
      cakesChanged = true;
      triggeredNameSet.add(cake.jpName);
      return {
        ...cake,
        isSoldOut: true,
        autoStoppedAt: cake.autoStoppedAt || nowIso,
      };
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

