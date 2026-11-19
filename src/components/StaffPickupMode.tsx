import { useState, useEffect, useMemo, useRef } from 'react';
import { Reservation, CancellationNotification } from '../types';
import { 
  fetchReservations, 
  updateReservationStatus, 
  fetchCancellationNotifications, 
  markCancellationNotificationRead, 
  markAllCancellationNotificationsRead, 
  subscribeToReservations,
  fetchBusinessDaysStrict,
  getFriendlyFirebaseErrorMessage
} from '../lib/dbService';
import { motion } from 'motion/react';
import { 
  CheckCircle2, 
  Calendar, 
  Clock, 
  ShoppingBag, 
  AlertCircle, 
  RefreshCw, 
  ArrowLeft,
  Check,
  X,
  Undo2,
  Bell,
  CalendarDays,
  Layers,
  ChevronDown
} from 'lucide-react';

interface StaffPickupModeProps {
  onExit: () => void;
  onToast?: (message: string) => void;
}

function getJapaneseDayOfWeek(dateStr: string): string {
  if (!dateStr || dateStr === 'all') return '';
  const parts = dateStr.split('-').map(Number);
  if (parts.length !== 3) return '';
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  return dayNames[d.getDay()] || '';
}

export default function StaffPickupMode({ onExit, onToast }: StaffPickupModeProps) {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [businessDays, setBusinessDays] = useState<string[]>([]);
  const [cancelNotifications, setCancelNotifications] = useState<CancellationNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'completed' | 'cancelled'>('all');
  
  // 2-Tap confirmation state: tracks which reservation is at "Tap 1" (waiting for Tap 2)
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmTimer, setConfirmTimer] = useState<number | null>(null);
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [revertTimer, setRevertTimer] = useState<number | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const hasInitializedDateRef = useRef(false);

  const loadReservations = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchReservations();
      setReservations(data);
      const notifs = await fetchCancellationNotifications(data);
      setCancelNotifications(notifs);
      const bDays = await fetchBusinessDaysStrict(true);
      setBusinessDays(bDays);
    } catch (err) {
      console.error('Failed to load reservations in staff mode:', err);
      setLoadError(getFriendlyFirebaseErrorMessage(err, 'load'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);

    fetchBusinessDaysStrict(false)
      .then((bDays) => {
        if (active) setBusinessDays(bDays);
      })
      .catch((err) => {
        console.warn('Failed loading business days in staff mode:', err);
        if (active) setLoadError(getFriendlyFirebaseErrorMessage(err, 'load'));
      });

    const unsubscribe = subscribeToReservations(
      (updatedReservations, updatedNotifs, newlyCancelled) => {
        if (!active) return;
        setReservations(updatedReservations);
        setCancelNotifications(updatedNotifs);
        setLoadError(null);
        setLoading(false);
        if (newlyCancelled.length > 0 && onToast) {
          const names = newlyCancelled.map(r => `${r.name} 様（${r.date}）`).join('、');
          onToast(`🚨 予約キャンセル通知：${names} の予約がキャンセルされました`);
        }
      },
      (err) => {
        if (!active) return;
        setLoadError(getFriendlyFirebaseErrorMessage(err, 'load'));
        setLoading(false);
      }
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const unreadCancelNotifications = useMemo(
    () => cancelNotifications.filter(n => !n.read),
    [cancelNotifications]
  );

  const cancelledReservations = useMemo(
    () => reservations.filter(r => r.status === 'cancelled'),
    [reservations]
  );

  // Today in JST
  const todayStr = useMemo(() => {
    const todayJst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    return `${todayJst.getFullYear()}-${String(todayJst.getMonth() + 1).padStart(2, '0')}-${String(todayJst.getDate()).padStart(2, '0')}`;
  }, []);

  // Combined available dates: all registered business days PLUS any dates with reservations
  const availableDates = useMemo(() => {
    const reservationDates = reservations.filter(r => r.status !== 'cancelled').map(r => r.date).filter(Boolean);
    const set = new Set([...businessDays, ...reservationDates]);
    return Array.from(set).sort();
  }, [businessDays, reservations]);

  // Auto-select today (or first available date) once on initial load, preserving manual selection afterward
  useEffect(() => {
    if (!hasInitializedDateRef.current && availableDates.length > 0 && selectedDate === 'all') {
      hasInitializedDateRef.current = true;
      if (availableDates.includes(todayStr)) {
        setSelectedDate(todayStr);
      } else {
        setSelectedDate(availableDates[0]);
      }
    }
  }, [availableDates, todayStr, selectedDate]);

  // Clean up auto-reset timer for 2-tap confirmation
  useEffect(() => {
    return () => {
      if (confirmTimer) clearTimeout(confirmTimer);
      if (revertTimer) clearTimeout(revertTimer);
    };
  }, [confirmTimer, revertTimer]);

  // Handle Tap 1 (Complete)
  const handleFirstTap = (resId: string) => {
    if (confirmTimer) clearTimeout(confirmTimer);
    if (revertTimer) clearTimeout(revertTimer);
    setRevertingId(null);
    setConfirmingId(resId);
    // Auto-cancel confirmation after 8 seconds of inactivity
    const timer = window.setTimeout(() => {
      setConfirmingId(prev => (prev === resId ? null : prev));
    }, 8000);
    setConfirmTimer(timer);
  };

  // Cancel confirmation
  const handleCancelTap = () => {
    if (confirmTimer) clearTimeout(confirmTimer);
    setConfirmingId(null);
  };

  // Handle Tap 2 (Confirm completion)
  const handleSecondTapConfirm = async (res: Reservation) => {
    if (confirmTimer) clearTimeout(confirmTimer);
    setConfirmingId(null);
    setUpdatingId(res.id);

    try {
      await updateReservationStatus(res.id, 'completed');
      setReservations(prev => 
        prev.map(r => r.id === res.id ? { ...r, status: 'completed', updatedAt: new Date().toISOString() } : r)
      );
      if (onToast) {
        onToast(`「${res.name} 様」のお渡し・受取完了を記録しました`);
      }
    } catch (err) {
      console.error('Failed to complete reservation:', err);
      if (onToast) onToast('受取完了の更新に失敗しました');
    } finally {
      setUpdatingId(null);
    }
  };

  // Handle Tap 1 for Revert (未受取に戻す 1タップ目)
  const handleFirstTapRevert = (resId: string) => {
    if (revertTimer) clearTimeout(revertTimer);
    if (confirmTimer) clearTimeout(confirmTimer);
    setConfirmingId(null);
    setRevertingId(resId);
    const timer = window.setTimeout(() => {
      setRevertingId(prev => (prev === resId ? null : prev));
    }, 8000);
    setRevertTimer(timer);
  };

  // Cancel Revert confirmation
  const handleCancelRevertTap = () => {
    if (revertTimer) clearTimeout(revertTimer);
    setRevertingId(null);
  };

  // Handle Tap 2 for Revert (未受取に戻す 2タップ目確定)
  const handleSecondTapRevert = async (res: Reservation) => {
    if (revertTimer) clearTimeout(revertTimer);
    setRevertingId(null);
    setUpdatingId(res.id);
    try {
      await updateReservationStatus(res.id, 'confirmed');
      setReservations(prev => 
        prev.map(r => r.id === res.id ? { ...r, status: 'confirmed', updatedAt: new Date().toISOString() } : r)
      );
      if (onToast) {
        onToast(`「${res.name} 様」を未受取（予約確定）に戻しました`);
      }
    } catch (err) {
      console.error('Failed to revert status:', err);
      if (onToast) onToast('ステータスの更新に失敗しました');
    } finally {
      setUpdatingId(null);
    }
  };

  // Filtered reservations
  const filteredReservations = useMemo(() => {
    return reservations.filter(res => {
      if (statusFilter === 'cancelled') {
        if (res.status !== 'cancelled') return false;
      } else {
        if (res.status === 'cancelled') return false;
        if (statusFilter === 'pending' && res.status === 'completed') return false;
        if (statusFilter === 'completed' && res.status !== 'completed') return false;
      }

      // Date filter
      if (selectedDate !== 'all' && res.date !== selectedDate) return false;

      return true;
    }).sort((a, b) => {
      // Sort by date, then time, uncompleted first
      if (a.status === 'completed' && b.status !== 'completed') return 1;
      if (a.status !== 'completed' && b.status === 'completed') return -1;
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.time.localeCompare(b.time);
    });
  }, [reservations, selectedDate, statusFilter]);

  // Daily Cake Summary: strictly "on that day, which cake has how many reservations"
  const dailyCakeSummaries = useMemo(() => {
    const active = reservations.filter(r => r.status !== 'cancelled');
    const targetDates = selectedDate === 'all'
      ? Array.from(new Set(active.map(r => r.date).filter(Boolean))).sort()
      : [selectedDate];

    return targetDates.map(dateStr => {
      const forDate = active.filter(r => r.date === dateStr);
      const cakeMap: Record<string, { name: string; quantity: number }> = {};

      forDate.forEach(res => {
        (res.items || []).forEach(item => {
          if (!cakeMap[item.cakeName]) {
            cakeMap[item.cakeName] = { name: item.cakeName, quantity: 0 };
          }
          cakeMap[item.cakeName].quantity += item.quantity;
        });
      });

      const cakes = Object.values(cakeMap).sort((a, b) => b.quantity - a.quantity);
      return {
        date: dateStr,
        cakes
      };
    }).filter(group => group.cakes.length > 0);
  }, [reservations, selectedDate]);

  // Status counts for current date filter scope
  const statusCounts = useMemo(() => {
    const base = selectedDate === 'all'
      ? reservations
      : reservations.filter(r => r.date === selectedDate);

    const allActive = base.filter(r => r.status !== 'cancelled').length;
    const pending = base.filter(r => r.status !== 'completed' && r.status !== 'cancelled').length;
    const completed = base.filter(r => r.status === 'completed').length;
    const cancelled = base.filter(r => r.status === 'cancelled').length;

    return { allActive, pending, completed, cancelled, total: base.length };
  }, [reservations, selectedDate]);

  return (
    <div id="staff-pickup-mode-view" className="max-w-4xl mx-auto space-y-5 pb-16">
      {/* Top Banner & Exit Button */}
      <div className="bg-gradient-to-r from-stone-900 via-stone-800 to-stone-900 text-white p-4 sm:p-6 rounded-2xl sm:rounded-3xl shadow-lg border border-stone-700 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
        <div>
          <div className="flex items-center flex-wrap gap-2 mb-1">
            <span className="bg-amber-400/20 text-amber-300 border border-amber-400/40 text-[10px] sm:text-xs font-mono font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider whitespace-nowrap">
              スタッフ専用コード：hpy001
            </span>
            {unreadCancelNotifications.length > 0 && (
              <span className="bg-red-600 text-white text-[10px] sm:text-xs font-bold px-2.5 py-0.5 rounded-full flex items-center gap-1 whitespace-nowrap">
                <Bell className="w-3 h-3" />
                未確認キャンセル通知：{unreadCancelNotifications.length}件
              </span>
            )}
          </div>
          <h1 className="text-base sm:text-2xl font-bold font-serif text-white tracking-tight">
            <span className="inline-block">スタッフ専用</span>{' '}
            <span className="inline-block">予約情報まとめ・受取確認画面</span>
          </h1>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-center shrink-0">
          <button
            onClick={loadReservations}
            disabled={loading}
            className="px-3 py-2 bg-stone-700/80 hover:bg-stone-700 text-stone-200 rounded-xl text-xs flex items-center gap-1.5 transition-all active:scale-95 whitespace-nowrap"
            title="最新データに更新"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">更新</span>
          </button>
          <button
            onClick={onExit}
            className="px-3.5 sm:px-4 py-2 bg-white text-stone-900 hover:bg-stone-100 font-bold rounded-xl text-xs flex items-center gap-1.5 transition-all shadow-md active:scale-95 whitespace-nowrap"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>通常画面に戻る</span>
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
            onClick={loadReservations}
            className="px-3.5 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-xl transition-colors whitespace-nowrap self-end sm:self-center cursor-pointer"
          >
            再読み込み
          </button>
        </div>
      )}

      {/* Staff Cancellation Notification Alert Banner */}
      {unreadCancelNotifications.length > 0 && (
        <div
          id="staff-cancellation-notification-banner"
          className="bg-red-50 border-2 border-red-500 rounded-2xl p-4 sm:p-5 shadow-md space-y-3"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-red-200 pb-2.5">
            <div className="flex items-center gap-2 text-red-700 font-bold text-sm sm:text-base">
              <Bell className="w-5 h-5 text-red-600 shrink-0" />
              <span>🚨 予約キャンセル通知（未確認 {unreadCancelNotifications.length} 件）</span>
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
                      <span>【キャンセル】{notif.customerName} 様</span>
                      <span className="text-xs font-mono bg-red-100 text-red-800 px-2 py-0.5 rounded">
                        受取予定：{notif.date} {notif.time}
                      </span>
                      {timeStr && (
                        <span className="text-[11px] text-red-500 font-mono">
                          （キャンセル日時: {timeStr}）
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-red-600 font-semibold">
                      対象ケーキ：{notif.itemsSummary}
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

      {/* Panel 1: Scalable Date & Business Days Selection */}
      <div className="bg-white border border-stone-300 rounded-2xl p-4 sm:p-5 shadow-xs space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2.5 border-b border-stone-200">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-amber-500/10 text-amber-700 flex items-center justify-center shrink-0">
              <CalendarDays className="w-4 h-4 text-amber-600" />
            </div>
            <div>
              <h2 className="text-xs sm:text-sm font-bold text-stone-900 flex flex-wrap items-center gap-1.5">
                <span>受取日・営業日を選択</span>
                <span className="text-[11px] text-emerald-700 font-semibold bg-emerald-50 border border-emerald-200 px-2 py-0.2 rounded-full">
                  営業日自動連動中 ({businessDays.length}日設定済)
                </span>
              </h2>
              <p className="text-[11px] text-stone-500 mt-0.5">
                営業日設定および予約が入っているすべての日程を表示・即座に切替できます。
              </p>
            </div>
          </div>

          {/* Quick Controls: All Dates / Today / Direct Date Jump Dropdown */}
          <div className="flex items-center gap-2 flex-wrap self-start sm:self-auto shrink-0">
            <button
              type="button"
              onClick={() => setSelectedDate('all')}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer border ${
                selectedDate === 'all'
                  ? 'bg-stone-900 text-white border-stone-900 shadow-xs'
                  : 'bg-stone-100 hover:bg-stone-200 text-stone-700 border-stone-200'
              }`}
            >
              全日程表示
            </button>

            {availableDates.includes(todayStr) && (
              <button
                type="button"
                onClick={() => setSelectedDate(todayStr)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1 border ${
                  selectedDate === todayStr
                    ? 'bg-amber-600 text-white border-amber-600 shadow-xs'
                    : 'bg-amber-50 hover:bg-amber-100 text-amber-900 border-amber-300'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
                <span>本日の営業日</span>
              </button>
            )}

            {/* Scalable Date Selector Dropdown for future growth */}
            <div className="relative">
              <select
                id="staff-date-selector-dropdown"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="appearance-none pl-3 pr-7 py-1.5 bg-stone-50 hover:bg-stone-100 border border-stone-300 rounded-xl text-xs font-bold text-stone-800 cursor-pointer focus:outline-none focus:ring-2 focus:ring-amber-500 shadow-2xs"
                title="受取日を一覧から選択"
              >
                <option value="all">日付一覧から選択（全{availableDates.length}日程）...</option>
                {availableDates.map(d => {
                  const count = reservations.filter(r => r.status !== 'cancelled' && r.date === d).length;
                  const dayOfWeek = getJapaneseDayOfWeek(d);
                  const isToday = d === todayStr;
                  const isBusi = businessDays.includes(d);
                  return (
                    <option key={d} value={d}>
                      {d} ({dayOfWeek}) {isToday ? '【本日】' : ''} - 予約{count}件 {isBusi ? '[営業日]' : ''}
                    </option>
                  );
                })}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-500" />
            </div>
          </div>
        </div>

        {/* Scrollable Date Chips Track */}
        <div className="relative">
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1 pt-0.5">
            {availableDates.length === 0 ? (
              <span className="text-xs text-stone-400 py-1">設定された営業日または予約日はありません</span>
            ) : (
              availableDates.map(d => {
                const isSelected = selectedDate === d;
                const isToday = d === todayStr;
                const isBusi = businessDays.includes(d);
                const count = reservations.filter(r => r.status !== 'cancelled' && r.date === d).length;
                const dayOfWeek = getJapaneseDayOfWeek(d);
                const isWeekend = dayOfWeek === '土' || dayOfWeek === '日';

                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setSelectedDate(d)}
                    className={`px-3 py-2 rounded-xl text-xs font-bold transition-all shrink-0 flex flex-col items-center min-w-[80px] cursor-pointer border ${
                      isSelected
                        ? 'bg-amber-600 text-white border-amber-600 shadow-sm scale-102 ring-2 ring-amber-300'
                        : isToday
                        ? 'bg-amber-50 text-amber-950 border-amber-300 hover:bg-amber-100 font-extrabold'
                        : 'bg-stone-50 text-stone-700 border-stone-200 hover:bg-stone-100 hover:border-stone-300'
                    }`}
                  >
                    <div className="flex items-center gap-1">
                      <span className={isSelected ? 'text-white' : isWeekend ? 'text-red-600' : 'text-stone-800'}>
                        {d.slice(5)}
                      </span>
                      <span className={`text-[10px] ${isSelected ? 'text-amber-200' : 'text-stone-400'}`}>
                        ({dayOfWeek})
                      </span>
                    </div>
                    <div className="flex items-center gap-1 mt-1">
                      <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full font-bold ${
                        isSelected
                          ? 'bg-amber-800 text-white'
                          : count > 0
                          ? 'bg-stone-200 text-stone-800'
                          : 'bg-stone-100 text-stone-400'
                      }`}>
                        {count}件
                      </span>
                      {isToday ? (
                        <span className={`text-[9px] px-1 py-0.2 rounded font-bold ${
                          isSelected ? 'bg-white text-amber-800' : 'bg-amber-500 text-white'
                        }`}>
                          本日
                        </span>
                      ) : isBusi ? (
                        <span className={`text-[9px] px-1 py-0.2 rounded font-bold ${
                          isSelected ? 'bg-amber-700 text-amber-100' : 'bg-emerald-100 text-emerald-800'
                        }`}>
                          営業
                        </span>
                      ) : null}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Panel 2: Status Filter Tabs (Clean, Independent, High Contrast, No Overlap!) */}
      <div className="bg-white border border-stone-300 rounded-2xl p-3.5 sm:p-4 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        {/* Active Scope Label */}
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-amber-500 shrink-0"></div>
          <span className="text-xs sm:text-sm font-bold text-stone-800 font-serif">
            {selectedDate === 'all' ? (
              <span>全日程の予約一覧を表示中</span>
            ) : (
              <span>
                <strong>{selectedDate} ({getJapaneseDayOfWeek(selectedDate)})</strong> の予約一覧を表示中
              </span>
            )}
          </span>
          {selectedDate !== 'all' && businessDays.includes(selectedDate) && (
            <span className="text-[10px] bg-emerald-100 text-emerald-800 border border-emerald-300 px-2 py-0.2 rounded-full font-bold">
              店舗営業日
            </span>
          )}
        </div>

        {/* Status Buttons with Clear Counts */}
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          <button
            type="button"
            onClick={() => setStatusFilter('all')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer border ${
              statusFilter === 'all'
                ? 'bg-stone-900 text-white border-stone-900 shadow-xs'
                : 'bg-stone-50 hover:bg-stone-100 text-stone-700 border-stone-200'
            }`}
          >
            <span>全員</span>
            <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-bold ${
              statusFilter === 'all' ? 'bg-stone-700 text-amber-300' : 'bg-stone-200 text-stone-700'
            }`}>
              {statusCounts.allActive}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setStatusFilter('pending')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer border ${
              statusFilter === 'pending'
                ? 'bg-amber-600 text-white border-amber-600 shadow-xs ring-1 ring-amber-400'
                : 'bg-amber-50/70 hover:bg-amber-100 text-amber-900 border-amber-200'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            <span>未受取のみ</span>
            <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-bold ${
              statusFilter === 'pending' ? 'bg-amber-800 text-white' : 'bg-amber-200 text-amber-900'
            }`}>
              {statusCounts.pending}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setStatusFilter('completed')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer border ${
              statusFilter === 'completed'
                ? 'bg-emerald-700 text-white border-emerald-700 shadow-xs ring-1 ring-emerald-400'
                : 'bg-emerald-50/70 hover:bg-emerald-100 text-emerald-900 border-emerald-200'
            }`}
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>受取完了済</span>
            <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-bold ${
              statusFilter === 'completed' ? 'bg-emerald-900 text-white' : 'bg-emerald-200 text-emerald-900'
            }`}>
              {statusCounts.completed}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setStatusFilter('cancelled')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer border ${
              statusFilter === 'cancelled'
                ? 'bg-red-600 text-white border-red-600 shadow-xs ring-1 ring-red-400'
                : 'bg-red-50 hover:bg-red-100 text-red-700 border-red-200'
            }`}
          >
            <AlertCircle className="w-3.5 h-3.5" />
            <span>キャンセル済</span>
            <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono font-bold ${
              statusFilter === 'cancelled' ? 'bg-red-800 text-white' : 'bg-red-200 text-red-800'
            }`}>
              {statusCounts.cancelled}
            </span>
          </button>
        </div>
      </div>

      {/* 予約情報まとめ: その日に何のケーキが何個予約が入っているかのみを表示 */}
      <div className="bg-white border border-stone-200 rounded-2xl p-4 sm:p-5 shadow-xs space-y-4">
        <div className="border-b border-stone-100 pb-2.5">
          <h2 className="text-sm sm:text-base font-bold text-stone-900 font-serif flex items-center gap-2">
            <ShoppingBag className="w-4 h-4 text-amber-600" />
            <span>予約情報まとめ</span>
          </h2>
        </div>

        {dailyCakeSummaries.length === 0 ? (
          <p className="text-xs text-stone-400 py-2">該当日のケーキ予約はありません</p>
        ) : (
          <div className="space-y-4">
            {dailyCakeSummaries.map(group => (
              <div key={group.date} className="bg-stone-50 rounded-xl p-3.5 border border-stone-200/80 space-y-2">
                <div className="text-xs font-bold text-stone-800 flex items-center gap-1.5 border-b border-stone-200/70 pb-1.5">
                  <Calendar className="w-3.5 h-3.5 text-amber-600" />
                  <span>{group.date}</span>
                </div>
                <div className="divide-y divide-stone-200/70">
                  {group.cakes.map(c => (
                    <div key={c.name} className="py-2 flex items-center justify-between text-xs sm:text-sm">
                      <span className="font-medium text-stone-800 pr-2">{c.name}</span>
                      <strong className="text-stone-900 font-mono text-sm shrink-0">
                        {c.quantity}個
                      </strong>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Reservation Cards List (No Phone, No ID) with Alternating Backgrounds & Visual Dividers */}
      <div className="bg-white border border-stone-300 rounded-2xl shadow-xs overflow-hidden">
        <div className="px-4 py-3 sm:px-5 sm:py-3.5 bg-stone-100/90 border-b border-stone-300 flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-sm sm:text-base font-bold text-stone-900 font-serif flex items-center gap-2">
            <Calendar className="w-4 h-4 text-amber-600 shrink-0" />
            <span>
              {selectedDate === 'all'
                ? '予約詳細リスト（すべての日程）'
                : `${selectedDate} の予約詳細リスト`}
            </span>
          </h2>
          <span className="text-xs font-mono font-bold bg-white text-stone-800 border border-stone-300 px-2.5 py-0.5 rounded-full">
            {filteredReservations.length}件表示
          </span>
        </div>

        {loading ? (
          <div className="p-12 text-center">
            <RefreshCw className="w-8 h-8 text-amber-600 animate-spin mx-auto mb-2" />
            <p className="text-xs text-stone-500">予約一覧を読み込んでいます...</p>
          </div>
        ) : filteredReservations.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <AlertCircle className="w-8 h-8 text-amber-500/70 mx-auto" />
            <p className="text-sm font-bold text-stone-800">
              {selectedDate !== 'all' && businessDays.includes(selectedDate)
                ? `${selectedDate} は営業日に設定されていますが、現在の予約は0件です`
                : '該当する予約は見つかりません'}
            </p>
            <p className="text-xs text-stone-500">
              {statusFilter !== 'all' 
                ? '「全員」タブを選択すると他のステータスの予約を確認できます' 
                : 'お客様から新しい予約が入るとリアルタイムに自動反映されます'}
            </p>
          </div>
        ) : (
          <div className="divide-y-2 divide-stone-300">
            {filteredReservations.map((res, cardIdx) => {
              const isCompleted = res.status === 'completed';
              const isCancelled = res.status === 'cancelled';
              const isConfirming = confirmingId === res.id;
              const isReverting = revertingId === res.id;
              const isUpdating = updatingId === res.id;
              const isEven = cardIdx % 2 === 0;

              return (
                <motion.div
                  key={res.id}
                  id={`staff-card-${res.id}`}
                  layout
                  className={`p-4 sm:p-5 transition-all ${
                    isCancelled
                      ? 'bg-red-50/90 text-red-700'
                      : isCompleted
                      ? isReverting
                        ? 'bg-amber-50/90 ring-2 ring-inset ring-amber-400/50'
                        : isEven
                        ? 'bg-emerald-50/35 opacity-90'
                        : 'bg-emerald-50/65 opacity-90'
                      : isConfirming
                      ? 'bg-amber-50/90 ring-2 ring-inset ring-amber-400/50'
                      : isEven
                      ? 'bg-white hover:bg-stone-50/60'
                      : 'bg-[#F5F2EB] hover:bg-[#EFECE2]'
                  }`}
                >
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    {/* Left: Customer Name, Pickup Date & Time, Cake Items */}
                    <div className="space-y-2.5 flex-grow">
                      {/* Customer Header (No ID) */}
                      <div className="flex items-center flex-wrap gap-2 pb-2 border-b border-stone-200/80">
                        <span className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded-md ${
                          isCancelled
                            ? 'bg-red-600 text-white'
                            : isEven
                            ? 'bg-stone-800 text-white'
                            : 'bg-amber-800 text-white'
                        }`}>
                          #{cardIdx + 1}
                        </span>
                        <h3 className={`text-lg sm:text-xl font-bold font-serif flex items-center gap-1.5 ${isCancelled ? 'text-red-700' : 'text-stone-900'}`}>
                          <span>{res.name}</span>
                          <span className={`text-sm font-normal ${isCancelled ? 'text-red-600' : 'text-stone-500'}`}>様</span>
                        </h3>
                        {res.nameKana && (
                          <span className={`text-xs font-mono px-2 py-0.5 rounded-md border ${
                            isCancelled
                              ? 'bg-red-100 text-red-700 border-red-200 font-bold'
                              : 'text-stone-600 bg-white border-stone-200'
                          }`}>
                            {res.nameKana}
                          </span>
                        )}
                        {isCancelled && (
                          <span className="bg-red-600 text-white text-xs font-bold px-2.5 py-0.5 rounded-full">
                            キャンセル済
                          </span>
                        )}
                      </div>

                      {/* Pickup Date & Time Tag (No Phone Number) */}
                      <div className="flex items-center flex-wrap gap-2">
                        <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-semibold text-xs sm:text-sm border ${
                          isCancelled
                            ? 'bg-red-100/80 border-red-300 text-red-700'
                            : 'bg-amber-50 border-amber-200/90 text-amber-900'
                        }`}>
                          <Calendar className={`w-3.5 h-3.5 shrink-0 ${isCancelled ? 'text-red-600' : 'text-amber-600'}`} />
                          <span>受取日：<strong>{res.date}</strong></span>
                        </div>
                        <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-semibold text-xs sm:text-sm border ${
                          isCancelled
                            ? 'bg-red-100/80 border-red-300 text-red-700'
                            : 'bg-amber-50 border-amber-200/90 text-amber-900'
                        }`}>
                          <Clock className={`w-3.5 h-3.5 shrink-0 ${isCancelled ? 'text-red-600' : 'text-amber-600'}`} />
                          <span>受取時間：<strong className={isCancelled ? 'text-red-800' : 'text-amber-800'}>{res.time}</strong></span>
                        </div>
                      </div>

                      {/* Cake Items List (予約したケーキの種類・個数) with Row Dividers */}
                      <div className={`rounded-xl overflow-hidden mt-2 border ${
                        isCancelled
                          ? 'bg-white/90 border-red-200 text-red-700'
                          : isEven
                          ? 'bg-stone-50/90 border-stone-200/90'
                          : 'bg-white border-stone-300/90'
                      }`}>
                        <div className="divide-y divide-stone-200/80">
                          {res.items.map((item, idx) => (
                            <div key={idx} className="px-3 py-2 flex items-center justify-between text-xs sm:text-sm">
                              <span className={`font-medium flex items-center gap-1.5 ${isCancelled ? 'text-red-700 font-bold' : 'text-stone-800'}`}>
                                <span>{item.cakeName}</span>
                              </span>
                              <span className={`font-bold px-2 py-0.5 rounded-md font-mono text-xs border ${
                                isCancelled
                                  ? 'text-red-700 bg-red-50 border-red-300'
                                  : 'text-stone-900 bg-amber-50/70 border-amber-200/90'
                              }`}>
                                {item.quantity}個
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Right: 2-Tap Confirmation Mechanism */}
                    <div className="shrink-0 flex flex-col items-stretch sm:items-end justify-center pt-2 md:pt-0 border-t md:border-t-0 border-stone-200/80">
                      {isCancelled ? (
                        <div className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 bg-red-600 text-white rounded-xl font-bold text-xs sm:text-sm shadow-xs">
                          <AlertCircle className="w-4 h-4 text-white" />
                          <span>予約キャンセル済</span>
                        </div>
                      ) : isCompleted ? (
                        isReverting ? (
                          /* Revert State 1: WAITING FOR 2ND TAP TO REVERT */
                          <div className="space-y-2 w-full sm:w-auto">
                            <div className="bg-amber-100 border border-amber-300 text-amber-900 text-[11px] font-bold px-2.5 py-1 rounded-lg text-center animate-pulse">
                              ⚠️ 【2タップ目】未受取に戻す場合は確定を押してください
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                id={`staff-revert-tap2-btn-${res.id}`}
                                onClick={() => handleSecondTapRevert(res)}
                                disabled={isUpdating}
                                className="flex-1 sm:flex-initial px-4 py-2.5 bg-amber-600 hover:bg-amber-700 active:scale-95 text-white font-bold text-xs sm:text-sm rounded-xl transition-all shadow-md flex items-center justify-center gap-1.5 ring-2 ring-amber-400"
                              >
                                <Undo2 className="w-4 h-4 text-white" />
                                <span>確定する（未受取に戻す）</span>
                              </button>
                              <button
                                onClick={handleCancelRevertTap}
                                className="px-3 py-2.5 bg-stone-200 hover:bg-stone-300 text-stone-700 rounded-xl text-xs font-semibold transition-all"
                                title="キャンセル"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        ) : (
                          /* Revert State 0: COMPLETED, 1ST TAP TO REVERT */
                          <div className="space-y-2 text-right">
                            <div className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-emerald-100 text-emerald-900 border border-emerald-300 rounded-xl font-bold text-xs sm:text-sm">
                              <CheckCircle2 className="w-4 h-4 text-emerald-700" />
                              <span>受取完了済</span>
                            </div>
                            <div>
                              <button
                                id={`staff-revert-tap1-btn-${res.id}`}
                                onClick={() => handleFirstTapRevert(res.id)}
                                disabled={isUpdating}
                                className="inline-flex items-center gap-1 text-[11px] text-stone-500 hover:text-stone-800 bg-white border border-stone-200 hover:border-stone-300 px-2.5 py-1 rounded-lg transition-colors"
                                title="2タップで未受取に戻せます"
                              >
                                <Undo2 className="w-3 h-3" />
                                <span>1タップ目：未受取に戻す</span>
                              </button>
                            </div>
                          </div>
                        )
                      ) : isConfirming ? (
                        /* State 1: WAITING FOR 2ND TAP */
                        <div className="space-y-2 w-full sm:w-auto">
                          <div className="bg-amber-100 border border-amber-300 text-amber-900 text-[11px] font-bold px-2.5 py-1 rounded-lg text-center animate-pulse">
                            ⚠️ 【2タップ目】確定ボタンを押してください
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              id={`staff-tap2-btn-${res.id}`}
                              onClick={() => handleSecondTapConfirm(res)}
                              disabled={isUpdating}
                              className="flex-1 sm:flex-initial px-4 py-3 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-bold text-xs sm:text-sm rounded-xl transition-all shadow-md flex items-center justify-center gap-1.5 ring-2 ring-emerald-400"
                            >
                              <Check className="w-4 h-4 text-white" />
                              <span>確定する（タップで完了）</span>
                            </button>
                            <button
                              onClick={handleCancelTap}
                              className="px-3 py-3 bg-stone-200 hover:bg-stone-300 text-stone-700 rounded-xl text-xs font-semibold transition-all"
                              title="キャンセル"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      ) : (
                        /* State 0: INITIAL 1ST TAP BUTTON */
                        <button
                          id={`staff-tap1-btn-${res.id}`}
                          onClick={() => handleFirstTap(res.id)}
                          disabled={isUpdating}
                          className="w-full sm:w-auto px-5 py-3 bg-stone-900 hover:bg-black active:scale-95 text-white font-bold text-xs sm:text-sm rounded-xl transition-all shadow-md flex items-center justify-center gap-2 border border-stone-700 group"
                        >
                          <ShoppingBag className="w-4 h-4 text-amber-400 group-hover:scale-110 transition-transform" />
                          <span>1タップ目：受取完了にする</span>
                        </button>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
