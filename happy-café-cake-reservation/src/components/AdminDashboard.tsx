import React, { useState, useEffect, useMemo } from 'react';
import { Reservation, ReservationStatus, Cake, CancellationNotification } from '../types';
import { 
  fetchReservations, 
  updateReservationStatus,
  getCachedGoogleToken,
  setCachedGoogleToken,
  fetchSheetsConfig,
  saveSheetsConfig,
  clearSheetsConfig,
  googleLogin,
  fetchCakesStrict,
  fetchCancellationNotifications,
  markCancellationNotificationRead,
  markAllCancellationNotificationsRead,
  subscribeToReservations,
  evaluateAndExecuteSalesSchedules,
  getFriendlyFirebaseErrorMessage,
  fetchBusinessDays,
  subscribeToBusinessDays,
  deleteReservation,
  deleteAllReservations
} from '../lib/dbService';
import { 
  createReservationsSheet, 
  syncReservationsToSheet,
  extractSpreadsheetId,
  downloadReservationsCsv,
  copyReservationsForSheets
} from '../lib/googleSheetsService';
import { motion, AnimatePresence } from 'motion/react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { 
  Calendar, 
  Clock, 
  Check, 
  X, 
  RefreshCw, 
  Filter, 
  TrendingUp, 
  DollarSign, 
  ShoppingBag, 
  AlertCircle, 
  Search, 
  Mail, 
  Phone, 
  FileText, 
  CheckCircle,
  FileSpreadsheet, 
  ExternalLink,
  Power,
  ChefHat,
  MessageSquare,
  Flame,
  User,
  Layers,
  ArrowRight,
  Printer,
  Bell,
  Settings,
  Trash2
} from 'lucide-react';
import BusinessDaysCalendar from './BusinessDaysCalendar';
import AdminCakeManager from './AdminCakeManager';

interface AdminDashboardProps {
  onLogout: () => void;
  userEmail?: string | null;
  cakes?: Cake[];
  onCakesUpdated?: (newCakes: Cake[]) => void;
  onToast?: (message: string) => void;
}

// Custom theme palette matching "Sleek Interface"
const COLORS = ['#1A1A1A', '#D4AF37', '#706B63', '#BFA46F', '#3D3A35', '#A39274'];

export default function AdminDashboard({ 
  onLogout, 
  userEmail, 
  cakes: externalCakes, 
  onCakesUpdated,
  onToast 
}: AdminDashboardProps) {
  // Navigation tabs: 予約者詳細 / 営業日設定 / 商品管理設定 / 売上・分析グラフ
  const [activeTab, setActiveTab] = useState<'reservations' | 'calendar' | 'cakes' | 'analytics'>('reservations');
  const [showSheetsSettings, setShowSheetsSettings] = useState(false);

  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [filteredReservations, setFilteredReservations] = useState<Reservation[]>([]);
  const [cancelNotifications, setCancelNotifications] = useState<CancellationNotification[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterDate, setFilterDate] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedReservation, setSelectedReservation] = useState<Reservation | null>(null);
  const [showKitchenPrep, setShowKitchenPrep] = useState(true);

  // Cakes & Business Days State
  const [cakesList, setCakesList] = useState<Cake[]>(externalCakes || []);
  const [businessDays, setBusinessDays] = useState<string[]>([]);

  // Delete Reservation / Wipe All Reservations Modal State
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false);
  const [restoreStockOnDeleteAll, setRestoreStockOnDeleteAll] = useState(true);
  const [deleteAllPassword, setDeleteAllPassword] = useState('');
  const [deleteAllPasswordError, setDeleteAllPasswordError] = useState<string | null>(null);
  const [isDeletingAll, setIsDeletingAll] = useState(false);
  const [confirmDeleteSingleId, setConfirmDeleteSingleId] = useState<string | null>(null);
  const [isDeletingSingle, setIsDeletingSingle] = useState(false);

  // Stats
  const [totalSales, setTotalSales] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [confirmedCount, setConfirmedCount] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);
  const [cancelledCount, setCancelledCount] = useState(0);

  // Google Sheets integration state variables
  const [spreadsheetId, setSpreadsheetId] = useState<string | null>(null);
  const [manualSheetInput, setManualSheetInput] = useState('');
  const [googleToken, setGoogleToken] = useState<string | null>(null);
  const [isLinking, setIsLinking] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedTime, setLastSyncedTime] = useState<string | null>(null);
  const [sheetsFeedback, setSheetsFeedback] = useState<{
    type: 'success' | 'error' | 'info';
    title: string;
    detail?: string;
  } | null>(null);

  // Load cakes if not passed from parent
  useEffect(() => {
    if (!externalCakes || externalCakes.length === 0) {
      fetchCakesStrict(false).then(items => {
        setCakesList(items);
      }).catch(err => console.error('Failed to load cakes in admin:', err));
    } else {
      setCakesList(externalCakes);
    }
  }, [externalCakes]);

  // Load configuration on component mount
  useEffect(() => {
    async function loadSheetsConfig() {
      try {
        const configId = await fetchSheetsConfig();
        if (configId) {
          setSpreadsheetId(configId);
        }
      } catch (err) {
        console.error('Failed to load sheets config ID:', err);
      }
      
      const token = getCachedGoogleToken();
      if (token) {
        setGoogleToken(token);
      }
    }
    loadSheetsConfig();
  }, []);

  // Auto synchronization when reservations update
  useEffect(() => {
    if (googleToken && spreadsheetId && reservations.length > 0) {
      syncReservationsToSheet(googleToken, spreadsheetId, reservations, cakesList)
        .then(() => {
          setLastSyncedTime(new Date().toLocaleTimeString('ja-JP'));
        })
        .catch((err) => {
          console.warn('Auto background sync failed:', err);
        });
    }
  }, [googleToken, spreadsheetId, reservations, cakesList]);

  const formatGoogleError = (err: unknown): { title: string; detail: string; isAuthError: boolean } => {
    const raw = err instanceof Error ? err.message : String(err);
    const status = (err as any)?.status;
    if (raw.includes('auth/popup-blocked')) {
      return {
        title: 'ブラウザのポップアップがブロックされました',
        detail: 'ブラウザのアドレスバー右端からポップアップを許可して再度お試しいただくか、下の「CSV出力 / コピーして貼り付け」をご利用ください。',
        isAuthError: true,
      };
    }
    if (raw.includes('auth/popup-closed-by-user') || raw.includes('auth/cancelled-popup-request')) {
      return {
        title: 'Googleログイン画面が閉じられました',
        detail: 'スプレッドシートを自動作成するには、ポップアップ画面でGoogleアカウントを選択し、アクセス権限を許可してください。',
        isAuthError: true,
      };
    }
    if (raw.includes('auth/unauthorized-domain')) {
      return {
        title: '現在のドメインがFirebase認証の許可リストに未登録です',
        detail: '下の「CSVダウンロード」または「スプレッドシート貼り付け用コピー」から即座に台帳を作成できます。',
        isAuthError: true,
      };
    }
    if (status === 401 || status === 403 || raw.includes('401') || raw.includes('403') || raw.includes('PERMISSION_DENIED') || raw.includes('UNAUTHENTICATED')) {
      return {
        title: 'Googleスプレッドシートへのアクセス権限が不足しているか、認証の有効期限が切れています',
        detail: '「Googleアカウント再連携（権限を許可）」ボタンを押して、GoogleスプレッドシートとGoogleドライブのチェックボックスにチェックを入れて許可してください。',
        isAuthError: true,
      };
    }
    return {
      title: 'スプレッドシートの処理中にエラーが発生しました',
      detail: raw,
      isAuthError: false,
    };
  };

  const handleGoogleLink = async (forceConsent = true) => {
    setIsLinking(true);
    setSheetsFeedback(null);
    try {
      const result = await googleLogin({ forceConsent, preserveManagerSession: true });
      const token = result?.accessToken || getCachedGoogleToken();
      if (token) {
        setGoogleToken(token);
        setSheetsFeedback({
          type: 'success',
          title: 'Googleアカウントとの認証・連携が完了しました！',
          detail: '続けて「新規スプレッドシートを作成」ボタンを押すと、自動的に台帳が作成され予約データが書き込まれます。',
        });
        if (onToast) onToast('✅ Googleアカウントとの連携が完了しました');
      } else {
        setSheetsFeedback({
          type: 'error',
          title: '認証は完了しましたが、アクセストークンを取得できませんでした',
          detail: 'もう一度「Googleアカウントと連携」をクリックし、スプレッドシートの権限を許可してください。',
        });
      }
    } catch (err) {
      console.error('Google link err:', err);
      const formatted = formatGoogleError(err);
      setSheetsFeedback({
        type: 'error',
        title: formatted.title,
        detail: formatted.detail,
      });
    } finally {
      setIsLinking(false);
    }
  };

  const handleCreateAndLink = async () => {
    setSheetsFeedback(null);
    let currentToken = googleToken || getCachedGoogleToken();
    if (!currentToken) {
      setIsLinking(true);
      try {
        const result = await googleLogin({ forceConsent: true, preserveManagerSession: true });
        const token = result?.accessToken || getCachedGoogleToken();
        if (token) {
          currentToken = token;
          setGoogleToken(token);
        } else {
          setSheetsFeedback({
            type: 'error',
            title: 'Googleアクセストークンが取得できませんでした',
            detail: 'ログイン画面でGoogleスプレッドシートへのアクセス権限を許可してください。',
          });
          return;
        }
      } catch (err) {
        console.error('Google link err:', err);
        const formatted = formatGoogleError(err);
        setSheetsFeedback({
          type: 'error',
          title: formatted.title,
          detail: formatted.detail,
        });
        return;
      } finally {
        setIsLinking(false);
      }
    }

    setIsSyncing(true);
    try {
      let newSheetId: string;
      try {
        newSheetId = await createReservationsSheet(currentToken, cakesList, reservations);
      } catch (firstErr: any) {
        const status = firstErr?.status;
        const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        // If cached token expired or lacked scope (401/403), automatically clear it and prompt fresh consent once
        if (status === 401 || status === 403 || msg.includes('401') || msg.includes('403')) {
          setCachedGoogleToken(null);
          setGoogleToken(null);
          const relogin = await googleLogin({ forceConsent: true, preserveManagerSession: true });
          const freshToken = relogin?.accessToken || getCachedGoogleToken();
          if (!freshToken) {
            throw firstErr;
          }
          currentToken = freshToken;
          setGoogleToken(freshToken);
          newSheetId = await createReservationsSheet(currentToken, cakesList, reservations);
        } else {
          throw firstErr;
        }
      }

      setSpreadsheetId(newSheetId);
      await saveSheetsConfig(newSheetId);
      const nowStr = new Date().toLocaleTimeString('ja-JP');
      setLastSyncedTime(nowStr);
      setSheetsFeedback({
        type: 'success',
        title: '新しいGoogleスプレッドシートを作成し、初期同期を完了しました！',
        detail: `全${reservations.length}件の予約データを書き込みました。下のリンクからスプレッドシートを直接開けます。`,
      });
      if (onToast) onToast('🎉 Googleスプレッドシートを作成・同期しました！');
    } catch (err) {
      console.error('Error creating spreadsheet:', err);
      const formatted = formatGoogleError(err);
      if (formatted.isAuthError) {
        setCachedGoogleToken(null);
        setGoogleToken(null);
      }
      setSheetsFeedback({
        type: 'error',
        title: formatted.title,
        detail: formatted.detail,
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSyncNow = async () => {
    setSheetsFeedback(null);
    let currentToken = googleToken || getCachedGoogleToken();
    if (!currentToken) {
      setIsLinking(true);
      try {
        const result = await googleLogin({ forceConsent: false, preserveManagerSession: true });
        const token = result?.accessToken || getCachedGoogleToken();
        if (token) {
          currentToken = token;
          setGoogleToken(token);
        } else {
          setSheetsFeedback({
            type: 'error',
            title: 'Googleアクセストークンが取得できませんでした',
            detail: '「Googleアカウントと連携」から再度ログインしてください。',
          });
          return;
        }
      } catch (err) {
        console.error('Google link err:', err);
        const formatted = formatGoogleError(err);
        setSheetsFeedback({
          type: 'error',
          title: formatted.title,
          detail: formatted.detail,
        });
        return;
      } finally {
        setIsLinking(false);
      }
    }

    if (!spreadsheetId) {
      setSheetsFeedback({
        type: 'error',
        title: '連携先のスプレッドシートが設定されていません',
        detail: '「新規スプレッドシートを作成」をクリックするか、既存のスプレッドシートURLを入力してください。',
      });
      return;
    }

    setIsSyncing(true);
    try {
      await syncReservationsToSheet(currentToken, spreadsheetId, reservations, cakesList);
      setLastSyncedTime(new Date().toLocaleTimeString('ja-JP'));
      setSheetsFeedback({
        type: 'success',
        title: 'スプレッドシートの最新同期が完了しました！',
        detail: `全${reservations.length}件の最新ステータスがスプレッドシートへ反映されています。`,
      });
      if (onToast) onToast('✅ スプレッドシートを最新状態に同期しました');
    } catch (err) {
      console.error(err);
      const formatted = formatGoogleError(err);
      if (formatted.isAuthError) {
        setCachedGoogleToken(null);
        setGoogleToken(null);
      }
      setSheetsFeedback({
        type: 'error',
        title: formatted.title,
        detail: formatted.detail,
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const handleLinkExistingSheet = async (e: React.FormEvent) => {
    e.preventDefault();
    setSheetsFeedback(null);
    const extracted = extractSpreadsheetId(manualSheetInput);
    if (!extracted) {
      setSheetsFeedback({
        type: 'error',
        title: '有効なGoogleスプレッドシートのURLまたはIDを入力してください',
        detail: '例: https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit',
      });
      return;
    }
    setSpreadsheetId(extracted);
    await saveSheetsConfig(extracted);
    setManualSheetInput('');
    setSheetsFeedback({
      type: 'success',
      title: '既存のスプレッドシートを連携先に設定しました',
      detail: '「最新予約を今すぐ同期」ボタンを押すと、このスプレッドシートへ予約データが書き込まれます。',
    });
    if (onToast) onToast('📋 スプレッドシート連携先を設定しました');
  };

  const handleUnlinkSheet = async () => {
    setSpreadsheetId(null);
    await clearSheetsConfig();
    setSheetsFeedback({
      type: 'info',
      title: 'スプレッドシートの連携設定をリセットしました',
      detail: '「新規スプレッドシートを作成」からいつでも新しい台帳を作成できます。',
    });
  };

  const loadData = async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const data = await fetchReservations();
      setReservations(data);
      const notifs = await fetchCancellationNotifications(data);
      setCancelNotifications(notifs);
      const cakesData = await fetchCakesStrict(true);
      setCakesList(cakesData);
      if (onCakesUpdated) onCakesUpdated(cakesData);
    } catch (err) {
      console.error('Failed to load reservations for admin:', err);
      setLoadError(getFriendlyFirebaseErrorMessage(err, 'load'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setLoadError(null);

    fetchCakesStrict(false)
      .then((cakesData) => {
        if (!active) return;
        setCakesList(cakesData);
        if (onCakesUpdated) onCakesUpdated(cakesData);
      })
      .catch((err) => {
        console.error('Failed loading cakes for admin:', err);
        if (active) setLoadError(getFriendlyFirebaseErrorMessage(err, 'load'));
      });

    fetchBusinessDays(false)
      .then((days) => {
        if (active) setBusinessDays(days);
      })
      .catch((err) => console.warn('Failed loading business days in admin:', err));

    const unsubscribeBusinessDays = subscribeToBusinessDays((days) => {
      if (active) setBusinessDays(days);
    });

    const unsubscribe = subscribeToReservations(
      (updatedReservations, updatedNotifs, newlyCancelled) => {
        if (!active) return;
        setReservations(updatedReservations);
        setCancelNotifications(updatedNotifs);
        setLoadError(null);
        setIsLoading(false);
        if (newlyCancelled.length > 0 && onToast) {
          const names = newlyCancelled.map(r => `${r.name} 様（${r.date}）`).join('、');
          onToast(`🚨 予約キャンセル通知：${names} の予約がキャンセルされました`);
        }
      },
      (err) => {
        if (!active) return;
        setLoadError(getFriendlyFirebaseErrorMessage(err, 'load'));
        setIsLoading(false);
      }
    );

    // Periodically evaluate scheduled sales-stop timers (uses 60s cached reads)
    const schedulerInterval = window.setInterval(async () => {
      try {
        const schedRes = await evaluateAndExecuteSalesSchedules();
        if (schedRes.triggered) {
          setCakesList(schedRes.cakes);
          if (onCakesUpdated) onCakesUpdated(schedRes.cakes);
          if (onToast && schedRes.triggeredCakeNames.length > 0) {
            onToast(
              `⏰ スケジューラーにより「${schedRes.triggeredCakeNames.join('・')}」を自動販売停止に移行しました`
            );
          }
        }
      } catch (err) {
        console.warn('Admin background scheduler check notice:', err);
      }
    }, 30000);

    return () => {
      active = false;
      unsubscribe();
      unsubscribeBusinessDays();
      window.clearInterval(schedulerInterval);
    };
  }, []);

  const unreadCancelNotifications = useMemo(
    () => cancelNotifications.filter(n => !n.read),
    [cancelNotifications]
  );

  const cancelledReservationsList = useMemo(
    () => reservations.filter(r => r.status === 'cancelled' && (filterDate === 'all' || r.date === filterDate)),
    [reservations, filterDate]
  );

  // Filter reservations
  useEffect(() => {
    let result = reservations;

    // Filter statuses
    if (filterStatus !== 'all') {
      result = result.filter(r => r.status === filterStatus);
    }

    // Filter dates
    if (filterDate !== 'all') {
      result = result.filter(r => r.date === filterDate);
    }

    // Search query (names, kana, emails, phones, ids, cake names)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(r => 
        (r.name || '').toLowerCase().includes(q) ||
        (r.nameKana || '').toLowerCase().includes(q) ||
        (r.email || '').toLowerCase().includes(q) ||
        (r.phone || '').replace(/[-\s]/g, '').includes(q.replace(/[-\s]/g, '')) ||
        (r.id || '').toLowerCase().includes(q) ||
        (r.items || []).some(item => (item?.cakeName || '').toLowerCase().includes(q))
      );
    }

    setFilteredReservations(result);

    // Calculate aggregated stats
    const total = reservations
      .filter(r => r.status !== 'cancelled')
      .reduce((sum, current) => sum + (Number(current.totalPrice) || 0), 0);

    const pending = reservations.filter(r => r.status === 'pending').length;
    const confirmed = reservations.filter(r => r.status === 'confirmed').length;
    const completed = reservations.filter(r => r.status === 'completed').length;
    const cancelled = reservations.filter(r => r.status === 'cancelled').length;

    setTotalSales(total);
    setPendingCount(pending);
    setConfirmedCount(confirmed);
    setCompletedCount(completed);
    setCancelledCount(cancelled);
  }, [reservations, filterStatus, filterDate, searchQuery]);

  const handleStatusChange = async (id: string, newStatus: ReservationStatus) => {
    const prevStatus = reservations.find(r => r.id === id)?.status;
    try {
      await updateReservationStatus(id, newStatus);
      const nowIso = new Date().toISOString();
      const nextList = reservations.map(r => {
        if (r.id !== id) return r;
        const updatedRow: Reservation = { ...r, status: newStatus, updatedAt: nowIso };
        if (newStatus === 'cancelled') {
          updatedRow.cancelledAt = nowIso;
        } else {
          delete updatedRow.cancelledAt;
        }
        return updatedRow;
      });
      setReservations(nextList);
      const notifs = await fetchCancellationNotifications(nextList);
      setCancelNotifications(notifs);
      
      if (selectedReservation?.id === id) {
        setSelectedReservation(prev => prev ? { ...prev, status: newStatus } : null);
      }
      if (newStatus === 'cancelled' || prevStatus === 'cancelled') {
        fetchCakesStrict(true)
          .then((freshCakes) => {
            if (Array.isArray(freshCakes) && freshCakes.length > 0) {
              setCakesList(freshCakes);
              if (onCakesUpdated) onCakesUpdated(freshCakes);
            }
          })
          .catch(() => {});
      }
      if (onToast) {
        const labelMap: Record<ReservationStatus, string> = {
          pending: '保留中',
          confirmed: '予約確定',
          completed: 'お渡し完了',
          cancelled: 'キャンセル'
        };
        onToast(
          newStatus === 'cancelled'
            ? '🚨 予約をキャンセルし、スタッフ通知および在庫・キャンセルリストに反映しました'
            : prevStatus === 'cancelled'
            ? `ステータスを「${labelMap[newStatus]}」に戻し、在庫数を再反映しました`
            : `ステータスを「${labelMap[newStatus]}」に更新しました`
        );
      }
    } catch (err) {
      console.error('Failed to patch status:', err);
      if (onToast) {
        onToast(`⚠️ ${err instanceof Error && err.message ? err.message : 'ステータスの更新に失敗しました。'}`);
      }
    }
  };

  const handleDeleteAllReservations = async () => {
    if (isDeletingAll) return;
    const normalizedPassword = deleteAllPassword
      .trim()
      .replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
      .replace(/[-\s]/g, '');

    if (normalizedPassword !== '07064685230') {
      setDeleteAllPasswordError('管理者パスワードが正しくありません。');
      return;
    }

    setDeleteAllPasswordError(null);
    setIsDeletingAll(true);
    try {
      const { deletedCount } = await deleteAllReservations({ restoreStock: restoreStockOnDeleteAll });
      setReservations([]);
      setCancelNotifications([]);
      setSelectedReservation(null);
      setConfirmDeleteSingleId(null);
      setDeleteAllPassword('');
      setDeleteAllPasswordError(null);
      setShowDeleteAllModal(false);
      if (restoreStockOnDeleteAll) {
        try {
          const freshCakes = await fetchCakesStrict(true);
          if (Array.isArray(freshCakes) && freshCakes.length > 0) {
            setCakesList(freshCakes);
            if (onCakesUpdated) onCakesUpdated(freshCakes);
          }
        } catch {}
      }
      if (onToast) {
        onToast(`🗑️ ${deletedCount > 0 ? `${deletedCount}件の` : ''}予約データをすべて削除（初期化）しました`);
      }
    } catch (err) {
      console.error('Failed to delete all reservations:', err);
      if (onToast) {
        onToast(`⚠️ ${err instanceof Error && err.message ? err.message : '予約データの一括削除に失敗しました。'}`);
      }
    } finally {
      setIsDeletingAll(false);
    }
  };

  const handleDeleteSingleReservation = async (res: Reservation) => {
    if (isDeletingSingle) return;
    setIsDeletingSingle(true);
    try {
      const shouldRestore = res.status !== 'cancelled';
      await deleteReservation(res.id, { restoreStock: shouldRestore });
      const nextList = reservations.filter(r => r.id !== res.id);
      setReservations(nextList);
      setCancelNotifications(prev => prev.filter(n => n.reservationId !== res.id));
      setSelectedReservation(null);
      setConfirmDeleteSingleId(null);
      if (shouldRestore) {
        try {
          const freshCakes = await fetchCakesStrict(true);
          if (Array.isArray(freshCakes) && freshCakes.length > 0) {
            setCakesList(freshCakes);
            if (onCakesUpdated) onCakesUpdated(freshCakes);
          }
        } catch {}
      }
      if (onToast) {
        onToast(`🗑️ ${res.name} 様の予約データを削除しました`);
      }
    } catch (err) {
      console.error('Failed to delete reservation:', err);
      if (onToast) {
        onToast(`⚠️ ${err instanceof Error && err.message ? err.message : '予約データの削除に失敗しました。'}`);
      }
    } finally {
      setIsDeletingSingle(false);
    }
  };

  // Distinct dates in reservations for quick filtering
  const reservationDates = useMemo(() => {
    return Array.from(new Set(reservations.map(r => r.date).filter(Boolean))).sort();
  }, [reservations]);

  // Kitchen Prep breakdown for pastry students
  const kitchenPrepCounts = useMemo(() => {
    const counts: Record<string, { name: string; quantity: number }> = {};
    let totalCakes = 0;

    filteredReservations.filter(r => r.status !== 'cancelled').forEach(res => {
      (res.items || []).forEach(item => {
        if (!counts[item.cakeName]) {
          counts[item.cakeName] = { name: item.cakeName, quantity: 0 };
        }
        counts[item.cakeName].quantity += (Number(item.quantity) || 0);
        totalCakes += (Number(item.quantity) || 0);
      });
    });

    return { counts: Object.values(counts), totalCakes };
  }, [filteredReservations]);

  // Handler for cakes list updated from AdminCakeManager
  const handleCakesChanged = (newCakes: Cake[]) => {
    setCakesList(newCakes);
    if (onCakesUpdated) {
      onCakesUpdated(newCakes);
    }
  };

  // 1. Data Preparation for BarChart (Revenue by date)
  const getRevenueByDateData = () => {
    const datesMap: { [date: string]: number } = {};
    reservations
      .filter(r => r.status !== 'cancelled')
      .forEach(r => {
        if (r.date) {
          datesMap[r.date] = (datesMap[r.date] || 0) + r.totalPrice;
        }
      });
    return Object.keys(datesMap)
      .sort()
      .slice(-7)
      .map(date => ({
        date: date.substring(5), // MM-DD format for readable chart tick labels
        revenue: datesMap[date],
      }));
  };

  // 2. Cake Popularity Distribution
  const getCakePopularityData = () => {
    const cakeCountMap: { [cakeName: string]: number } = {};
    reservations
      .filter(r => r.status !== 'cancelled')
      .forEach(r => {
        (r.items || []).forEach(item => {
          cakeCountMap[item.cakeName] = (cakeCountMap[item.cakeName] || 0) + (Number(item.quantity) || 0);
        });
      });
    return Object.keys(cakeCountMap).map(name => ({
      name,
      value: cakeCountMap[name],
    }));
  };

  const getStatusBadge = (status: ReservationStatus) => {
    switch (status) {
      case 'pending':
        return <span className="bg-amber-50 text-amber-900 border border-amber-200 text-[10px] px-2.5 py-1 rounded-full font-bold uppercase tracking-wider">受付中（承認待ち）</span>;
      case 'confirmed':
        return <span className="bg-blue-50 text-blue-900 border border-blue-200 text-[10px] px-2.5 py-1 rounded-full font-bold uppercase tracking-wider">予約確定</span>;
      case 'completed':
        return <span className="bg-emerald-50 text-emerald-900 border border-emerald-200 text-[10px] px-2.5 py-1 rounded-full font-bold uppercase tracking-wider">お渡し完了</span>;
      case 'cancelled':
        return <span className="bg-red-600 text-white border border-red-700 text-[10px] px-2.5 py-1 rounded-full font-bold uppercase tracking-wider">キャンセル済</span>;
    }
  };

  const chartRevenueData = getRevenueByDateData();
  const chartPopularityData = getCakePopularityData();

  return (
    <div id="admin-dashboard-container" className="space-y-6">
      {/* Header section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-sleek-dark text-white p-6 md:p-8 rounded-3xl border border-sleek-dark shadow-sm relative overflow-hidden">
        <div className="absolute top-0 right-0 w-48 h-48 bg-[#D4AF37]/5 rounded-full filter blur-2xl translate-x-12 -translate-y-12"></div>
        <div className="relative">
          <div className="flex items-center flex-wrap gap-2 mb-1">
            <span className="text-sleek-gold text-[10px] font-bold tracking-widest uppercase font-mono bg-sleek-gold/10 px-2.5 py-0.5 rounded-full border border-sleek-gold/30">
              管理者専用画面
            </span>
            {unreadCancelNotifications.length > 0 && (
              <span className="bg-red-600 text-white text-[10px] font-bold px-2.5 py-0.5 rounded-full flex items-center gap-1">
                <Bell className="w-3 h-3" />
                未確認キャンセル通知：{unreadCancelNotifications.length}件
              </span>
            )}
          </div>
          <h2 className="text-2xl font-light font-serif tracking-tight text-white">Happy Café 総合管理画面</h2>
          <p className="text-sleek-muted text-xs mt-1 font-mono">
            ログインアカウント: {userEmail === 'kanamori@happy-sweets.jp' ? '金森 様 (kanamori@happy-sweets.jp)' : (userEmail || '管理者')}
          </p>
        </div>
        <div className="flex items-center gap-2 relative">
          <button
            id="btn-refresh-admin"
            onClick={loadData}
            disabled={isLoading}
            className="bg-stone-800 hover:bg-stone-700 border border-stone-700 text-stone-200 p-2.5 rounded-xl transition-all flex items-center justify-center gap-1.5 text-xs font-mono tracking-wider disabled:opacity-50 cursor-pointer active:scale-95"
            title="データを再読み込み"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>最新情報に更新</span>
          </button>
          <button
            id="btn-logout-admin"
            onClick={onLogout}
            className="bg-[#D4AF37] hover:bg-[#C29D26] text-stone-950 font-bold px-4 py-2.5 rounded-xl text-xs uppercase tracking-wider transition-all shadow-sm active:scale-95"
          >
            ログアウト
          </button>
        </div>
      </div>

      {loadError && (
        <div className="bg-amber-50 border border-amber-300 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-amber-950 shadow-xs">
          <div className="flex items-start gap-2.5 text-xs sm:text-sm font-bold">
            <AlertCircle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
            <span>{loadError}</span>
          </div>
          <button
            type="button"
            onClick={loadData}
            className="px-3.5 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-xl transition-colors whitespace-nowrap self-end sm:self-center cursor-pointer"
          >
            再読み込み
          </button>
        </div>
      )}

      {/* Staff / Admin Cancellation Notification Alert Banner */}
      {unreadCancelNotifications.length > 0 && (
        <div
          id="admin-cancellation-notification-banner"
          className="bg-red-50 border-2 border-red-500 rounded-2xl p-4 sm:p-5 shadow-md space-y-3"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-red-200 pb-2.5">
            <div className="flex items-center gap-2 text-red-700 font-bold text-sm sm:text-base">
              <Bell className="w-5 h-5 text-red-600 shrink-0" />
              <span>🚨 スタッフ通知：予約がキャンセルされました（未確認 {unreadCancelNotifications.length} 件）</span>
            </div>
            <button
              type="button"
              onClick={async () => {
                const updated = await markAllCancellationNotificationsRead();
                setCancelNotifications(updated);
                if (onToast) onToast('すべてのキャンセル通知を確認済みにしました');
              }}
              className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-lg transition-colors self-start sm:self-auto whitespace-nowrap cursor-pointer"
            >
              すべて確認済みにする
            </button>
          </div>

          <div className="space-y-2">
            {unreadCancelNotifications.map((notif) => {
              const timeStr = notif.cancelledAt
                ? new Date(notif.cancelledAt).toLocaleString('ja-JP', {
                    timeZone: 'Asia/Tokyo',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                  })
                : '';
              return (
                <div
                  key={notif.id}
                  className="bg-white border border-red-300 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-red-700"
                >
                  <div className="space-y-0.5 text-xs sm:text-sm">
                    <div className="font-bold text-red-700 flex flex-wrap items-center gap-2">
                      <span>【予約キャンセル】{notif.customerName} 様{notif.customerKana ? `（${notif.customerKana}）` : ''}</span>
                      <span className="text-xs font-mono bg-red-100 text-red-800 px-2 py-0.5 rounded">
                        受取予定日：{notif.date} {notif.time}
                      </span>
                      <span className="text-xs font-mono text-red-600">
                        TEL：{notif.phone}
                      </span>
                      {timeStr && (
                        <span className="text-[11px] text-red-500 font-mono">
                          （キャンセル日時: {timeStr}）
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-red-600 font-semibold">
                      キャンセル商品：{notif.itemsSummary}（¥{(Number(notif.totalPrice) || 0).toLocaleString()}）
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      const updated = await markCancellationNotificationRead(notif.reservationId);
                      setCancelNotifications(updated);
                    }}
                    className="px-3 py-1 bg-red-100 hover:bg-red-200 text-red-800 border border-red-300 rounded-lg text-xs font-bold shrink-0 self-end sm:self-center whitespace-nowrap cursor-pointer"
                  >
                    確認済
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Top Navigation Tabs Bar - Responsive Flex Wrap to prevent any tab cutoff */}
      <div className="bg-white rounded-2xl p-1.5 sm:p-2 border border-sleek-border shadow-xs flex flex-wrap items-center gap-1.5 sm:gap-2">
        <button
          id="tab-btn-reservations"
          onClick={() => setActiveTab('reservations')}
          className={`flex-1 sm:flex-initial flex items-center justify-center sm:justify-start gap-1.5 sm:gap-2 px-3 py-2 sm:px-4 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all ${
            activeTab === 'reservations'
              ? 'bg-sleek-dark text-white shadow-xs border border-sleek-dark'
              : 'bg-stone-50 hover:bg-stone-100 text-stone-700 border border-stone-200'
          }`}
        >
          <FileText className="w-4 h-4 text-sleek-gold shrink-0" />
          <span className="whitespace-nowrap">予約者詳細</span>
          <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-bold shrink-0 ${activeTab === 'reservations' ? 'bg-stone-800 text-amber-300' : 'bg-stone-200 text-stone-700'}`}>
            {reservations.length}
          </span>
        </button>

        <button
          id="tab-btn-calendar"
          onClick={() => setActiveTab('calendar')}
          className={`flex-1 sm:flex-initial flex items-center justify-center sm:justify-start gap-1.5 sm:gap-2 px-3 py-2 sm:px-4 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all ${
            activeTab === 'calendar'
              ? 'bg-sleek-dark text-white shadow-xs border border-sleek-dark'
              : 'bg-stone-50 hover:bg-stone-100 text-stone-700 border border-stone-200'
          }`}
        >
          <Calendar className="w-4 h-4 text-sleek-gold shrink-0" />
          <span className="whitespace-nowrap">営業日設定</span>
        </button>

        <button
          id="tab-btn-cakes"
          onClick={() => setActiveTab('cakes')}
          className={`flex-1 sm:flex-initial flex items-center justify-center sm:justify-start gap-1.5 sm:gap-2 px-3 py-2 sm:px-4 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all ${
            activeTab === 'cakes'
              ? 'bg-sleek-dark text-white shadow-xs border border-sleek-dark'
              : 'bg-stone-50 hover:bg-stone-100 text-stone-700 border border-stone-200'
          }`}
        >
          <ShoppingBag className="w-4 h-4 text-sleek-gold shrink-0" />
          <span className="whitespace-nowrap">商品管理設定</span>
          {cakesList.some(c => c.isSoldOut) && (
            <span className="text-[10px] bg-red-500 text-white px-1.5 py-0.2 rounded-full font-mono font-bold shrink-0">
              一部完売中
            </span>
          )}
        </button>

        <button
          id="tab-btn-analytics"
          onClick={() => setActiveTab('analytics')}
          className={`flex-1 sm:flex-initial flex items-center justify-center sm:justify-start gap-1.5 sm:gap-2 px-3 py-2 sm:px-4 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all ${
            activeTab === 'analytics'
              ? 'bg-sleek-dark text-white shadow-xs border border-sleek-dark'
              : 'bg-stone-50 hover:bg-stone-100 text-stone-700 border border-stone-200'
          }`}
        >
          <TrendingUp className="w-4 h-4 text-sleek-gold shrink-0" />
          <span className="whitespace-nowrap">売上・分析グラフ</span>
        </button>
      </div>

      {/* Metrics Row (Always Visible for high-level glance) */}
      <div className="grid grid-cols-2 sm:grid-cols-[1.45fr_1fr_1fr_1fr_1fr] gap-2.5 sm:gap-3">
        {/* Card 1: 予約売上（有効分） - Wider column + dynamic font scaling for growing digits */}
        <div className="col-span-2 sm:col-span-1 bg-white p-3 sm:p-3.5 rounded-2xl border border-sleek-border shadow-xs flex flex-col justify-between gap-2 min-w-0 overflow-hidden">
          <span className="text-sleek-muted text-[10px] sm:text-[11px] block font-semibold tracking-tight leading-snug whitespace-nowrap truncate">
            予約売上（有効分）
          </span>
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-sleek-cream flex items-center justify-center text-sleek-gold shrink-0">
              <DollarSign className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
            </div>
            <span
              className={`font-light font-serif text-sleek-dark tabular-nums tracking-tight whitespace-nowrap min-w-0 truncate ${
                `¥${totalSales.toLocaleString()}`.length <= 7
                  ? 'text-lg sm:text-lg lg:text-xl'
                  : `¥${totalSales.toLocaleString()}`.length <= 9
                  ? 'text-base sm:text-base lg:text-lg'
                  : `¥${totalSales.toLocaleString()}`.length <= 11
                  ? 'text-sm sm:text-sm lg:text-base'
                  : 'text-xs sm:text-xs lg:text-sm'
              }`}
              title={`¥${totalSales.toLocaleString()}`}
            >
              ¥{totalSales.toLocaleString()}
            </span>
          </div>
        </div>

        {/* Card 2: 新規受付（確認待ち） */}
        <div className="bg-white p-3 sm:p-3.5 rounded-2xl border border-sleek-border shadow-xs flex flex-col justify-between gap-2 min-w-0 overflow-hidden">
          <span className="text-sleek-muted text-[10px] sm:text-[11px] block font-semibold tracking-tight leading-snug whitespace-nowrap truncate">
            新規受付<span className="text-[9px] sm:text-[10px]">（確認待ち）</span>
          </span>
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-amber-50 flex items-center justify-center text-amber-700 shrink-0">
              <AlertCircle className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
            </div>
            <span className="text-base sm:text-lg lg:text-xl font-light font-serif text-amber-700 tabular-nums whitespace-nowrap min-w-0">
              {pendingCount} <span className="text-xs text-stone-400 font-sans">件</span>
            </span>
          </div>
        </div>

        {/* Card 3: 予約確定済 */}
        <div className="bg-white p-3 sm:p-3.5 rounded-2xl border border-sleek-border shadow-xs flex flex-col justify-between gap-2 min-w-0 overflow-hidden">
          <span className="text-sleek-muted text-[10px] sm:text-[11px] block font-semibold tracking-tight leading-snug whitespace-nowrap truncate">
            予約確定済
          </span>
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-blue-50 flex items-center justify-center text-blue-700 shrink-0">
              <Calendar className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
            </div>
            <span className="text-base sm:text-lg lg:text-xl font-light font-serif text-blue-800 tabular-nums whitespace-nowrap min-w-0">
              {confirmedCount} <span className="text-xs text-stone-400 font-sans">件</span>
            </span>
          </div>
        </div>

        {/* Card 4: お渡し完了 */}
        <div className="bg-white p-3 sm:p-3.5 rounded-2xl border border-sleek-border shadow-xs flex flex-col justify-between gap-2 min-w-0 overflow-hidden">
          <span className="text-sleek-muted text-[10px] sm:text-[11px] block font-semibold tracking-tight leading-snug whitespace-nowrap truncate">
            お渡し完了
          </span>
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-700 shrink-0">
              <CheckCircle className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
            </div>
            <span className="text-base sm:text-lg lg:text-xl font-light font-serif text-emerald-800 tabular-nums whitespace-nowrap min-w-0">
              {completedCount} <span className="text-xs text-stone-400 font-sans">件</span>
            </span>
          </div>
        </div>

        {/* Card 5: キャンセル発生 */}
        <div
          onClick={() => {
            setActiveTab('reservations');
            setFilterStatus(filterStatus === 'cancelled' ? 'all' : 'cancelled');
          }}
          className={`p-3 sm:p-3.5 rounded-2xl border shadow-xs flex flex-col justify-between gap-2 min-w-0 overflow-hidden cursor-pointer transition-all ${
            cancelledCount > 0
              ? 'bg-red-50 border-red-300 hover:bg-red-100/80'
              : 'bg-white border-sleek-border hover:bg-stone-50'
          }`}
          title="クリックでキャンセルされた予約を絞り込み表示"
        >
          <span className="text-red-700 text-[10px] sm:text-[11px] block font-bold tracking-tight leading-snug whitespace-nowrap truncate">
            キャンセル発生
          </span>
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
            <div className={`w-8 h-8 sm:w-9 sm:h-9 rounded-xl flex items-center justify-center shrink-0 ${
              cancelledCount > 0 ? 'bg-red-600 text-white' : 'bg-red-50 text-red-600'
            }`}>
              <X className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
            </div>
            <span className="text-base sm:text-lg lg:text-xl font-bold font-serif text-red-600 tabular-nums whitespace-nowrap min-w-0">
              {cancelledCount} <span className="text-xs text-red-500 font-sans">件</span>
            </span>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: 予約者詳細すべて (ALL RESERVATION DETAILS - GOOGLE SPREADSHEET FORMAT) */}
      {/* ========================================================================= */}
      {activeTab === 'reservations' && (
        <div className="space-y-4 animate-fade-in">
          {/* Red-Highlighted Cancelled Reservations List Section */}
          {cancelledReservationsList.length > 0 && (
            <div
              id="cancelled-reservations-red-list"
              className="bg-red-50/90 border-2 border-red-400 rounded-2xl p-4 sm:p-5 shadow-xs space-y-3"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-red-200 pb-2.5">
                <div className="flex items-center gap-2 text-red-700 font-bold text-sm sm:text-base">
                  <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />
                  <span>キャンセルされた予約リスト（{cancelledReservationsList.length}件）</span>
                </div>
                <span className="text-xs font-bold text-red-600 bg-white border border-red-300 px-2.5 py-1 rounded-full self-start sm:self-auto">
                  ※キャンセル分は赤字で強調表示されています
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs font-sans bg-white rounded-xl overflow-hidden border border-red-300">
                  <thead>
                    <tr className="bg-red-600 text-white font-bold whitespace-nowrap">
                      <th className="border border-red-400 px-2.5 py-2 text-center w-10">No.</th>
                      <th className="border border-red-400 px-2.5 py-2">キャンセル・更新日時</th>
                      <th className="border border-red-400 px-2.5 py-2">受取予定日</th>
                      <th className="border border-red-400 px-2.5 py-2">受取時間</th>
                      <th className="border border-red-400 px-2.5 py-2">お名前（フリガナ）</th>
                      <th className="border border-red-400 px-2.5 py-2">電話番号</th>
                      <th className="border border-red-400 px-2.5 py-2">メールアドレス</th>
                      <th className="border border-red-400 px-2.5 py-2">キャンセルされたケーキ内訳</th>
                      <th className="border border-red-400 px-2.5 py-2 text-right">金額</th>
                      <th className="border border-red-400 px-2.5 py-2 text-center">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cancelledReservationsList.map((res, idx) => {
                      const breakdown = (res.items || []).map(i => `${i.cakeName}×${i.quantity}`).join('、');
                      const cancelTimeStr = (res.cancelledAt || res.updatedAt)
                        ? new Date(res.cancelledAt || res.updatedAt).toLocaleString('ja-JP', {
                            timeZone: 'Asia/Tokyo',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit'
                          })
                        : '-';
                      return (
                        <tr key={res.id} className="bg-red-50/70 hover:bg-red-100/70 text-red-700 font-bold transition-colors">
                          <td className="border border-red-200 px-2 py-1.5 text-center font-mono text-red-700">
                            {idx + 1}
                          </td>
                          <td className="border border-red-200 px-2.5 py-1.5 font-mono whitespace-nowrap text-red-600">
                            {cancelTimeStr}
                          </td>
                          <td className="border border-red-200 px-2.5 py-1.5 font-mono whitespace-nowrap text-red-700">
                            {res.date}
                          </td>
                          <td className="border border-red-200 px-2.5 py-1.5 font-mono whitespace-nowrap text-red-700">
                            {res.time}
                          </td>
                          <td className="border border-red-200 px-2.5 py-1.5 whitespace-nowrap text-red-700">
                            {res.name} {res.nameKana ? `（${res.nameKana}）` : ''}
                          </td>
                          <td className="border border-red-200 px-2.5 py-1.5 font-mono whitespace-nowrap text-red-700">
                            {res.phone}
                          </td>
                          <td className="border border-red-200 px-2.5 py-1.5 font-mono whitespace-nowrap text-red-700">
                            {res.email}
                          </td>
                          <td className="border border-red-200 px-2.5 py-1.5 whitespace-nowrap text-red-700">
                            {breakdown}
                          </td>
                          <td className="border border-red-200 px-2.5 py-1.5 text-right font-mono whitespace-nowrap text-red-700">
                            ¥{(Number(res.totalPrice) || 0).toLocaleString()}
                          </td>
                          <td className="border border-red-200 px-2 py-1.5 text-center whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => setSelectedReservation(res)}
                              className="px-2.5 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-[11px] font-bold cursor-pointer"
                            >
                              詳細
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="bg-white rounded-2xl border border-stone-300 shadow-sm overflow-hidden">
            {/* Google Spreadsheet Integration & Reservation Table Header */}
            <div className="p-4 sm:p-5 border-b border-stone-300 bg-[#F8F9FA] space-y-3.5">
              {/* Row 1: Header Title, Status Pill & Consolidated Actions */}
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                <div className="flex items-start sm:items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-[#0F9D58] text-white flex items-center justify-center shadow-xs shrink-0 mt-0.5 sm:mt-0">
                    <FileSpreadsheet className="w-5 h-5" />
                  </div>
                  <div className="space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-bold text-stone-900 text-sm sm:text-base">
                        全予約情報 管理台帳
                      </h3>
                      <span className="text-[11px] bg-white border border-stone-300 text-stone-700 px-2 py-0.5 rounded font-mono font-semibold">
                        表示 {filteredReservations.length} / 全 {reservations.length} 件
                      </span>
                      {spreadsheetId ? (
                        <span className="inline-flex items-center gap-1 text-[11px] bg-emerald-100 text-emerald-800 border border-emerald-300 px-2 py-0.5 rounded-full font-bold">
                          <span className="w-2 h-2 rounded-full bg-emerald-600 animate-pulse"></span>
                          スプレッドシート連動中
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] bg-amber-50 text-amber-800 border border-amber-300 px-2 py-0.5 rounded-full font-medium">
                          {googleToken ? '📋 Google認証済（シート未作成）' : '🔑 Google未連携'}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-stone-600 leading-snug">
                      予約台帳の一覧・ステータス更新、およびGoogleスプレッドシートへのリアルタイム自動同期・出力がここで行えます。
                      {lastSyncedTime && (
                        <span className="ml-2 font-mono text-[10px] text-stone-500">（最終同期: {lastSyncedTime}）</span>
                      )}
                    </p>
                  </div>
                </div>

                {/* Primary Action Buttons Bar (Consolidated & Deduplicated) */}
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {spreadsheetId ? (
                    <>
                      <a
                        href={`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`}
                        target="_blank"
                        rel="noreferrer"
                        className="px-3.5 py-1.5 bg-[#0F9D58] hover:bg-[#0b8043] text-white rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-xs transition-all active:scale-95"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span>Googleスプレッドシートを開く ↗</span>
                      </a>
                      <button
                        type="button"
                        onClick={handleSyncNow}
                        disabled={isSyncing}
                        className="px-3 py-1.5 bg-white hover:bg-emerald-50 text-[#0F9D58] border border-[#0F9D58] rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-2xs active:scale-95 cursor-pointer disabled:opacity-50"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                        <span>{isSyncing ? '同期中...' : '最新予約を今すぐ同期'}</span>
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={handleCreateAndLink}
                      disabled={isSyncing || isLinking}
                      className="px-3.5 py-1.5 bg-[#0F9D58] hover:bg-[#0b8043] text-white rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-xs transition-all active:scale-95 cursor-pointer disabled:opacity-50"
                    >
                      <FileSpreadsheet className="w-3.5 h-3.5" />
                      <span>{isSyncing || isLinking ? '作成・連携処理中...' : 'Googleスプレッドシートを作成・連携'}</span>
                    </button>
                  )}

                  {/* CSV Export */}
                  <button
                    type="button"
                    onClick={() => {
                      downloadReservationsCsv(reservations, cakesList);
                      setSheetsFeedback({
                        type: 'success',
                        title: '予約台帳CSVファイルをダウンロードしました',
                        detail: 'Googleスプレッドシートの「ファイル」→「インポート」やExcelでそのまま開くことができます。',
                      });
                      if (onToast) onToast('📥 予約台帳CSVをダウンロードしました');
                    }}
                    className="px-3 py-1.5 bg-white hover:bg-stone-100 text-stone-800 border border-stone-300 rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-2xs active:scale-95 cursor-pointer"
                    title="CSVファイルをダウンロード"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" />
                    <span>CSV出力</span>
                  </button>

                  {/* Copy formatted data for direct sheet pasting */}
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const count = await copyReservationsForSheets(reservations, cakesList);
                        setSheetsFeedback({
                          type: 'success',
                          title: `全${count}件の予約台帳データをクリップボードにコピーしました！`,
                          detail: 'スプレッドシートやExcelのA1セルで「貼り付け（Ctrl+V / ⌘+V）」するだけで表が完成します。',
                        });
                        if (onToast) onToast('📋 スプレッドシート貼り付け用データをコピーしました');
                      } catch (err) {
                        console.error('Clipboard copy failed:', err);
                      }
                    }}
                    className="px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-950 border border-amber-300 rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-2xs active:scale-95 cursor-pointer"
                    title="クリップボードにコピーしてスプレッドシートへ直接貼り付け"
                  >
                    <Layers className="w-3.5 h-3.5 text-amber-700" />
                    <span>表をコピー</span>
                  </button>

                  {/* Settings toggle button */}
                  <button
                    type="button"
                    onClick={() => setShowSheetsSettings(!showSheetsSettings)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 border transition-colors cursor-pointer ${
                      showSheetsSettings 
                        ? 'bg-stone-800 text-white border-stone-800' 
                        : 'bg-white hover:bg-stone-100 text-stone-700 border-stone-300'
                    }`}
                    title="スプレッドシート連携設定（URL変更・再認証など）"
                  >
                    <Settings className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">連携設定</span>
                  </button>

                  {/* Delete All Reservations Button */}
                  <button
                    type="button"
                    id="btn-delete-all-reservations"
                    onClick={() => {
                      setRestoreStockOnDeleteAll(true);
                      setDeleteAllPassword('');
                      setDeleteAllPasswordError(null);
                      setShowDeleteAllModal(true);
                    }}
                    className="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-700 border border-red-300 rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-2xs active:scale-95 cursor-pointer"
                    title="テスト予約など現在の予約データをすべて削除して初期化します"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-red-600" />
                    <span>予約を全削除</span>
                  </button>
                </div>
              </div>

              {/* In-page Feedback Banner */}
              {sheetsFeedback && (
                <div
                  className={`p-3 sm:p-3.5 rounded-xl border flex items-start justify-between gap-3 text-xs ${
                    sheetsFeedback.type === 'success'
                      ? 'bg-emerald-50 border-emerald-300 text-emerald-950'
                      : sheetsFeedback.type === 'error'
                      ? 'bg-red-50 border-red-300 text-red-950'
                      : 'bg-amber-50 border-amber-300 text-amber-950'
                  }`}
                >
                  <div className="space-y-1 min-w-0">
                    <p className="font-bold text-xs sm:text-sm flex items-center gap-1.5">
                      {sheetsFeedback.type === 'success' && <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />}
                      {sheetsFeedback.type === 'error' && <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />}
                      <span>{sheetsFeedback.title}</span>
                    </p>
                    {sheetsFeedback.detail && (
                      <p className="text-[11px] sm:text-xs opacity-90 leading-relaxed break-all">{sheetsFeedback.detail}</p>
                    )}
                    {spreadsheetId && sheetsFeedback.type === 'success' && (
                      <div className="pt-1">
                        <a
                          href={`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs shadow-2xs"
                        >
                          <ExternalLink className="w-3 h-3" />
                          スプレッドシートを開く ↗
                        </a>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setSheetsFeedback(null)}
                    className="text-stone-400 hover:text-stone-700 p-1 cursor-pointer shrink-0 font-bold"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Expandable Settings Drawer */}
              {showSheetsSettings && (
                <div className="bg-white border border-stone-300 rounded-xl p-3.5 space-y-3 text-xs">
                  <div className="flex items-center justify-between border-b border-stone-200 pb-2">
                    <span className="font-bold text-stone-800 flex items-center gap-1.5">
                      <Settings className="w-3.5 h-3.5 text-stone-500" />
                      スプレッドシート連携・詳細設定
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowSheetsSettings(false)}
                      className="text-[11px] text-stone-500 hover:text-stone-800 cursor-pointer"
                    >
                      閉じる ✕
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* Status & Re-auth */}
                    <div className="bg-stone-50 p-3 rounded-lg border border-stone-200 space-y-2">
                      <span className="text-[10px] font-mono font-bold text-stone-500 uppercase block">1. Googleアカウント認証</span>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs">
                          {googleToken ? (
                            <span className="text-emerald-700 font-bold flex items-center gap-1">
                              <CheckCircle className="w-3.5 h-3.5" /> 認証済み
                            </span>
                          ) : (
                            <span className="text-amber-700 font-medium">未認証</span>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleGoogleLink(true)}
                          disabled={isLinking}
                          className="px-2.5 py-1 bg-white hover:bg-stone-100 text-stone-700 border border-stone-300 rounded text-[11px] font-semibold cursor-pointer disabled:opacity-50"
                        >
                          {isLinking ? '認証中...' : googleToken ? '再認証・権限更新' : 'Googleと連携'}
                        </button>
                      </div>
                    </div>

                    {/* Linked Sheet ID & Reset */}
                    <div className="bg-stone-50 p-3 rounded-lg border border-stone-200 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-mono font-bold text-stone-500 uppercase block">2. 連携先スプレッドシート</span>
                        {spreadsheetId && (
                          <button
                            type="button"
                            onClick={handleUnlinkSheet}
                            className="text-[10px] text-red-600 hover:underline font-medium cursor-pointer"
                          >
                            連携解除
                          </button>
                        )}
                      </div>
                      {spreadsheetId ? (
                        <div className="space-y-0.5">
                          <a
                            href={`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-emerald-800 hover:underline font-bold text-[11px] flex items-center gap-1 truncate"
                          >
                            <ExternalLink className="w-3 h-3 shrink-0" />
                            開く: {spreadsheetId}
                          </a>
                        </div>
                      ) : (
                        <p className="text-[11px] text-stone-500">未設定（「作成・連携」から自動作成できます）</p>
                      )}
                    </div>
                  </div>

                  {/* Existing sheet URL manual linking & sheets.new link */}
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 pt-1 border-t border-stone-200">
                    <form onSubmit={handleLinkExistingSheet} className="flex gap-2 flex-1">
                      <input
                        type="text"
                        value={manualSheetInput}
                        onChange={(e) => setManualSheetInput(e.target.value)}
                        placeholder="既存のスプレッドシートURL または ID を貼り付けて連携..."
                        className="flex-1 min-w-0 bg-white border border-stone-300 rounded px-2.5 py-1 text-[11px] text-stone-800 focus:outline-none focus:border-[#0F9D58]"
                      />
                      <button
                        type="submit"
                        className="px-3 py-1 bg-stone-800 hover:bg-black text-white rounded text-[11px] font-semibold shrink-0 cursor-pointer"
                      >
                        URL設定
                      </button>
                    </form>

                    <a
                      href="https://sheets.new"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-stone-600 hover:text-stone-900 underline flex items-center gap-1 shrink-0 px-1 py-1"
                    >
                      <ExternalLink className="w-3 h-3" />
                      空のGoogleスプレッドシートを新規作成 (sheets.new) ↗
                    </a>
                  </div>
                </div>
              )}

              {/* Date, Status and Search Controls */}
              <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-2 pt-2 border-t border-stone-300">
                {/* Date Filter Pills */}
                <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
                  <span className="text-xs text-stone-600 font-bold shrink-0 flex items-center gap-1 mr-1">
                    <Calendar className="w-3.5 h-3.5 text-[#0F9D58]" />
                    受取日フィルタ:
                  </span>
                  <button
                    onClick={() => setFilterDate('all')}
                    className={`px-2.5 py-1 rounded text-xs font-bold transition-all shrink-0 border ${
                      filterDate === 'all'
                        ? 'bg-[#0F9D58] text-white border-[#0F9D58]'
                        : 'bg-white text-stone-700 hover:bg-stone-100 border-stone-300'
                    }`}
                  >
                    全日程
                  </button>
                  {reservationDates.map(d => (
                    <button
                      key={d}
                      onClick={() => setFilterDate(d)}
                      className={`px-2.5 py-1 rounded text-xs font-bold transition-all shrink-0 border ${
                        filterDate === d
                          ? 'bg-[#0F9D58] text-white border-[#0F9D58]'
                          : 'bg-white text-stone-700 hover:bg-stone-100 border-stone-300'
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 shrink-0">
                  {/* Search Input */}
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="氏名・カナ・電話・メール・ケーキ検索..."
                      className="pl-8 pr-3 py-1.5 border border-stone-300 rounded text-xs w-full sm:w-64 focus:outline-none focus:border-[#0F9D58] bg-white"
                    />
                  </div>

                  {/* Dropdown Status Filter */}
                  <div className="flex items-center gap-1">
                    <Filter className="w-3.5 h-3.5 text-stone-500" />
                    <select
                      value={filterStatus}
                      onChange={(e) => setFilterStatus(e.target.value)}
                      className="py-1.5 px-2.5 border border-stone-300 rounded text-xs bg-white text-stone-800 focus:outline-none focus:border-[#0F9D58]"
                    >
                      <option value="all">全ステータス</option>
                      <option value="pending">受付中（承認待ち）</option>
                      <option value="confirmed">予約確定</option>
                      <option value="completed">お渡し完了</option>
                      <option value="cancelled">キャンセル</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>

            {/* Google Spreadsheet-Style Grid Table containing ALL reservation information (No ID, No Message Plate, No Candles) */}
            <div className="overflow-x-auto">
              {filteredReservations.length > 0 ? (
                <table className="w-full text-left border-collapse text-xs font-sans">
                  <thead>
                    {/* Google Sheets Column Header Row */}
                    <tr className="bg-[#E6F4EA] text-stone-800 font-bold whitespace-nowrap select-none">
                      <th className="border border-stone-300 bg-[#F1F3F4] px-2 py-2 text-center w-10 font-mono text-[11px] text-stone-600">
                        No.
                      </th>
                      <th className="border border-stone-300 px-2.5 py-2">受付日時</th>
                      <th className="border border-stone-300 px-2.5 py-2 text-center">ステータス</th>
                      <th className="border border-stone-300 px-2.5 py-2">受取日</th>
                      <th className="border border-stone-300 px-2.5 py-2">受取時間</th>
                      <th className="border border-stone-300 px-2.5 py-2">お名前</th>
                      <th className="border border-stone-300 px-2.5 py-2">フリガナ</th>
                      <th className="border border-stone-300 px-2.5 py-2">電話番号</th>
                      <th className="border border-stone-300 px-2.5 py-2">メールアドレス</th>
                      <th className="border border-stone-300 px-2.5 py-2">予約ケーキ内訳</th>
                      {cakesList.map(cake => (
                        <th
                          key={cake.id}
                          className="border border-stone-300 px-2 py-2 text-center bg-[#CEEAD6]/60 text-[#0d652d]"
                          title={`${cake.jpName} (¥${cake.price.toLocaleString()})`}
                        >
                          {cake.jpName}
                        </th>
                      ))}
                      <th className="border border-stone-300 px-2.5 py-2 text-right bg-amber-50/70">合計個数</th>
                      <th className="border border-stone-300 px-2.5 py-2 text-right bg-amber-50/70">合計金額(税込)</th>
                      <th className="border border-stone-300 px-2.5 py-2">備考</th>
                      <th className="border border-stone-300 px-2.5 py-2">最終更新日時</th>
                      <th className="border border-stone-300 px-2.5 py-2 text-center">詳細</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredReservations.map((res, index) => {
                      const safeItems = Array.isArray(res.items) ? res.items : [];
                      const totalQty = safeItems.reduce((sum, item) => sum + (Number(item?.quantity) || 0), 0);
                      const breakdownText = safeItems.map(i => `${i.cakeName}×${i.quantity}`).join('、');
                      const createdStr = res.createdAt
                        ? new Date(res.createdAt).toLocaleString('ja-JP', {
                            timeZone: 'Asia/Tokyo',
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit'
                          })
                        : '-';
                      const updatedStr = res.updatedAt
                        ? new Date(res.updatedAt).toLocaleString('ja-JP', {
                            timeZone: 'Asia/Tokyo',
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit'
                          })
                        : '-';

                      const isCancelled = res.status === 'cancelled';

                      return (
                        <tr
                          key={res.id}
                          className={`transition-colors ${
                            isCancelled
                              ? 'bg-red-50/90 hover:bg-red-100/80 text-red-600 font-bold'
                              : res.status === 'completed'
                              ? 'bg-emerald-50/30 hover:bg-[#E8F0FE]/60 text-stone-800'
                              : index % 2 === 1
                              ? 'bg-[#F8F9FA] hover:bg-[#E8F0FE]/60 text-stone-900'
                              : 'bg-white hover:bg-[#E8F0FE]/60 text-stone-900'
                          }`}
                        >
                          {/* Row Number */}
                          <td className={`border border-stone-300 px-2 py-1.5 text-center font-mono text-[11px] font-semibold ${
                            isCancelled ? 'bg-red-100 text-red-700 font-bold' : 'bg-[#F1F3F4] text-stone-500'
                          }`}>
                            {index + 1}
                          </td>

                          {/* Created At */}
                          <td className={`border border-stone-300 px-2.5 py-1.5 font-mono text-[11px] whitespace-nowrap ${
                            isCancelled ? 'text-red-600 font-bold' : 'text-stone-600'
                          }`}>
                            {createdStr}
                          </td>

                          {/* Status (Inline Select in Spreadsheet Cell) */}
                          <td className="border border-stone-300 px-2 py-1 text-center whitespace-nowrap">
                            <select
                              value={res.status}
                              onChange={(e) => handleStatusChange(res.id, e.target.value as ReservationStatus)}
                              className={`text-[11px] font-bold px-2 py-1 rounded border cursor-pointer focus:outline-none ${
                                res.status === 'completed'
                                  ? 'bg-emerald-100 text-emerald-900 border-emerald-300'
                                  : res.status === 'confirmed'
                                  ? 'bg-blue-100 text-blue-900 border-blue-300'
                                  : res.status === 'cancelled'
                                  ? 'bg-red-600 text-white border-red-700'
                                  : 'bg-amber-100 text-amber-900 border-amber-300'
                              }`}
                            >
                              <option value="pending">受付中</option>
                              <option value="confirmed">予約確定</option>
                              <option value="completed">お渡し完了</option>
                              <option value="cancelled">キャンセル</option>
                            </select>
                          </td>

                          {/* Pickup Date */}
                          <td className={`border border-stone-300 px-2.5 py-1.5 font-mono font-bold whitespace-nowrap ${isCancelled ? 'text-red-600' : ''}`}>
                            {res.date}
                          </td>

                          {/* Pickup Time */}
                          <td className={`border border-stone-300 px-2.5 py-1.5 font-mono whitespace-nowrap ${isCancelled ? 'text-red-600 font-bold' : ''}`}>
                            {res.time}
                          </td>

                          {/* Customer Name */}
                          <td className={`border border-stone-300 px-2.5 py-1.5 font-bold whitespace-nowrap ${isCancelled ? 'text-red-600' : ''}`}>
                            {res.name}
                          </td>

                          {/* Customer Kana */}
                          <td className={`border border-stone-300 px-2.5 py-1.5 whitespace-nowrap ${isCancelled ? 'text-red-600 font-bold' : 'text-stone-700'}`}>
                            {res.nameKana || '-'}
                          </td>

                          {/* Phone */}
                          <td className={`border border-stone-300 px-2.5 py-1.5 font-mono whitespace-nowrap ${isCancelled ? 'text-red-600 font-bold' : ''}`}>
                            {res.phone}
                          </td>

                          {/* Email */}
                          <td className={`border border-stone-300 px-2.5 py-1.5 font-mono whitespace-nowrap ${isCancelled ? 'text-red-600 font-bold' : ''}`}>
                            {res.email}
                          </td>

                          {/* Cake Items Summary String */}
                          <td className={`border border-stone-300 px-2.5 py-1.5 whitespace-nowrap min-w-[180px] ${isCancelled ? 'text-red-600 font-bold' : ''}`}>
                            {breakdownText}
                          </td>

                          {/* Individual Cake Quantity Columns */}
                          {cakesList.map(cake => {
                            const qty = safeItems
                              .filter(i => i.cakeId === cake.id || i.cakeName === cake.jpName)
                              .reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);
                            return (
                              <td
                                key={cake.id}
                                className={`border border-stone-300 px-2 py-1.5 text-center font-mono ${
                                  isCancelled
                                    ? qty > 0
                                      ? 'font-bold text-red-700 bg-red-100/80'
                                      : 'text-red-300'
                                    : qty > 0
                                    ? 'font-bold text-[#0d652d] bg-emerald-50/40'
                                    : 'text-stone-300'
                                }`}
                              >
                                {qty}
                              </td>
                            );
                          })}

                          {/* Total Quantity */}
                          <td className={`border border-stone-300 px-2.5 py-1.5 text-right font-mono font-bold whitespace-nowrap ${
                            isCancelled ? 'bg-red-100/70 text-red-700' : 'bg-amber-50/30'
                          }`}>
                            {totalQty}
                          </td>

                          {/* Total Price */}
                          <td className={`border border-stone-300 px-2.5 py-1.5 text-right font-mono font-bold whitespace-nowrap ${
                            isCancelled ? 'bg-red-100/70 text-red-700' : 'bg-amber-50/30'
                          }`}>
                            ¥{(Number(res.totalPrice) || 0).toLocaleString()}
                          </td>

                          {/* Notes */}
                          <td className={`border border-stone-300 px-2.5 py-1.5 min-w-[140px] ${isCancelled ? 'text-red-600 font-bold' : ''}`}>
                            {res.notes || '-'}
                          </td>

                          {/* Updated At */}
                          <td className={`border border-stone-300 px-2.5 py-1.5 font-mono text-[11px] whitespace-nowrap ${
                            isCancelled ? 'text-red-600 font-bold' : 'text-stone-500'
                          }`}>
                            {updatedStr}
                          </td>

                          {/* Detail Modal Trigger */}
                          <td className="border border-stone-300 px-2 py-1.5 text-center whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => setSelectedReservation(res)}
                              className={`px-2 py-0.5 border rounded text-[11px] font-medium cursor-pointer ${
                                isCancelled
                                  ? 'bg-red-600 hover:bg-red-700 border-red-700 text-white font-bold'
                                  : 'bg-stone-100 hover:bg-stone-200 border-stone-300 text-stone-700'
                              }`}
                            >
                              詳細
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>

                  {/* Google Sheets Bottom Summary / Total Row (有効予約の合計) */}
                  <tfoot>
                    <tr className="bg-[#F1F3F4] font-bold text-stone-900 border-t-2 border-stone-400 whitespace-nowrap">
                      <td colSpan={10} className="border border-stone-300 px-3 py-2 text-right">
                        合計（キャンセル除く有効予約 {filteredReservations.filter(r => r.status !== 'cancelled').length} 件）
                      </td>
                      {cakesList.map(cake => {
                        const sumCake = filteredReservations
                          .filter(r => r.status !== 'cancelled')
                          .reduce((acc, r) => {
                            const itemSum = (r.items || [])
                              .filter(i => i.cakeId === cake.id || i.cakeName === cake.jpName)
                              .reduce((s, i) => s + (Number(i.quantity) || 0), 0);
                            return acc + itemSum;
                          }, 0);
                        return (
                          <td key={cake.id} className="border border-stone-300 px-2 py-2 text-center font-mono text-[#0d652d] bg-[#E6F4EA]">
                            {sumCake}
                          </td>
                        );
                      })}
                      <td className="border border-stone-300 px-2.5 py-2 text-right font-mono bg-amber-100/70">
                        {kitchenPrepCounts.totalCakes}
                      </td>
                      <td className="border border-stone-300 px-2.5 py-2 text-right font-mono bg-amber-100/70 text-amber-950">
                        ¥{filteredReservations
                          .filter(r => r.status !== 'cancelled')
                          .reduce((acc, r) => acc + r.totalPrice, 0)
                          .toLocaleString()}
                      </td>
                      <td colSpan={3} className="border border-stone-300 px-2.5 py-2"></td>
                    </tr>
                  </tfoot>
                </table>
              ) : (
                <div className="p-12 text-center text-sleek-muted space-y-2">
                  <AlertCircle className="w-8 h-8 text-sleek-gold mx-auto" />
                  <p className="text-xs">該当するご予約データはありません</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: 営業日設定 (BUSINESS DAYS SETTINGS) */}
      {/* ========================================================================= */}
      {activeTab === 'calendar' && (
        <div className="space-y-6 animate-fade-in">
          <div className="bg-white p-5 rounded-2xl border border-sleek-border shadow-xs">
            <h3 className="text-lg font-serif font-light text-sleek-dark flex items-center gap-2">
              <Calendar className="w-5 h-5 text-sleek-gold" />
              受取可能日・営業日設定
            </h3>
            <p className="text-xs text-sleek-muted mt-0.5 leading-relaxed">
              お客様が受取希望日を選択できるカレンダーの営業日を設定します。日付をクリックして「営業日」「定休日」を切り替えられます。
            </p>
          </div>

          {/* Dynamic business days planning calendar component */}
          <BusinessDaysCalendar onSaved={() => {
            if (onToast) onToast('営業日設定を保存しました');
          }} />
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 3: ケーキの種類の変更 ＆ 手動で売り切れ（オーダーストップ） */}
      {/* ========================================================================= */}
      {activeTab === 'cakes' && (
        <div className="space-y-6 animate-fade-in">
          <AdminCakeManager 
            cakes={cakesList}
            onCakesChanged={handleCakesChanged}
            onToast={onToast}
            businessDays={businessDays}
            onNavigateToCalendar={() => setActiveTab('calendar')}
          />
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 4: 売上・分析グラフ (ANALYTICS & CHARTS) */}
      {/* ========================================================================= */}
      {activeTab === 'analytics' && (
        <div className="space-y-6 animate-fade-in">
          {/* Visual Analytics Charts Row using Recharts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Date Wise Sales Trend Bar Chart */}
            <div className="bg-white rounded-3xl p-6 border border-sleek-border shadow-xs">
              <h3 className="font-light text-sleek-dark text-sm md:text-base mb-6 flex items-center gap-2 font-serif">
                <TrendingUp className="w-5 h-5 text-sleek-gold" />
                お受取り日別売上実績（直近7予約日）
              </h3>
              <div className="h-64 w-full">
                {chartRevenueData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartRevenueData}>
                      <XAxis dataKey="date" stroke="#706B63" fontSize={10} tickLine={false} axisLine={false} />
                      <YAxis stroke="#706B63" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => `¥${v/1000}k`} />
                      <Tooltip formatter={(value) => [`¥${Number(value).toLocaleString()}`, '売上金額']} contentStyle={{ background: '#FAF9F6', border: '1px solid #EBE7E0', borderRadius: '12px', fontSize: '11px' }} />
                      <Bar dataKey="revenue" fill="#1A1A1A" radius={[4, 4, 0, 0]} maxBarSize={38} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-sleek-muted text-xs">十分な予約データがありません</div>
                )}
              </div>
            </div>

            {/* Cake Popularity Pie Chart */}
            <div className="bg-white rounded-3xl p-6 border border-sleek-border shadow-xs">
              <h3 className="font-light text-sleek-dark text-sm md:text-base mb-6 flex items-center gap-2 font-serif">
                <ShoppingBag className="w-5 h-5 text-sleek-gold" />
                ケーキ種類別フレーバー予約配分
              </h3>
              <div className="h-64 w-full">
                {chartPopularityData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={chartPopularityData}
                        cx="50%"
                        cy="45%"
                        innerRadius={55}
                        outerRadius={75}
                        paddingAngle={3}
                        dataKey="value"
                      >
                        {chartPopularityData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ background: '#FAF9F6', border: '1px solid #EBE7E0', borderRadius: '12px', fontSize: '11px' }} />
                      <Legend verticalAlign="bottom" height={36} iconSize={8} wrapperStyle={{ fontSize: '10px', color: '#706B63' }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-sleek-muted text-xs">十分な予約データがありません</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}


      {/* ========================================================================= */}
      {/* Slide-over Detail view for selected item */}
      {/* ========================================================================= */}
      <AnimatePresence>
        {selectedReservation && (
          <motion.div
            id="admin-detail-drawer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-stone-950/80 backdrop-blur-md flex items-center justify-end z-50 p-0"
            onClick={() => setSelectedReservation(null)}
          >
            <motion.div
              id="admin-detail-drawer-card"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'tween', duration: 0.25 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-white w-full max-w-lg h-full p-6 md:p-8 flex flex-col justify-between shadow-2xl border-l border-sleek-border overflow-y-auto"
            >
              {/* Drawer Top */}
              <div className="space-y-6">
                <div className="flex items-center justify-between border-b border-sleek-border pb-4">
                  <div>
                    <h3 className="font-light text-sleek-dark text-lg font-serif">予約カルテ・お客様詳細</h3>
                  </div>
                  <button
                    onClick={() => setSelectedReservation(null)}
                    className="text-sleek-muted hover:text-sleek-dark hover:bg-sleek-cream p-1.5 rounded-full w-8 h-8 flex items-center justify-center font-bold text-xs border border-sleek-border cursor-pointer"
                  >
                    ✕
                  </button>
                </div>

                {/* Status bar */}
                <div className="flex items-center justify-between bg-sleek-cream p-4 border border-[#F2EDE4] rounded-2xl">
                  <span className="text-sleek-muted text-xs font-mono uppercase tracking-wider">受付承認ステータス</span>
                  <div>{getStatusBadge(selectedReservation.status)}</div>
                </div>

                {/* Customer info */}
                <div className="space-y-3">
                  <h4 className="text-[10px] text-sleek-muted font-bold uppercase tracking-widest font-mono">1. ご連絡先・ご来店スケジュール</h4>
                  
                  <div className="bg-sleek-bg p-4 rounded-2xl border border-sleek-border space-y-2.5 text-xs font-light">
                    <div className="flex justify-between items-center">
                      <span className="text-sleek-muted">お客様氏名</span>
                      <strong className="text-sleek-dark font-medium font-serif text-sm">
                        {selectedReservation.name} 様
                        {selectedReservation.nameKana && (
                          <span className="text-xs text-stone-500 font-sans font-normal ml-1">
                            ({selectedReservation.nameKana})
                          </span>
                        )}
                      </strong>
                    </div>
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-sleek-muted">お受取日時</span>
                      <span className="text-sleek-gold font-semibold flex items-center gap-1.5">
                        <Calendar className="w-3.5 h-3.5" /> {selectedReservation.date}（{selectedReservation.time}）
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sleek-muted">お電話番号</span>
                      <a href={`tel:${selectedReservation.phone}`} className="text-sleek-dark underline flex items-center gap-1 font-mono">
                        <Phone className="w-3 h-3 text-sleek-gold" />
                        {selectedReservation.phone}
                      </a>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sleek-muted">メールアドレス</span>
                      <a href={`mailto:${selectedReservation.email}`} className="text-sleek-dark underline flex items-center gap-1 font-mono truncate max-w-[200px]">
                        <Mail className="w-3 h-3 text-sleek-gold" />
                        {selectedReservation.email}
                      </a>
                    </div>
                  </div>
                </div>

                {/* Cake items breakdown */}
                <div className="space-y-3">
                  <h4 className="text-[10px] text-sleek-muted font-bold uppercase tracking-widest font-mono">2. ご注文内容内訳</h4>
                  
                  <div className="divide-y divide-sleek-border bg-white border border-sleek-border p-4 rounded-2xl shadow-xs">
                    {(selectedReservation.items || []).map((item, idx) => (
                      <div key={idx} className="flex justify-between py-2.5 first:pt-0 last:pb-0 text-xs">
                        <div>
                          <span className="font-light text-sleek-dark font-serif">{item.cakeName}</span>
                          <span className="text-sleek-muted text-[10px] block font-mono mt-0.5">
                            ¥{(Number(item.price) || 0).toLocaleString()} × {item.quantity}個
                          </span>
                        </div>
                        <span className="font-serif font-light text-sleek-dark align-middle">
                          ¥{((Number(item.price) || 0) * (Number(item.quantity) || 0)).toLocaleString()}
                        </span>
                      </div>
                    ))}
                    <div className="flex justify-between items-baseline pt-3 mt-3 border-t border-sleek-border font-light">
                      <span className="text-sleek-dark text-[10px] font-mono uppercase tracking-wider font-bold">お会計合計額</span>
                      <span className="text-sleek-gold font-serif text-lg font-semibold">
                        ¥{(Number(selectedReservation.totalPrice) || 0).toLocaleString()}（税込）
                      </span>
                    </div>
                  </div>
                </div>

                {/* Notes if any */}
                {selectedReservation.notes && (
                  <div className="space-y-3">
                    <h4 className="text-[10px] text-sleek-muted font-bold uppercase tracking-widest font-mono">3. 備考連絡</h4>
                    <div className="bg-sleek-cream border border-[#F2EDE4] p-4 rounded-2xl text-xs">
                      <p className="text-sleek-muted font-light leading-relaxed font-sans">{selectedReservation.notes}</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Action buttons inside drawer footer */}
              <div className="border-t border-sleek-border pt-5 space-y-3">
                <div className="flex items-center gap-3">
                  {selectedReservation.status === 'pending' && (
                    <button
                      onClick={() => handleStatusChange(selectedReservation.id, 'confirmed')}
                      className="flex-1 bg-sleek-dark hover:bg-black text-white font-semibold py-3 rounded-xl transition-all shadow-md flex items-center justify-center gap-1.5 border border-sleek-border-light cursor-pointer text-xs uppercase tracking-wider active:scale-95"
                    >
                      <Check className="w-4 h-4 text-sleek-gold" />
                      確定
                    </button>
                  )}
                  {selectedReservation.status === 'confirmed' && (
                    <button
                      onClick={() => handleStatusChange(selectedReservation.id, 'completed')}
                      className="flex-1 bg-emerald-700 hover:bg-emerald-800 text-white font-semibold py-3 rounded-xl transition-all shadow-md flex items-center justify-center gap-1.5 cursor-pointer text-xs uppercase tracking-wider active:scale-95"
                    >
                      <CheckCircle className="w-4 h-4" />
                      お渡し完了
                    </button>
                  )}
                  {selectedReservation.status !== 'cancelled' && selectedReservation.status !== 'completed' && (
                    <button
                      onClick={() => handleStatusChange(selectedReservation.id, 'cancelled')}
                      className="px-4 bg-white border border-sleek-border text-sleek-muted hover:text-red-600 font-medium py-3 rounded-xl transition-colors flex items-center justify-center gap-1 cursor-pointer text-xs active:scale-95"
                    >
                      <X className="w-4 h-4" />
                      キャンセル
                    </button>
                  )}
                </div>

                {/* Single Reservation Permanent Delete (2-step) */}
                <div className="flex items-center justify-between pt-2 border-t border-stone-200/80 text-xs">
                  {confirmDeleteSingleId === selectedReservation.id ? (
                    <div className="flex items-center justify-between gap-2 w-full bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                      <span className="text-[11px] font-bold text-red-800">この予約データを完全に削除しますか？</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          disabled={isDeletingSingle}
                          onClick={() => handleDeleteSingleReservation(selectedReservation)}
                          className="px-2.5 py-1 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-lg text-[11px] font-bold cursor-pointer"
                        >
                          {isDeletingSingle ? '削除中...' : '完全に削除'}
                        </button>
                        <button
                          type="button"
                          disabled={isDeletingSingle}
                          onClick={() => setConfirmDeleteSingleId(null)}
                          className="px-2.5 py-1 bg-white border border-stone-300 text-stone-700 rounded-lg text-[11px] font-medium cursor-pointer"
                        >
                          戻る
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteSingleId(selectedReservation.id)}
                      className="text-stone-500 hover:text-red-600 text-[11px] font-medium flex items-center gap-1 cursor-pointer ml-auto"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>このテスト予約データを削除する</span>
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete All Reservations Confirmation Modal */}
      <AnimatePresence>
        {showDeleteAllModal && (
          <motion.div
            id="delete-all-reservations-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-stone-950/80 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => !isDeletingAll && setShowDeleteAllModal(false)}
          >
            <motion.form
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              onSubmit={(e) => {
                e.preventDefault();
                handleDeleteAllReservations();
              }}
              className="bg-white rounded-2xl max-w-md w-full p-6 border border-stone-200 shadow-2xl space-y-4"
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-red-100 text-red-600 flex items-center justify-center shrink-0">
                  <Trash2 className="w-5 h-5" />
                </div>
                <div className="space-y-1">
                  <h3 className="font-bold text-stone-900 text-base">
                    すべての予約データを削除（初期化）しますか？
                  </h3>
                  <p className="text-xs text-stone-600 leading-relaxed">
                    現在登録されている予約データ（全{reservations.length}件）およびキャンセル通知履歴をデータベースとこの端末から完全に削除します。この操作は元に戻せません。
                  </p>
                </div>
              </div>

              <label className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl p-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={restoreStockOnDeleteAll}
                  onChange={(e) => setRestoreStockOnDeleteAll(e.target.checked)}
                  className="mt-0.5 rounded accent-amber-700"
                />
                <span className="text-xs text-amber-950 leading-relaxed font-medium">
                  テスト予約等で減っていた商品の在庫数も元に戻す（おすすめ）
                </span>
              </label>

              <div className="space-y-1.5">
                <label
                  htmlFor="delete-all-password-input"
                  className="block text-xs font-bold text-stone-800"
                >
                  管理者パスワードを入力してください
                </label>
                <input
                  id="delete-all-password-input"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={deleteAllPassword}
                  onChange={(e) => {
                    setDeleteAllPassword(e.target.value);
                    if (deleteAllPasswordError) setDeleteAllPasswordError(null);
                  }}
                  placeholder="管理者パスワード"
                  disabled={isDeletingAll}
                  className={`w-full px-3.5 py-2.5 rounded-xl border text-sm font-mono focus:outline-none focus:ring-2 ${
                    deleteAllPasswordError
                      ? 'border-red-400 bg-red-50/40 focus:ring-red-400'
                      : 'border-stone-300 bg-white focus:ring-red-500'
                  }`}
                />
                {deleteAllPasswordError && (
                  <p className="text-xs font-bold text-red-600">{deleteAllPasswordError}</p>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={isDeletingAll}
                  onClick={() => {
                    setDeleteAllPassword('');
                    setDeleteAllPasswordError(null);
                    setShowDeleteAllModal(false);
                  }}
                  className="px-4 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-xl text-xs font-semibold cursor-pointer disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  id="btn-confirm-delete-all-reservations"
                  disabled={isDeletingAll || !deleteAllPassword.trim()}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-sm"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>{isDeletingAll ? '削除しています...' : 'すべて削除を実行する'}</span>
                </button>
              </div>
            </motion.form>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
