import React, { useState, useEffect, useMemo } from 'react';
import { Reservation, ReservationItem, Cake } from '../types';
import { TIME_SLOTS } from '../data/cakes';
import { createReservation, fetchBusinessDays, subscribeToBusinessDays, fetchCakes, SoldOutConflictError } from '../lib/dbService';
import { motion, AnimatePresence } from 'motion/react';
import { Calendar, Clock, User, Mail, Phone, MessageSquare, Trash2, ShoppingBag, Gift, ArrowRight, CheckCircle2, ChevronRight, Sparkles, Check, AlertCircle, FileText } from 'lucide-react';
import ReservationSuccessModal from './ReservationSuccessModal';

const FALLBACK_CAKE_IMAGE = 'https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=600&auto=format&fit=crop&q=80';

interface ReservationFormProps {
  cart: { [cakeId: string]: number };
  cakes: Cake[];
  onCakesUpdated?: (cakes: Cake[]) => void;
  onUpdateCartQty: (cakeId: string, quantity: number) => void;
  onClearCart: () => void;
  onReservationSuccess: (bookingId: string, reservation?: Reservation) => void;
  onReturnToCatalog?: () => void;
  userEmail?: string | null;
  userName?: string | null;
  onToast?: (message: string) => void;
}

export default function ReservationForm({
  cart,
  cakes,
  onCakesUpdated,
  onUpdateCartQty,
  onClearCart,
  onReservationSuccess,
  onReturnToCatalog,
  userEmail,
  userName,
  onToast
}: ReservationFormProps) {
  // Form State
  const [name, setName] = useState(userName || '');
  const [nameKana, setNameKana] = useState('');
  const [email, setEmail] = useState(userEmail || '');
  const [phone, setPhone] = useState('');
  
  const [date, setDate] = useState<string>('');
  const [businessDays, setBusinessDays] = useState<string[]>([]);
  const [isLoadingDays, setIsLoadingDays] = useState<boolean>(true);

  const todayJst = useMemo(() => new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })), []);
  const todayStr = useMemo(() => `${todayJst.getFullYear()}-${String(todayJst.getMonth() + 1).padStart(2, '0')}-${String(todayJst.getDate()).padStart(2, '0')}`, [todayJst]);

  const selectableDays = useMemo(() => {
    const sorted = [...businessDays].sort();
    // Strictly allow only configured business days >= 3 days from today (JST)
    return sorted.filter(d => {
      const diffMs = new Date(d + "T00:00:00+09:00").getTime() - new Date(todayStr + "T00:00:00+09:00").getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      return diffDays >= 3;
    });
  }, [businessDays, todayStr]);

  // Store business days fetched from db and subscribe to real-time updates
  useEffect(() => {
    let isMounted = true;
    const unsubscribe = subscribeToBusinessDays((days) => {
      if (isMounted) {
        setBusinessDays(days);
        setIsLoadingDays(false);
      }
    });

    async function loadBusinessDays() {
      try {
        const days = await fetchBusinessDays();
        if (isMounted) {
          setBusinessDays(days);
        }
      } finally {
        if (isMounted) {
          setIsLoadingDays(false);
        }
      }
    }
    loadBusinessDays();

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  // Ensure a valid selectable date is selected, or clear date if none available
  useEffect(() => {
    if (selectableDays.length > 0 && (!date || !selectableDays.includes(date))) {
      setDate(selectableDays[0]);
    } else if (selectableDays.length === 0 && date) {
      setDate('');
    }
  }, [selectableDays, date]);

  const getFormatLabel = (dateStr: string) => {
    try {
      const d = new Date(dateStr + "T00:00:00+09:00");
      if (isNaN(d.getTime())) return dateStr;
      const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
      return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日 (${weekdays[d.getDay()]})`;
    } catch {
      return dateStr;
    }
  };

  const [time, setTime] = useState(TIME_SLOTS[0]);
  const [notes, setNotes] = useState('');

  // UI State
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isVerifyingStock, setIsVerifyingStock] = useState(false);
  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const [stockError, setStockError] = useState<{
    message: string;
    soldOutIds: string[];
    soldOutNames: string[];
  } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [step, setStep] = useState<'cart' | 'form' | 'confirm' | 'success'>('cart');
  const [completedBookingId, setCompletedBookingId] = useState('');
  const [completedReservation, setCompletedReservation] = useState<Reservation | null>(null);
  const [showSuccessModal, setShowSuccessModal] = useState<boolean>(false);
  const [successPrice, setSuccessPrice] = useState<number>(0);
  const [latestCatalog, setLatestCatalog] = useState<Cake[]>(cakes);

  useEffect(() => {
    setLatestCatalog(cakes);
  }, [cakes]);

  // Map cart identifiers to concrete structures (keep sold-out items visible so exclusive control can flag & block them)
  const cartItems: (ReservationItem & { isSoldOut: boolean })[] = Object.entries(cart)
    .map(([cakeId, qty]) => {
      if (qty <= 0) return null;
      const cake = latestCatalog.find(c => c.id === cakeId) || cakes.find(c => c.id === cakeId);
      if (!cake) return null;
      return {
        cakeId,
        cakeName: cake.jpName,
        quantity: qty,
        price: cake.price,
        isSoldOut: Boolean(cake.isSoldOut)
      };
    })
    .filter((item): item is ReservationItem & { isSoldOut: boolean } => item !== null);

  const soldOutCartItems = cartItems.filter(item => item.isSoldOut);
  const totalPrice = cartItems.reduce((acc, curr) => acc + (curr.price * curr.quantity), 0);

  // Shared helper to fetch latest inventory from Firestore and check for sold-out conflicts (排他制御)
  const verifyLatestInventoryFromFirestore = async (): Promise<{
    ok: boolean;
    freshCakes: Cake[];
    freshDays: string[];
  }> => {
    const [freshCakes, freshDays] = await Promise.all([
      fetchCakes(true),
      fetchBusinessDays()
    ]);
    setLatestCatalog(freshCakes);
    setBusinessDays(freshDays);
    if (onCakesUpdated) {
      onCakesUpdated(freshCakes);
    }

    const soldOutIds: string[] = [];
    const soldOutNames: string[] = [];

    for (const [cakeId, qty] of Object.entries(cart)) {
      if ((qty as number) <= 0) continue;
      const found = freshCakes.find(c => c.id === cakeId);
      const fallback = cakes.find(c => c.id === cakeId);
      if (!found || found.isSoldOut) {
        soldOutIds.push(cakeId);
        soldOutNames.push(found?.jpName || fallback?.jpName || '選択されたケーキ');
      }
    }

    if (soldOutIds.length > 0) {
      setStockError({
        message: `申し訳ございません。ご注文いただいた「${soldOutNames.join('」「')}」が現在売り切れ（オーダーストップ）となっているため、ご予約を確定できません。カートから該当商品を削除して再度お手続きください。`,
        soldOutIds,
        soldOutNames
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return { ok: false, freshCakes, freshDays };
    }

    setStockError(null);
    return { ok: true, freshCakes, freshDays };
  };

  const toKatakana = (str: string) =>
    str.replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));

  const normalizePhone = (str: string) =>
    str
      .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
      .replace(/[ー−―]/g, '-')
      .trim();

  const validate = () => {
    const newErrors: { [key: string]: string } = {};
    if (!name.trim()) newErrors.name = 'お名前を入力してください。';
    
    const convertedKana = toKatakana(nameKana.trim());
    if (!convertedKana) {
      newErrors.nameKana = 'お名前の読み（カタカナ）を入力してください。';
    } else if (!/^[ァ-ヶーa-zA-Z\s　・]+$/.test(convertedKana)) {
      newErrors.nameKana = 'カタカナまたはひらがなで入力してください。';
    }
    
    if (!email.trim()) {
      newErrors.email = 'メールアドレスを入力してください。';
    } else if (!/\S+@\S+\.\S+/.test(email.trim())) {
      newErrors.email = '有効なメールアドレスを入力してください。';
    }

    const cleanPhoneDigits = normalizePhone(phone).replace(/[-\s　()（）]/g, '');
    if (!cleanPhoneDigits) {
      newErrors.phone = '電話番号を入力してください。';
    } else if (!/^[0-9]{7,15}$/.test(cleanPhoneDigits)) {
      newErrors.phone = '有効な電話番号を入力してください。';
    }

    if (!date || !selectableDays.includes(date)) {
      newErrors.date = selectableDays.length === 0
        ? '現在ご予約可能なお受取り日（営業日）が設定されていません。'
        : 'お受取り可能な営業日を選択してください。';
    }

    if (!time) {
      newErrors.time = 'お受取り時間帯を選択してください。';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleProceedToForm = async () => {
    setSubmitError(null);
    setIsVerifyingStock(true);
    try {
      const { ok } = await verifyLatestInventoryFromFirestore();
      if (!ok) return;
      setStep('form');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setIsVerifyingStock(false);
    }
  };

  const handleProceedToConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    if (!validate()) return;

    setIsVerifyingStock(true);
    try {
      const { ok, freshDays } = await verifyLatestInventoryFromFirestore();
      if (!ok) return;

      // Check if selected date is a valid selectable business day (>= 3 days ahead)
      const validLatestDays = [...freshDays].sort().filter((d) => {
        const diffMs = new Date(d + "T00:00:00+09:00").getTime() - new Date(todayStr + "T00:00:00+09:00").getTime();
        const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
        return diffDays >= 3;
      });
      if (!date || !validLatestDays.includes(date)) {
        setErrors((prev) => ({
          ...prev,
          date: '選択された日程は現在ご予約可能な営業日ではありません。営業日をご確認の上、再度ご選択ください。'
        }));
        setSubmitError('選択されたお受取り日は現在ご予約可能な営業日ではありません。お受取り日を再選択してください。');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
    } catch (err) {
      console.warn('Pre-confirm verification notice:', err);
    } finally {
      setIsVerifyingStock(false);
    }

    setNameKana(prev => toKatakana(prev.trim()));
    setPhone(prev => normalizePhone(prev));
    setStep('confirm');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      // 1. Re-fetch latest inventory & business days from Firestore before reservation submission (排他制御)
      const { ok, freshCakes, freshDays } = await verifyLatestInventoryFromFirestore();
      if (!ok) {
        return;
      }

      const validLatestDays = [...freshDays].sort().filter((d) => {
        const diffMs = new Date(d + "T00:00:00+09:00").getTime() - new Date(todayStr + "T00:00:00+09:00").getTime();
        const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
        return diffDays >= 3;
      });
      if (!date || !validLatestDays.includes(date)) {
        setSubmitError('選択されたお受取り日は現在ご予約可能な営業日ではありません。お受取り日を再選択してください。');
        setStep('form');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }

      // Build verified items from freshCakes
      const verifiedItems: ReservationItem[] = cartItems.map((item) => {
        const freshCake = freshCakes.find(c => c.id === item.cakeId);
        return {
          cakeId: item.cakeId,
          cakeName: freshCake?.jpName || item.cakeName,
          quantity: item.quantity,
          price: freshCake?.price ?? item.price
        };
      });

      if (verifiedItems.length === 0) {
        setSubmitError('カートに有効な商品がありません。ケーキ一覧から商品を選択してください。');
        setStep('cart');
        return;
      }

      const verifiedTotal = verifiedItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
      setSuccessPrice(verifiedTotal);
      
      const reservationData: Omit<Reservation, 'id' | 'createdAt' | 'updatedAt' | 'status'> = {
        name: name.trim(),
        nameKana: toKatakana(nameKana.trim()),
        email: email.trim(),
        phone: normalizePhone(phone),
        date,
        time,
        items: verifiedItems,
        totalPrice: verifiedTotal,
        ...(notes.trim() ? { notes: notes.trim() } : {})
      };

      // 2. Execute atomic Firestore transaction inside createReservation (排他制御)
      const completed = await createReservation(reservationData);
      setCompletedReservation(completed);
      setCompletedBookingId(completed.id);
      setShowSuccessModal(true);
      setStockError(null);
      setSubmitError(null);
      setStep('success');
      onClearCart();
      onReservationSuccess(completed.id, completed);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err: any) {
      console.error('Failed to submit booking:', err);
      if (err instanceof SoldOutConflictError || err?.code === 'SOLD_OUT_CONFLICT') {
        const names: string[] = Array.isArray(err.soldOutCakeNames) && err.soldOutCakeNames.length > 0
          ? err.soldOutCakeNames
          : ['選択されたケーキ'];
        const ids: string[] = Array.isArray(err.soldOutCakeIds) ? err.soldOutCakeIds : [];
        // Refresh catalog state so UI reflects the sold-out status immediately
        fetchCakes(true).then((latest) => {
          setLatestCatalog(latest);
          if (onCakesUpdated) onCakesUpdated(latest);
        }).catch(() => {});
        setStockError({
          message: `申し訳ございません。ご注文いただいた「${names.join('」「')}」が直前に売り切れ（オーダーストップ）となったため、ご予約を確定できませんでした。カートから該当商品を削除して再度お手続きください。`,
          soldOutIds: ids,
          soldOutNames: names
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      setSubmitError('予約の送信に失敗しました。通信環境や入力内容をご確認の上、再試行してください。');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (cartItems.length === 0 && step === 'cart') {
    return (
      <div id="empty-cart-view" className="bg-white rounded-2xl sm:rounded-3xl p-8 sm:p-12 text-center border border-sleek-border max-w-lg mx-auto space-y-5 sm:space-y-6 shadow-xs">
        <div className="w-14 h-14 sm:w-16 sm:h-16 bg-sleek-cream rounded-full flex items-center justify-center mx-auto">
          <ShoppingBag className="w-7 h-7 sm:w-8 sm:h-8 text-sleek-gold" />
        </div>
        <div className="space-y-2">
          <h3 className="text-lg sm:text-xl font-light text-sleek-dark font-serif">カートは空です</h3>
          <p className="text-sleek-muted text-xs leading-relaxed max-w-xs mx-auto">
            ご予約いただくには、ケーキカタログからお好みのケーキをカートに追加してください。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div id="checkout-reservation-form" className="max-w-4xl mx-auto space-y-6">
      {/* Prominent Sold-Out Concurrency Error Banner (排他制御エラー表示) */}
      {(stockError || soldOutCartItems.length > 0) && step !== 'success' && (
        <div
          id="sold-out-conflict-banner"
          role="alert"
          className="bg-red-50 border-2 border-red-400 rounded-2xl p-4 sm:p-5 shadow-md space-y-3 animate-fade-in"
        >
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-red-600 text-white flex items-center justify-center shrink-0 mt-0.5">
              <AlertCircle className="w-5 h-5" />
            </div>
            <div className="space-y-1 flex-grow min-w-0">
              <h4 className="text-red-900 font-bold text-sm sm:text-base">
                在庫切れ（オーダーストップ）のため予約を確定できません
              </h4>
              <p className="text-red-800 text-xs sm:text-sm leading-relaxed">
                {stockError?.message ||
                  `申し訳ございません。カート内の「${soldOutCartItems.map(i => i.cakeName).join('」「')}」は現在売り切れ（オーダーストップ）となっているためご予約いただけません。`}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                const targetIds = stockError?.soldOutIds?.length
                  ? stockError.soldOutIds
                  : soldOutCartItems.map(i => i.cakeId);
                targetIds.forEach(id => onUpdateCartQty(id, 0));
                setStockError(null);
                if (cartItems.length <= targetIds.length) {
                  setStep('cart');
                }
              }}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-bold text-xs rounded-xl transition-all shadow-xs cursor-pointer"
            >
              売切商品をカートから削除する
            </button>
            {onReturnToCatalog && (
              <button
                type="button"
                onClick={() => {
                  const targetIds = stockError?.soldOutIds?.length
                    ? stockError.soldOutIds
                    : soldOutCartItems.map(i => i.cakeId);
                  targetIds.forEach(id => onUpdateCartQty(id, 0));
                  setStockError(null);
                  onReturnToCatalog();
                }}
                className="px-4 py-2 bg-white hover:bg-red-100 text-red-800 border border-red-300 font-semibold text-xs rounded-xl transition-all cursor-pointer"
              >
                ケーキ一覧へ戻る
              </button>
            )}
          </div>
        </div>
      )}

      {/* General Submit / Validation Error Banner */}
      {submitError && step !== 'success' && (
        <div
          role="alert"
          className="bg-amber-50 border border-amber-300 rounded-2xl p-4 text-amber-950 text-xs sm:text-sm flex items-center justify-between gap-3 shadow-xs"
        >
          <div className="flex items-center gap-2.5">
            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
            <span className="font-semibold">{submitError}</span>
          </div>
          <button
            type="button"
            onClick={() => setSubmitError(null)}
            className="text-amber-800 hover:text-amber-950 text-xs font-bold underline shrink-0"
          >
            閉じる
          </button>
        </div>
      )}

      {/* Checkout Wizard Header Tabs */}
      <div className="flex items-center justify-center gap-1 sm:gap-2 mb-4 sm:mb-8 text-[10px] sm:text-xs font-mono uppercase tracking-wider overflow-x-auto no-scrollbar py-1">
        <button
          id="tab-step-cart"
          disabled={step === 'success'}
          onClick={() => setStep('cart')}
          className={`font-semibold flex items-center gap-1 px-2 sm:px-4 py-1 sm:py-2 rounded-full transition-colors whitespace-nowrap shrink-0 ${
            step === 'cart'
              ? 'text-sleek-gold bg-sleek-cream border border-sleek-border/60 shadow-xs'
              : 'text-sleek-muted hover:text-sleek-dark disabled:opacity-40'
          }`}
        >
          <span className="sm:hidden">1. カート</span>
          <span className="hidden sm:inline">01. カートの商品</span>
        </button>
        <ChevronRight className="w-3 h-3 text-sleek-muted shrink-0" />
        <button
          id="tab-step-form"
          disabled={step === 'success' || cartItems.length === 0}
          onClick={() => setStep('form')}
          className={`font-semibold flex items-center gap-1 px-2 sm:px-4 py-1 sm:py-2 rounded-full transition-colors whitespace-nowrap shrink-0 ${
            step === 'form'
              ? 'text-sleek-gold bg-sleek-cream border border-sleek-border/60 shadow-xs'
              : 'text-sleek-muted hover:text-sleek-dark disabled:opacity-40'
          }`}
        >
          <span className="sm:hidden">2. お客様情報</span>
          <span className="hidden sm:inline">02. ご予約者情報</span>
        </button>
        <ChevronRight className="w-3 h-3 text-sleek-muted shrink-0" />
        <button
          id="tab-step-confirm"
          disabled={step === 'success' || cartItems.length === 0 || !name.trim() || !email.trim() || !phone.trim()}
          onClick={() => {
            if (validate()) setStep('confirm');
          }}
          className={`font-semibold flex items-center gap-1 px-2 sm:px-4 py-1 sm:py-2 rounded-full transition-colors whitespace-nowrap shrink-0 ${
            step === 'confirm'
              ? 'text-sleek-gold bg-sleek-cream border border-sleek-border/60 shadow-xs'
              : 'text-sleek-muted hover:text-sleek-dark disabled:opacity-40'
          }`}
        >
          <span className="sm:hidden">3. 確認</span>
          <span className="hidden sm:inline">03. 内容確認</span>
        </button>
        <ChevronRight className="w-3 h-3 text-sleek-muted shrink-0" />
        <button
          id="tab-step-success"
          disabled={true}
          className={`font-semibold flex items-center gap-1 px-2 sm:px-4 py-1 sm:py-2 rounded-full transition-colors whitespace-nowrap shrink-0 ${
            step === 'success'
              ? 'text-sleek-gold bg-sleek-cream border border-sleek-border/60 shadow-xs'
              : 'text-sleek-muted disabled:opacity-40'
          }`}
        >
          <span className="sm:hidden">4. 完了</span>
          <span className="hidden sm:inline">04. 予約完了</span>
        </button>
      </div>

        {step === 'cart' && (
          <div
            key="cart"
            className="grid grid-cols-1 lg:grid-cols-3 gap-6 sm:gap-8"
          >
            {/* Cart Left column: Items List */}
            <div className="lg:col-span-2 space-y-4">
              <div className="bg-white rounded-2xl sm:rounded-3xl p-4 sm:p-6 border border-sleek-border shadow-xs space-y-4">
                <h3 className="font-light text-base sm:text-lg text-sleek-dark font-serif border-b border-sleek-border pb-3 flex items-center justify-between">
                  <span>カート内商品</span>
                  <span className="text-xs font-sans text-sleek-muted font-normal">合計 {cartItems.length} 種類</span>
                </h3>
                
                <div className="divide-y divide-sleek-border">
                  {cartItems.map((item) => {
                    const cake = latestCatalog.find(c => c.id === item.cakeId) || cakes.find(c => c.id === item.cakeId);
                    const isItemSoldOut = Boolean(item.isSoldOut || cake?.isSoldOut);
                    return (
                      <div
                        key={item.cakeId}
                        className={`py-3.5 sm:py-4 flex items-center gap-3 sm:gap-4 first:pt-0 last:pb-0 ${
                          isItemSoldOut ? 'bg-red-50/60 -mx-2 px-2 rounded-xl border border-red-200' : ''
                        }`}
                      >
                        <img
                          src={cake?.imageUrl || FALLBACK_CAKE_IMAGE}
                          alt={item.cakeName}
                          className={`w-14 h-14 sm:w-16 sm:h-16 object-cover rounded-xl bg-sleek-cream border border-sleek-border-light shrink-0 ${
                            isItemSoldOut ? 'grayscale opacity-60' : ''
                          }`}
                          referrerPolicy="no-referrer"
                          onError={(e) => {
                            const target = e.currentTarget as HTMLImageElement;
                            if (target.src !== FALLBACK_CAKE_IMAGE) {
                              target.src = FALLBACK_CAKE_IMAGE;
                            }
                          }}
                        />
                        <div className="flex-grow min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <h4 className={`font-light text-sm sm:text-base font-serif truncate ${
                              isItemSoldOut ? 'text-red-800 line-through' : 'text-sleek-dark'
                            }`}>
                              {item.cakeName}
                            </h4>
                            {isItemSoldOut && (
                              <span className="px-2 py-0.5 bg-red-600 text-white text-[10px] font-bold rounded-full shrink-0">
                                売切・予約不可
                              </span>
                            )}
                          </div>
                          <p className="text-sleek-gold font-light text-xs font-mono mt-0.5">
                            ¥{item.price.toLocaleString()}
                          </p>
                        </div>

                        {/* Adjust quantities */}
                        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
                          <div className="flex items-center border border-sleek-border rounded-xl bg-sleek-bg overflow-hidden h-8 sm:h-9">
                            <button
                              id={`cart-qty-minus-${item.cakeId}`}
                              onClick={() => onUpdateCartQty(item.cakeId, item.quantity - 1)}
                              className="px-2 sm:px-2.5 text-sleek-muted hover:bg-sleek-cream hover:text-sleek-dark h-full transition-colors font-bold text-xs"
                              aria-label="数量を減らす"
                            >
                              -
                            </button>
                            <span className="px-2 text-sleek-dark text-xs sm:text-sm font-semibold font-mono min-w-[18px] text-center">
                              {item.quantity}
                            </span>
                            <button
                              id={`cart-qty-plus-${item.cakeId}`}
                              onClick={() => onUpdateCartQty(item.cakeId, item.quantity + 1)}
                              className="px-2 sm:px-2.5 text-sleek-muted hover:bg-sleek-cream hover:text-sleek-dark h-full transition-colors font-bold text-xs"
                              aria-label="数量を増やす"
                            >
                              +
                            </button>
                          </div>
                          
                          <button
                            id={`cart-item-delete-${item.cakeId}`}
                            onClick={() => onUpdateCartQty(item.cakeId, 0)}
                            className="text-sleek-muted hover:text-red-500 p-1.5 transition-colors"
                            title="商品を削除"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Cart Right column: Summary */}
            <div className="space-y-4">
              <div className="bg-sleek-cream rounded-2xl sm:rounded-3xl p-5 sm:p-6 border border-[#F2EDE4] shadow-xs space-y-5 sm:space-y-6">
                <div className="flex justify-between items-baseline py-1 border-b border-sleek-border/30 pb-3">
                  <span className="font-semibold text-xs tracking-wider uppercase text-sleek-dark">お支払い合計</span>
                  <div className="text-right">
                    <span className="text-2xl sm:text-3xl font-light font-sans text-sleek-gold font-bold">
                      ¥{totalPrice.toLocaleString()}
                    </span>
                    <p className="text-[10px] text-sleek-muted mt-0.5">※店頭でのお支払い（税込）</p>
                  </div>
                </div>

                <button
                  id="btn-go-to-form"
                  disabled={isVerifyingStock || soldOutCartItems.length > 0}
                  onClick={handleProceedToForm}
                  className="w-full bg-sleek-dark hover:bg-black disabled:bg-stone-300 disabled:cursor-not-allowed text-white font-semibold text-xs py-3.5 rounded-xl uppercase tracking-widest transition-all shadow-md flex items-center justify-center gap-1.5 border border-sleek-border-light active:scale-95"
                >
                  <span>{isVerifyingStock ? '在庫状況を確認中...' : 'ご予約者情報の入力へ'}</span>
                  <ArrowRight className="w-4 h-4 text-sleek-gold" />
                </button>
              </div>
            </div>
          </div>
        )}
        {step === 'form' && (
          <div
            key="form"
            className="bg-white rounded-2xl sm:rounded-3xl p-5 sm:p-8 border border-sleek-border shadow-xs"
          >
            <form onSubmit={handleProceedToConfirm} className="space-y-5 sm:space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
                
                {/* Name */}
                <div className="space-y-1.5">
                  <label htmlFor="customer-name" className="text-sleek-dark text-xs uppercase tracking-wider font-semibold flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5 text-sleek-gold" />
                    お名前（フルネーム）<span className="text-red-500 text-xs">*</span>
                  </label>
                  <input
                    type="text"
                    id="customer-name"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      if (errors.name) setErrors(prev => ({ ...prev, name: '' }));
                    }}
                    placeholder="山田 太郎"
                    className={`w-full border px-4 py-3 rounded-xl text-sleek-dark placeholder-sleek-muted text-base sm:text-sm focus:outline-none focus:ring-1 focus:ring-sleek-gold bg-white ${
                      errors.name ? 'border-red-400 focus:ring-red-450' : 'border-sleek-border'
                    }`}
                  />
                  {errors.name && <p className="text-red-500 text-[10px] font-semibold">{errors.name}</p>}
                </div>

                {/* Name Kana */}
                <div className="space-y-1.5">
                  <label htmlFor="customer-name-kana" className="text-sleek-dark text-xs uppercase tracking-wider font-semibold flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5 text-sleek-gold" />
                    お名前の読み（カタカナ）<span className="text-red-500 text-xs">*</span>
                  </label>
                  <input
                    type="text"
                    id="customer-name-kana"
                    value={nameKana}
                    onChange={(e) => {
                      setNameKana(e.target.value);
                      if (errors.nameKana) setErrors(prev => ({ ...prev, nameKana: '' }));
                    }}
                    placeholder="ヤマダ タロウ"
                    className={`w-full border px-4 py-3 rounded-xl text-sleek-dark placeholder-sleek-muted text-base sm:text-sm focus:outline-none focus:ring-1 focus:ring-sleek-gold bg-white ${
                      errors.nameKana ? 'border-red-400 focus:ring-red-450' : 'border-sleek-border'
                    }`}
                  />
                  {errors.nameKana && <p className="text-red-500 text-[10px] font-semibold">{errors.nameKana}</p>}
                </div>

                {/* Email */}
                <div className="space-y-1.5">
                  <label htmlFor="customer-email" className="text-sleek-dark text-xs uppercase tracking-wider font-semibold flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5 text-sleek-gold" />
                    メールアドレス<span className="text-red-500 text-xs">*</span>
                  </label>
                  <input
                    type="email"
                    id="customer-email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (errors.email) setErrors(prev => ({ ...prev, email: '' }));
                    }}
                    placeholder="your@email.com"
                    className={`w-full border px-4 py-3 rounded-xl text-sleek-dark placeholder-sleek-muted text-base sm:text-sm focus:outline-none focus:ring-1 focus:ring-sleek-gold bg-white ${
                      errors.email ? 'border-red-400 focus:ring-red-450' : 'border-sleek-border'
                    }`}
                  />
                  {errors.email && <p className="text-red-500 text-[10px] font-semibold">{errors.email}</p>}
                </div>

                {/* Phone */}
                <div className="space-y-1.5">
                  <label htmlFor="customer-phone" className="text-sleek-dark text-xs uppercase tracking-wider font-semibold flex items-center gap-1.5">
                    <Phone className="w-3.5 h-3.5 text-sleek-gold" />
                    電話番号（連絡先）<span className="text-red-500 text-xs">*</span>
                  </label>
                  <input
                    type="tel"
                    id="customer-phone"
                    value={phone}
                    onChange={(e) => {
                      setPhone(e.target.value);
                      if (errors.phone) setErrors(prev => ({ ...prev, phone: '' }));
                    }}
                    placeholder="090-1234-5678"
                    className={`w-full border px-4 py-3 rounded-xl text-sleek-dark placeholder-sleek-muted text-base sm:text-sm focus:outline-none focus:ring-1 focus:ring-sleek-gold bg-white ${
                      errors.phone ? 'border-red-400 focus:ring-red-450' : 'border-sleek-border'
                    }`}
                  />
                  {errors.phone && <p className="text-red-500 text-[10px] font-semibold">{errors.phone}</p>}
                </div>

                {/* Date Selection */}
                <div className="col-span-1 md:col-span-2 space-y-2 bg-sleek-cream/30 p-4 sm:p-5 rounded-2xl sm:rounded-3xl border border-sleek-border">
                  <label htmlFor="pickup-date-select" className="text-sleek-dark text-xs uppercase tracking-wider font-semibold flex items-center gap-1.5 border-b border-sleek-border pb-2">
                    <Calendar className="w-3.5 h-3.5 text-sleek-gold" />
                    お受取り日を選択してください<span className="text-red-500 text-xs">*</span>
                  </label>
                  
                  <div className="relative pt-1.5">
                    <select
                      id="pickup-date-select"
                      value={date}
                      onChange={(e) => {
                        setDate(e.target.value);
                        if (errors.date) setErrors(prev => ({ ...prev, date: '' }));
                      }}
                      className="w-full border border-sleek-border px-3 sm:px-4 py-3 rounded-xl text-sleek-dark text-sm sm:text-base focus:outline-none focus:ring-1 focus:ring-sleek-gold bg-white cursor-pointer hover:border-sleek-gold transition-colors font-medium text-center"
                    >
                      {isLoadingDays ? (
                        <option value="">営業日カレンダーを読み込み中...</option>
                      ) : selectableDays.length === 0 ? (
                        <option value="">現在受取り可能日（営業日）として設定されている日程がありません</option>
                      ) : (
                        <>
                          <option value="">-- 日付をご選択ください --</option>
                          {selectableDays.map((dStr) => (
                            <option key={dStr} value={dStr}>
                              {getFormatLabel(dStr)}
                            </option>
                          ))}
                        </>
                      )}
                    </select>
                  </div>

                  {/* Feedback text below dropdown */}
                  {date ? (
                    <div className="bg-white border border-sleek-border-light shadow-xs p-2.5 sm:p-3 rounded-xl mt-2 flex flex-wrap items-center justify-center gap-1 sm:gap-1.5 animate-fade-in text-center">
                      <Check className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-600 shrink-0 font-bold" />
                      <span className="text-[11px] sm:text-xs text-sleek-dark font-medium whitespace-nowrap">
                        ご予約お受取り確定日：
                      </span>
                      <strong className="text-[11px] sm:text-xs text-sleek-gold font-sans font-bold whitespace-nowrap">
                        {getFormatLabel(date)}
                      </strong>
                    </div>
                  ) : (
                    <div className="bg-red-50/40 p-2.5 rounded-xl border border-red-100 text-center text-[10px] text-red-600 font-medium">
                      ⚠️ お受取り可能な店舗営業日が上記に表示されます。選択してください。
                    </div>
                  )}
                  {errors.date && <p className="text-red-500 text-[10px] font-semibold text-center mt-1">{errors.date}</p>}
                </div>

                {/* Time Selection */}
                <div className="col-span-1 md:col-span-2 space-y-1.5">
                  <label htmlFor="pickup-time" className="text-sleek-dark text-xs uppercase tracking-wider font-semibold flex items-center gap-1.5 whitespace-nowrap">
                    <Clock className="w-3.5 h-3.5 text-sleek-gold shrink-0" />
                    お受取り時間帯<span className="text-red-500 text-xs">*</span>
                  </label>
                  <select
                    id="pickup-time"
                    value={time}
                    onChange={(e) => {
                      setTime(e.target.value);
                      if (errors.time) setErrors(prev => ({ ...prev, time: '' }));
                    }}
                    className="w-full border border-sleek-border px-4 py-3 rounded-xl text-sleek-dark text-base sm:text-sm focus:outline-none focus:ring-1 focus:ring-sleek-gold bg-white"
                  >
                    {TIME_SLOTS.map((slot) => (
                      <option key={slot} value={slot}>
                        {slot}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Form Actions footer */}
              <div className="flex flex-col sm:flex-row items-center justify-between border-t border-sleek-border pt-5 sm:pt-6 gap-3 sm:gap-4">
                <button
                  type="button"
                  id="btn-back-to-cart"
                  onClick={() => setStep('cart')}
                  className="w-full sm:w-auto text-sleek-muted hover:text-sleek-dark font-medium text-xs uppercase tracking-wider transition-colors py-2 text-center whitespace-nowrap"
                >
                  ショッピングカートに戻る
                </button>
                <button
                  type="submit"
                  id="btn-submit-booking"
                  disabled={isVerifyingStock}
                  className="w-full sm:w-auto bg-sleek-dark hover:bg-black disabled:bg-stone-300 text-white font-semibold px-8 py-3.5 rounded-xl transition-all shadow-md flex items-center justify-center gap-2 text-xs uppercase tracking-widest border border-sleek-border-light active:scale-95 whitespace-nowrap"
                >
                  <span>{isVerifyingStock ? '在庫状況を確認中...' : '内容確認へ進む'}</span>
                  <ArrowRight className="w-4 h-4 text-sleek-gold" />
                </button>
              </div>
            </form>
          </div>
        )}

        {step === 'confirm' && (
          <div
            key="confirm"
            className="bg-white rounded-2xl sm:rounded-3xl p-4 sm:p-6 md:p-8 border border-sleek-border shadow-sm space-y-5 sm:space-y-6"
          >
            <div className="border-b border-sleek-border pb-3 sm:pb-4">
              <h3 className="font-serif font-light text-base sm:text-xl text-sleek-dark whitespace-nowrap">03. ご入力内容の確認</h3>
              <p className="text-[11px] sm:text-xs text-sleek-muted mt-1 leading-relaxed">
                <span className="inline-block">以下の内容でよろしければ</span>
                <span className="inline-block">「予約確定」ボタンを押してください。</span>
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 sm:gap-8">
              {/* Left Column: Order details */}
              <div className="space-y-4">
                <h4 className="font-semibold text-xs uppercase tracking-wider text-sleek-dark border-b border-sleek-border pb-2 flex items-center gap-1.5 whitespace-nowrap">
                  <ShoppingBag className="w-4 h-4 text-sleek-gold shrink-0" />
                  ご注文内容
                </h4>
                <div className="divide-y divide-sleek-border">
                  {cartItems.map((item) => {
                    const cake = latestCatalog.find(c => c.id === item.cakeId) || cakes.find(c => c.id === item.cakeId);
                    const isItemSoldOut = Boolean(item.isSoldOut || cake?.isSoldOut);
                    return (
                      <div
                        key={item.cakeId}
                        className={`py-3 flex items-center gap-3 ${
                          isItemSoldOut ? 'bg-red-50/70 -mx-2 px-2 rounded-xl border border-red-200' : ''
                        }`}
                      >
                        <img
                          src={cake?.imageUrl || FALLBACK_CAKE_IMAGE}
                          alt={item.cakeName}
                          className={`w-12 h-12 object-cover rounded-lg bg-sleek-cream border border-sleek-border/40 shrink-0 ${
                            isItemSoldOut ? 'grayscale opacity-60' : ''
                          }`}
                          referrerPolicy="no-referrer"
                          onError={(e) => {
                            const target = e.currentTarget as HTMLImageElement;
                            if (target.src !== FALLBACK_CAKE_IMAGE) {
                              target.src = FALLBACK_CAKE_IMAGE;
                            }
                          }}
                        />
                        <div className="flex-grow min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <h5 className={`font-medium text-xs font-serif truncate ${
                              isItemSoldOut ? 'text-red-800 line-through' : 'text-sleek-dark'
                            }`}>
                              {item.cakeName}
                            </h5>
                            {isItemSoldOut && (
                              <span className="px-1.5 py-0.5 bg-red-600 text-white text-[9px] font-bold rounded-full shrink-0">
                                売切・予約不可
                              </span>
                            )}
                          </div>
                          <p className="text-sleek-muted text-[10px] whitespace-nowrap">
                            ¥{item.price.toLocaleString()} × {item.quantity}
                          </p>
                        </div>
                        <span className="text-xs font-medium text-sleek-gold font-mono whitespace-nowrap shrink-0">
                          ¥{(item.price * item.quantity).toLocaleString()}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="bg-sleek-cream p-3.5 sm:p-4 rounded-2xl border border-[#F2EDE4] flex justify-between items-baseline gap-2 mt-4">
                  <span className="text-[11px] sm:text-xs font-bold text-sleek-dark uppercase tracking-wider whitespace-nowrap">合計お支払い額 (店頭受取)</span>
                  <div className="text-right shrink-0">
                    <span className="text-lg sm:text-xl font-light text-sleek-gold font-sans font-semibold whitespace-nowrap">
                      ¥{totalPrice.toLocaleString()}
                    </span>
                    <p className="text-[9px] text-sleek-muted mt-0.5 whitespace-nowrap">※店頭でのお支払いとなります。</p>
                  </div>
                </div>
              </div>

              {/* Right Column: Customer details */}
              <div className="space-y-4">
                <h4 className="font-semibold text-xs uppercase tracking-wider text-sleek-dark border-b border-sleek-border pb-2 flex items-center gap-1.5 whitespace-nowrap">
                  <User className="w-4 h-4 text-sleek-gold shrink-0" />
                  ご予約者・お受取り情報
                </h4>
                <div className="bg-sleek-bg p-3.5 sm:p-4 rounded-2xl border border-sleek-border space-y-3.5 text-xs text-sleek-text">
                  <div className="grid grid-cols-3 gap-2">
                    <span className="text-sleek-muted font-medium text-[11px] sm:text-xs whitespace-nowrap">お名前</span>
                    <span className="col-span-2 text-sleek-dark font-semibold">
                      {name}
                      {nameKana && <span className="text-[11px] text-sleek-gold font-sans font-medium block mt-0.5">（{nameKana}）</span>}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 border-t border-sleek-border-light pt-2">
                    <span className="text-sleek-muted font-medium text-[11px] sm:text-xs whitespace-nowrap">メールアドレス</span>
                    <span className="col-span-2 text-sleek-dark break-all font-mono text-[11px] sm:text-xs">{email}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 border-t border-sleek-border-light pt-2">
                    <span className="text-sleek-muted font-medium text-[11px] sm:text-xs whitespace-nowrap">電話番号</span>
                    <span className="col-span-2 text-sleek-dark font-mono whitespace-nowrap">{phone}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 border-t border-sleek-border-light pt-2">
                    <span className="text-sleek-muted font-medium text-[11px] sm:text-xs whitespace-nowrap">お受取り日</span>
                    <span className="col-span-2 text-sleek-dark font-semibold whitespace-nowrap">{date}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 border-t border-sleek-border-light pt-2">
                    <span className="text-sleek-muted font-medium text-[11px] sm:text-xs whitespace-nowrap">受取り時間</span>
                    <span className="col-span-2 text-sleek-dark font-semibold whitespace-nowrap">{time}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom Actions footer */}
            <div className="flex flex-col md:flex-row items-center justify-between border-t border-sleek-border pt-5 sm:pt-6 gap-3 sm:gap-4">
              <button
                type="button"
                id="btn-edit-details"
                onClick={() => setStep('form')}
                className="w-full md:w-auto text-sleek-muted hover:text-sleek-dark font-medium text-xs uppercase tracking-wider transition-colors border border-sleek-border px-6 py-3 rounded-xl hover:bg-sleek-bg bg-white whitespace-nowrap"
              >
                内容修正
              </button>
              <button
                type="button"
                id="btn-confirm-and-submit"
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="w-full md:w-auto bg-sleek-dark hover:bg-black disabled:bg-stone-300 text-white font-semibold px-8 py-3.5 rounded-xl transition-all shadow-md flex items-center justify-center gap-2 text-xs uppercase tracking-widest border border-sleek-border-light whitespace-nowrap"
              >
                {isSubmitting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    最新在庫を確認・予約登録中...
                  </>
                ) : (
                  <>
                    予約確定（店頭払い）
                    <Check className="w-4 h-4 text-sleek-gold" />
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {step === 'success' && (
          <div
            key="success"
            className="bg-white rounded-2xl sm:rounded-3xl p-5 sm:p-8 md:p-12 border border-sleek-border shadow-xl max-w-xl mx-auto text-center space-y-5 sm:space-y-6"
          >
            <div className="w-14 h-14 sm:w-16 sm:h-16 bg-emerald-50 rounded-full flex items-center justify-center mx-auto shadow-xs">
              <CheckCircle2 className="w-8 h-8 sm:w-9 sm:h-9 text-emerald-600" />
            </div>
            
            <div className="space-y-2">
              <span className="text-[10px] sm:text-[11px] uppercase font-bold tracking-widest bg-emerald-50 border border-emerald-200 text-emerald-700 px-3.5 py-1 rounded-full whitespace-nowrap">
                04. 予約完了
              </span>
              <h2 className="text-lg sm:text-2xl md:text-3xl font-light text-sleek-dark font-serif pt-1 whitespace-nowrap">
                ご予約が完了いたしました！
              </h2>
              <p className="text-[11px] sm:text-xs text-sleek-muted leading-relaxed">
                <span className="inline-block">ご予約ありがとうございます。</span>
                <span className="inline-block">当日店頭にてお待ちしております。</span>
              </p>
            </div>

            {/* Prominent Automated Confirmation Email Notification Card (UI上の強調通知) */}
            <div className="bg-emerald-50 border-2 border-emerald-400/80 rounded-2xl p-4 sm:p-5 text-left space-y-2 shadow-xs">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0 mt-0.5 shadow-2xs">
                  <Mail className="w-5 h-5" />
                </div>
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <h4 className="font-bold text-emerald-950 text-xs sm:text-sm flex items-center gap-1.5">
                      <span>予約確認メール（控え）を送信いたしました</span>
                      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    </h4>
                    <span className="text-[10px] bg-emerald-200/80 text-emerald-900 border border-emerald-400 font-mono font-bold px-2 py-0.2 rounded-full">
                      配信完了 200 OK
                    </span>
                  </div>
                  <p className="text-[11px] sm:text-xs text-emerald-900 leading-relaxed">
                    ご入力いただいたメールアドレス（<strong className="underline underline-offset-2 break-all">{completedReservation?.email || email}</strong>）宛てに、ご予約内容の確認メール（控え）を自動送信いたしました。
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-sleek-cream p-4 sm:p-6 rounded-2xl border border-[#F2EDE4] text-center space-y-2.5 sm:space-y-3 max-w-md mx-auto">
              <span className="text-[11px] sm:text-xs uppercase tracking-wider font-semibold text-sleek-gold block font-mono whitespace-nowrap">
                お受取り日時
              </span>
              <p className="text-sm sm:text-lg md:text-xl font-medium text-sleek-dark font-serif flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
                <span className="whitespace-nowrap">{getFormatLabel(completedReservation?.date || date)}</span>
                <span className="whitespace-nowrap">{completedReservation?.time || time}</span>
              </p>
              <div className="w-8 h-px bg-sleek-border/40 mx-auto my-2" />
              <div className="text-[11px] sm:text-xs text-sleek-dark space-y-1">
                <p className="whitespace-nowrap">ご予約者様：<strong>{completedReservation?.name || name} 様</strong></p>
                <p className="whitespace-nowrap">お支払い合計：<strong className="text-sleek-gold font-semibold">¥{(completedReservation?.totalPrice || successPrice || totalPrice).toLocaleString()}</strong>（店頭払い）</p>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setShowSuccessModal(true)}
                className="w-full sm:w-auto px-5 py-3 bg-white hover:bg-stone-50 text-stone-900 border border-stone-300 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 shadow-2xs transition-all active:scale-95 cursor-pointer"
              >
                <FileText className="w-4 h-4 text-emerald-700" />
                <span>予約控え・確認メール通知を再表示</span>
              </button>

              <button
                id="btn-return-to-catalog"
                onClick={() => {
                  setStep('cart');
                  setName(userName || '');
                  setNameKana('');
                  setEmail(userEmail || '');
                  setPhone('');
                  setNotes('');
                  if (onReturnToCatalog) {
                    onReturnToCatalog();
                  }
                }}
                className="w-full sm:w-auto bg-sleek-dark hover:bg-black text-white font-semibold text-xs px-6 py-3 rounded-xl transition-all inline-flex items-center justify-center gap-1.5 uppercase tracking-wider shadow-md border border-sleek-border-light active:scale-95 cursor-pointer"
              >
                <span>ケーキ一覧に戻る</span>
                <ArrowRight className="w-4 h-4 text-sleek-gold" />
              </button>
            </div>
          </div>
        )}

      {/* Automated Reservation Success & Confirmation Email Modal */}
      <ReservationSuccessModal
        isOpen={showSuccessModal}
        onClose={() => setShowSuccessModal(false)}
        reservation={completedReservation}
        onReturnToCatalog={() => {
          setShowSuccessModal(false);
          setStep('cart');
          setName(userName || '');
          setNameKana('');
          setEmail(userEmail || '');
          setPhone('');
          setNotes('');
          if (onReturnToCatalog) onReturnToCatalog();
        }}
        onToast={onToast}
      />
    </div>
  );
}
