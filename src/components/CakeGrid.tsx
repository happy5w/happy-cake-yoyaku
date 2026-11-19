import { useState, useMemo, useRef } from 'react';
import { Cake } from '../types';
import { CAKES, CATEGORY_LABELS } from '../data/cakes';
import {
  getEffectiveStockForDate,
  isCakeSoldOutForDate,
  formatShortBusinessDateLabel,
  isReservationDeadlinePassed,
} from '../lib/dbService';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, Minus, ShoppingBag, Info, Check, Sparkles, AlertCircle, Calendar } from 'lucide-react';

const FALLBACK_CAKE_IMAGE = 'https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=600&auto=format&fit=crop&q=80';

interface CakeGridProps {
  onAddToCart: (cake: Cake, quantity: number) => boolean | void;
  onWarning?: (message: string) => void;
  cart: { [cakeId: string]: number };
  cakes?: Cake[];
  reservableDays?: string[];
  selectedPickupDate?: string;
  onSelectPickupDate?: (date: string) => void;
}

export default function CakeGrid({
  onAddToCart,
  onWarning,
  cart,
  cakes = CAKES,
  reservableDays,
  selectedPickupDate,
  onSelectPickupDate,
}: CakeGridProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedCake, setSelectedCake] = useState<Cake | null>(null);
  const [quantities, setQuantities] = useState<{ [cakeId: string]: number }>({});
  const [limitAlert, setLimitAlert] = useState<{ cakeId: string; message: string } | null>(null);
  const alertTimerRef = useRef<number | null>(null);

  const categories = useMemo(() => {
    const presentCats = Array.from(new Set(cakes.map(c => c.category))).filter(Boolean);
    const order = ['all', 'hall', 'cut', 'seasonal', 'tart'];
    const result = ['all'];
    for (const cat of order) {
      if (cat !== 'all' && presentCats.includes(cat as any)) {
        result.push(cat);
      }
    }
    for (const cat of presentCats) {
      if (!result.includes(cat)) {
        result.push(cat);
      }
    }
    return result;
  }, [cakes]);

  const filteredCakes = selectedCategory === 'all' 
    ? cakes 
    : cakes.filter(c => c.category === selectedCategory);

  const getQuantity = (cakeId: string) => {
    return quantities[cakeId] || 1;
  };

  const totalCartQty = useMemo(
    () => Object.values(cart).reduce((sum, qty) => sum + (qty as number), 0),
    [cart]
  );

  const showLimitWarning = (cakeId: string, message: string) => {
    if (alertTimerRef.current) {
      window.clearTimeout(alertTimerRef.current);
    }
    setLimitAlert({ cakeId, message });
    if (onWarning) {
      onWarning(message);
    }
    alertTimerRef.current = window.setTimeout(() => {
      setLimitAlert(prev => (prev?.cakeId === cakeId ? null : prev));
      alertTimerRef.current = null;
    }, 3500);
  };

  const handleAdjustQuantity = (cake: Cake, delta: number) => {
    const current = quantities[cake.id] || 1;
    const next = current + delta;

    if (delta > 0) {
      const inCartForCake = cart[cake.id] || 0;
      const effectiveStock = getEffectiveStockForDate(cake, selectedPickupDate);

      if (totalCartQty + next > 10) {
        const msg = totalCartQty > 0
          ? `⚠️ 1回のご予約で10個までです！（現在カートに${totalCartQty}個入っています）`
          : '⚠️ 1回のご予約で10個までです！';
        showLimitWarning(cake.id, msg);
        return;
      }

      if (cake.category === 'hall' && inCartForCake + next > 2) {
        showLimitWarning(cake.id, `⚠️ ホールケーキ（${cake.jpName}）は各種2台までです。`);
        return;
      }

      if (typeof effectiveStock === 'number' && inCartForCake + next > effectiveStock) {
        showLimitWarning(
          cake.id,
          effectiveStock <= 10
            ? `⚠️「${cake.jpName}」は残りわずかのため、これ以上追加できません。`
            : `⚠️「${cake.jpName}」の在庫上限（${effectiveStock}個）を超えるため追加できません。`
        );
        return;
      }
    }

    const clamped = Math.max(1, next);
    setQuantities(prev => ({ ...prev, [cake.id]: clamped }));
    if (limitAlert?.cakeId === cake.id) {
      setLimitAlert(null);
    }
  };

  const handleAddClick = (cake: Cake): boolean => {
    if (reservableDays !== undefined && reservableDays.length === 0) {
      showLimitWarning(cake.id, '現在ご予約可能な営業日が設定されていないため、カートに追加できません。');
      return false;
    }
    if (isCakeSoldOutForDate(cake, selectedPickupDate)) {
      showLimitWarning(cake.id, `⚠️「${cake.jpName}」は選択中のお受取り日において売り切れとなっております。`);
      return false;
    }

    const qty = getQuantity(cake.id);
    const inCartForCake = cart[cake.id] || 0;
    const effectiveStock = getEffectiveStockForDate(cake, selectedPickupDate);

    if (totalCartQty + qty > 10) {
      const msg = totalCartQty > 0
        ? `⚠️ 1回のご予約で10個までです！（現在カートに${totalCartQty}個入っています）`
        : '⚠️ 1回のご予約で10個までです！';
      showLimitWarning(cake.id, msg);
      return false;
    }

    if (cake.category === 'hall' && inCartForCake + qty > 2) {
      showLimitWarning(cake.id, `⚠️ ホールケーキ（${cake.jpName}）は各種2台までです。`);
      return false;
    }

    if (typeof effectiveStock === 'number' && inCartForCake + qty > effectiveStock) {
      showLimitWarning(
        cake.id,
        effectiveStock <= 10
          ? `⚠️「${cake.jpName}」は残りわずかのため追加できません。`
          : `⚠️「${cake.jpName}」の在庫上限（${effectiveStock}個）を超えるため追加できません。`
      );
      return false;
    }

    const result = onAddToCart(cake, qty);
    if (result === false) {
      return false;
    }
    setQuantities(prev => ({ ...prev, [cake.id]: 1 }));
    if (limitAlert?.cakeId === cake.id) {
      setLimitAlert(null);
    }
    return true;
  };

  return (
    <div id="cake-catalog-section" className="space-y-5 sm:space-y-7">
      {/* Pickup Date Selector Linked to Business Days */}
      {reservableDays !== undefined && (
        <div className="bg-white border border-sleek-border rounded-2xl p-3.5 sm:p-4 shadow-xs max-w-4xl mx-auto">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
            <div className="flex items-center gap-1.5 text-xs font-bold text-sleek-dark shrink-0">
              <Calendar className="w-4 h-4 text-sleek-gold shrink-0" />
              <span>お受取り希望日（予約可能日）:</span>
            </div>
            {reservableDays.length === 0 ? (
              <p className="text-[11px] sm:text-xs text-amber-800 font-medium">
                {isReservationDeadlinePassed()
                  ? 'ご予約受付は12/18（金）をもって終了いたしました。'
                  : '現在ご予約可能な営業日が設定されていません（締切：12/18（金）まで）。'}
              </p>
            ) : (
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
                {reservableDays.map((d) => {
                  const isActive = selectedPickupDate === d;
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => {
                        onSelectPickupDate?.(d);
                        const conflictNames: string[] = [];
                        for (const [cakeId, qty] of Object.entries(cart)) {
                          if (!qty || qty <= 0) continue;
                          const c = cakes.find(item => item.id === cakeId);
                          if (!c) continue;
                          const eff = getEffectiveStockForDate(c, d);
                          if (isCakeSoldOutForDate(c, d) || (typeof eff === 'number' && qty > eff)) {
                            conflictNames.push(c.jpName);
                          }
                        }
                        if (conflictNames.length > 0 && onWarning) {
                          onWarning(`⚠️ ${formatShortBusinessDateLabel(d)}はカート内の「${conflictNames.join('・')}」が売り切れまたは在庫不足です。カート画面でご確認ください。`);
                        }
                      }}
                      className={`whitespace-nowrap px-3 py-1.5 rounded-xl text-xs font-mono font-bold transition-all shrink-0 cursor-pointer border ${
                        isActive
                          ? 'bg-sleek-dark text-[#D4AF37] border-sleek-dark shadow-xs'
                          : 'bg-sleek-bg text-sleek-dark border-sleek-border hover:bg-sleek-cream'
                      }`}
                    >
                      {formatShortBusinessDateLabel(d)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Category Nav */}
      <div className="flex items-center justify-center overflow-x-auto no-scrollbar gap-1.5 sm:gap-3 border-b border-sleek-border pb-4 px-1 -mx-2 sm:mx-0">
        {categories.map((cat) => {
          const count = cat === 'all' ? cakes.length : cakes.filter(c => c.category === cat).length;
          const isSelected = selectedCategory === cat;
          const label = cat === 'all' ? 'すべてのケーキ' : CATEGORY_LABELS[cat as keyof typeof CATEGORY_LABELS];

          return (
            <button
              key={cat}
              id={`btn-cat-${cat}`}
              onClick={() => setSelectedCategory(cat)}
              className={`whitespace-nowrap px-2.5 sm:px-5 py-1.5 sm:py-2.5 rounded-full text-[11px] sm:text-xs font-semibold tracking-wide sm:tracking-wider uppercase transition-all shrink-0 active:scale-95 flex items-center gap-1 sm:gap-2 ${
                isSelected
                  ? 'bg-sleek-dark text-white shadow-md shadow-sleek-dark/15 font-bold'
                  : 'bg-white text-sleek-muted border border-sleek-border hover:bg-sleek-cream hover:text-sleek-dark'
              }`}
            >
              <span>{label}</span>
              <span
                className={`inline-flex items-center justify-center min-w-[18px] sm:min-w-[20px] h-4 sm:h-5 px-1 sm:px-1.5 rounded-full text-[10px] sm:text-[11px] font-mono font-bold leading-none transition-colors ${
                  isSelected
                    ? 'bg-[#D4AF37] text-[#1A1A1A]'
                    : 'bg-sleek-cream text-sleek-dark border border-sleek-border'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Grid List */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-8">
        {filteredCakes.map((cake) => {
          const cartQty = cart[cake.id] || 0;
          const safeTags = Array.isArray(cake.tags) ? cake.tags : [];
          const isSoldOut = isCakeSoldOutForDate(cake, selectedPickupDate);
          const effectiveStock = getEffectiveStockForDate(cake, selectedPickupDate);
          const isLowStock = !isSoldOut && typeof effectiveStock === 'number' && effectiveStock > 0 && effectiveStock <= 10;

          return (
            <div
              key={cake.id}
              id={`cake-card-${cake.id}`}
              className={`rounded-2xl sm:rounded-3xl overflow-hidden shadow-xs hover:shadow-md hover:-translate-y-0.5 transition-all duration-300 border flex flex-col group h-full ${
                cartQty > 0 
                  ? 'bg-[#FDFBF7] ring-1 ring-[#D4AF37]/40 border-[#D4AF37]/30' 
                  : 'bg-white border-sleek-border'
              }`}
            >
              {/* Image Container */}
              <div 
                className="relative h-48 sm:h-56 overflow-hidden bg-sleek-cream cursor-pointer"
                onClick={() => setSelectedCake(cake)}
              >
                <img
                  src={cake.imageUrl}
                  alt={cake.jpName}
                  className={`w-full h-full object-cover transition-transform duration-700 ${isSoldOut ? 'grayscale-[60%]' : 'group-hover:scale-105'}`}
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    const target = e.currentTarget as HTMLImageElement;
                    if (target.src !== FALLBACK_CAKE_IMAGE) {
                      target.src = FALLBACK_CAKE_IMAGE;
                    }
                  }}
                />
                {isSoldOut && (
                  <div className="absolute inset-0 bg-stone-950/65 backdrop-blur-[1px] flex flex-col items-center justify-center p-3 text-center z-10">
                    <span className="bg-red-600 text-white font-bold text-xs sm:text-sm px-3.5 py-1 rounded-full shadow-lg tracking-wider whitespace-nowrap">
                      売り切れ
                    </span>
                    <span className="text-[11px] text-stone-200 mt-1 font-medium tracking-wide whitespace-nowrap">
                      オーダーストップ中
                    </span>
                  </div>
                )}
                <div className="absolute top-2.5 left-2.5 sm:top-3 sm:left-3 flex flex-wrap gap-1">
                  {safeTags.map(tag => (
                    <span 
                      key={tag} 
                      className="bg-white/95 text-sleek-gold border border-sleek-border/30 text-[9px] sm:text-[10px] px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-full font-bold shadow-xs backdrop-blur-xs flex items-center gap-1 uppercase tracking-wider font-mono whitespace-nowrap"
                    >
                      <Sparkles className="w-2.5 h-2.5 sm:w-3 sm:h-3 text-sleek-gold fill-sleek-gold/10 shrink-0" />
                      {tag}
                    </span>
                  ))}
                </div>
                {cartQty > 0 && !isSoldOut && (
                  <div className="absolute top-2.5 right-2.5 sm:top-3 sm:right-3 bg-sleek-dark text-white text-[10px] px-2.5 sm:px-3 py-0.5 sm:py-1 rounded-full font-bold shadow-md flex items-center gap-1 tracking-wider uppercase border border-sleek-border/30 whitespace-nowrap">
                    <Check className="w-3 h-3 text-sleek-gold shrink-0" />
                    カート: {cartQty}個
                  </div>
                )}
              </div>

              {/* Card Body */}
              <div className="p-3.5 sm:p-5 flex flex-col flex-grow justify-between gap-3">
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-grow min-w-0">
                      <h3 
                        onClick={() => setSelectedCake(cake)}
                        className="font-light text-sm sm:text-lg text-sleek-dark group-hover:text-sleek-gold transition-colors font-serif cursor-pointer leading-snug break-keep"
                      >
                        {cake.jpName}
                      </h3>
                      <p className="text-[9px] sm:text-[10px] text-sleek-muted font-mono tracking-wider uppercase mt-0.5 truncate">
                        {cake.name}
                      </p>
                    </div>
                    <button
                      id={`cake-detail-info-btn-${cake.id}`}
                      onClick={() => setSelectedCake(cake)}
                      className="inline-flex items-center gap-1 text-[10px] sm:text-[11px] font-medium text-sleek-muted hover:text-sleek-dark bg-sleek-bg hover:bg-sleek-cream border border-sleek-border px-2 sm:px-2.5 py-1 rounded-lg transition-all shrink-0 active:scale-95 whitespace-nowrap"
                      title="ケーキの詳細・紹介文を見る"
                    >
                      <Info className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-sleek-gold shrink-0" />
                      <span>詳細</span>
                    </button>
                  </div>
                </div>

                {/* Pricing & Cart Action */}
                <div className="pt-3 border-t border-sleek-border space-y-2">
                  {isLowStock && (
                    <div>
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full whitespace-nowrap">
                        残りわずかです！
                      </span>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-sleek-muted text-[9px] sm:text-[10px] tracking-wider block uppercase font-mono leading-tight whitespace-nowrap">
                        {cake.portionLabel || (cake.id === 'buche-de-noel' ? '長さ１８㎝' : cake.id === 'rice-chou' ? '１つ' : cake.category === 'hall' ? '４号（直径１５㎝）' : cake.category === 'cut' ? '１カット' : 'テイクアウト価格')}
                      </span>
                      <div className="flex items-baseline gap-0.5 sm:gap-1 whitespace-nowrap">
                        <span className="text-lg sm:text-2xl font-light font-sans text-sleek-gold leading-none">
                          ¥{(Number(cake.price) || 0).toLocaleString()}
                        </span>
                        <span className="text-sleek-muted text-[9px] sm:text-[10px]">（税込）</span>
                      </div>
                    </div>

                    {/* Quantity Action Counter & Add button */}
                    {isSoldOut ? (
                      <span className="text-[11px] sm:text-xs px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-xl bg-red-50 text-red-700 font-bold border border-red-200 whitespace-nowrap shrink-0">
                        売り切れ
                      </span>
                    ) : (
                      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                        <div className="flex items-center border border-sleek-border rounded-xl bg-sleek-bg overflow-hidden h-8 sm:h-10">
                          <button
                            id={`btn-qty-minus-${cake.id}`}
                            onClick={() => handleAdjustQuantity(cake, -1)}
                            className="px-2 sm:px-3 text-sleek-muted hover:bg-sleek-cream hover:text-sleek-dark h-full transition-colors active:bg-stone-200"
                            aria-label="数量を減らす"
                          >
                            <Minus className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                          </button>
                          <span className="px-1.5 sm:px-2 pb-[1px] font-semibold text-sleek-dark text-xs sm:text-sm font-mono min-w-[18px] sm:min-w-[20px] text-center">
                            {getQuantity(cake.id)}
                          </span>
                          <button
                            id={`btn-qty-plus-${cake.id}`}
                            onClick={() => handleAdjustQuantity(cake, 1)}
                            className="px-2 sm:px-3 text-sleek-muted hover:bg-sleek-cream hover:text-sleek-dark h-full transition-colors active:bg-stone-200"
                            aria-label="数量を増やす"
                          >
                            <Plus className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                          </button>
                        </div>

                        <button
                          id={`btn-add-to-cart-${cake.id}`}
                          onClick={() => handleAddClick(cake)}
                          className="bg-sleek-dark hover:bg-black text-white h-8 sm:h-10 px-2.5 sm:px-3.5 rounded-xl transition-all shadow-md flex items-center justify-center gap-1 border border-sleek-border-light shrink-0 active:scale-95 whitespace-nowrap"
                          title="カートに追加"
                        >
                          <ShoppingBag className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-sleek-gold shrink-0" />
                          <span className="text-[11px] sm:text-xs font-semibold">追加</span>
                        </button>
                      </div>
                    )}
                  </div>

                  {limitAlert?.cakeId === cake.id && (
                    <div
                      role="alert"
                      className="text-[11px] font-bold text-red-700 bg-red-50 border border-red-200 rounded-xl px-2.5 py-1.5 flex items-center gap-1.5"
                    >
                      <AlertCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />
                      <span>{limitAlert.message.replace(/^⚠️\s*/, '')}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Details Dialog Overlay popup */}
      <AnimatePresence>
        {selectedCake && (
          <motion.div
            id="cake-detail-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#1A1A1A]/80 backdrop-blur-md flex items-end sm:items-center justify-center p-0 sm:p-4 z-50 overflow-y-auto"
            onClick={() => setSelectedCake(null)}
          >
            <motion.div
              id="cake-detail-modal-card"
              initial={{ scale: 0.95, y: 30 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 30 }}
              transition={{ type: 'spring', damping: 25, stiffness: 350 }}
              className="bg-white rounded-t-3xl sm:rounded-3xl max-w-lg w-full overflow-hidden shadow-2xl border border-sleek-border flex flex-col max-h-[90vh]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header Image */}
              <div className="relative h-48 sm:h-64 bg-sleek-cream shrink-0">
                <img
                  src={selectedCake.imageUrl}
                  alt={selectedCake.jpName}
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    const target = e.currentTarget as HTMLImageElement;
                    if (target.src !== FALLBACK_CAKE_IMAGE) {
                      target.src = FALLBACK_CAKE_IMAGE;
                    }
                  }}
                />
                <button
                  id="btn-close-modal"
                  onClick={() => setSelectedCake(null)}
                  className="absolute top-3 right-3 sm:top-4 sm:right-4 bg-[#1A1A1A]/70 hover:bg-black text-white rounded-full p-2 transition-colors border border-white/20 backdrop-blur-xs font-bold w-8 h-8 sm:w-9 sm:h-9 flex items-center justify-center text-xs"
                >
                  ✕
                </button>
              </div>

              {/* Title & Body */}
              <div className="p-4 sm:p-6 space-y-3.5 sm:space-y-4 overflow-y-auto flex-grow">
                <div>
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="bg-sleek-cream text-sleek-gold border border-sleek-border-light text-[10px] tracking-wider font-bold font-mono px-2.5 py-0.5 rounded-full uppercase">
                      {CATEGORY_LABELS[selectedCake.category as keyof typeof CATEGORY_LABELS]}
                    </span>
                    {(() => {
                      const modalSoldOut = isCakeSoldOutForDate(selectedCake, selectedPickupDate);
                      const modalStock = getEffectiveStockForDate(selectedCake, selectedPickupDate);
                      if (!modalSoldOut && typeof modalStock === 'number' && modalStock > 0 && modalStock <= 10) {
                        return (
                          <span className="text-[10px] font-bold text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-0.5 rounded-full">
                            残りわずかです！
                          </span>
                        );
                      }
                      return null;
                    })()}
                  </div>
                  <h2 className="text-xl sm:text-2xl font-light text-sleek-dark font-serif">
                    {selectedCake.jpName}
                  </h2>
                  <p className="text-[10px] text-sleek-muted font-mono tracking-widest uppercase">
                    {selectedCake.name}
                  </p>
                </div>

                <div className="bg-sleek-cream p-3.5 sm:p-4 rounded-2xl border border-[#F2EDE4]">
                  <h4 className="text-xs font-bold text-sleek-gold mb-1 flex items-center gap-1.5 uppercase tracking-wider font-mono">
                    <Sparkles className="w-3.5 h-3.5 text-sleek-gold fill-sleek-gold/10" />
                    パティシエからのこだわり紹介
                  </h4>
                  <p className="text-sleek-muted text-xs leading-relaxed">
                    {selectedCake.description}
                  </p>
                </div>

                {/* Specifications info list */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 text-[11px] border-t border-b border-sleek-border py-3 sm:py-4 font-sans text-sleek-muted font-light">
                  <div>
                    <span className="text-[10px] text-sleek-muted tracking-wider block mb-0.5 font-mono uppercase">特定原材料（アレルギー表示）</span>
                    <span className="text-sleek-dark font-medium">
                      {(selectedCake.id || '').includes('cheese') ? '乳、小麦、卵' : '卵、小麦、乳、ゼラチン'}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-sleek-muted tracking-wider block mb-0.5 font-mono uppercase">消費期限</span>
                    <span className="text-sleek-dark font-medium">お受け取り当日中（要冷蔵10℃以下）</span>
                  </div>
                  <div className="sm:col-span-2">
                    <span className="text-[10px] text-sleek-muted tracking-wider block mb-0.5 font-mono uppercase">推奨サイズ目安</span>
                    <span className="text-sleek-dark font-medium">
                      {selectedCake.id === 'buche-de-noel'
                        ? '長さ約18cm：3〜5名様分'
                        : selectedCake.id === 'rice-chou'
                        ? '1つ：1名様分'
                        : selectedCake.category === 'cut'
                        ? '1カット：1名様分'
                        : '4号（直径約15cm）：2〜4名様分'}
                    </span>
                  </div>
                </div>

                {limitAlert?.cakeId === selectedCake.id && (
                  <div
                    role="alert"
                    className="text-xs font-bold text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2 flex items-center gap-1.5"
                  >
                    <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
                    <span>{limitAlert.message.replace(/^⚠️\s*/, '')}</span>
                  </div>
                )}

                {/* Close and action */}
                <div className="flex items-center justify-between pt-2 gap-3">
                  <div>
                    <span className="text-[9px] sm:text-[10px] text-sleek-muted block leading-none font-mono tracking-wider uppercase mb-1">価格（税込）</span>
                    <span className="text-2xl sm:text-3xl font-light text-sleek-gold font-serif">
                      ¥{(Number(selectedCake.price) || 0).toLocaleString()}
                    </span>
                  </div>
                  {isCakeSoldOutForDate(selectedCake, selectedPickupDate) ? (
                    <button
                      disabled
                      className="bg-stone-200 text-stone-500 font-bold text-xs tracking-wider uppercase px-4 sm:px-5 py-3 rounded-xl cursor-not-allowed border border-stone-300"
                    >
                      完売（オーダーストップ）
                    </button>
                  ) : (
                    <button
                      id="btn-modal-add-to-cart"
                      onClick={() => {
                        const added = handleAddClick(selectedCake);
                        if (added) {
                          setSelectedCake(null);
                        }
                      }}
                      className="bg-sleek-dark hover:bg-black text-white font-semibold text-xs tracking-wider uppercase px-4 sm:px-5 py-3 rounded-xl transition-all shadow-md flex items-center gap-2 active:scale-95"
                    >
                      <ShoppingBag className="w-4 h-4 text-sleek-gold" />
                      カートに追加
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
