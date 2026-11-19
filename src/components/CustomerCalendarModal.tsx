import React, { useState, useEffect } from 'react';
import { Calendar as CalendarIcon, Clock, AlertTriangle, X, ChevronLeft, ChevronRight, Check } from 'lucide-react';
import { fetchBusinessDays, subscribeToBusinessDays } from '../lib/dbService';

interface CustomerCalendarModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function CustomerCalendarModal({ isOpen, onClose }: CustomerCalendarModalProps) {
  const [businessDays, setBusinessDays] = useState<string[]>([]);
  const [currentMonth, setCurrentMonth] = useState<Date>(new Date());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let isMounted = true;
    setLoading(true);

    const unsubscribe = subscribeToBusinessDays((days) => {
      if (isMounted) {
        setBusinessDays(days);
        setLoading(false);
      }
    });

    async function loadData() {
      try {
        const days = await fetchBusinessDays();
        if (isMounted) {
          setBusinessDays(days);
        }
      } catch (err) {
        console.error('Failed to load business days:', err);
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }
    loadData();

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth(); // 0-based

  // Calculate calendar days (Monday-start calendar layout for consistency/cleanness)
  const firstDay = new Date(year, month, 1);
  const startDayOfWeek = firstDay.getDay(); // 0 (Sun) to 6 (Sat)
  const startMondayIndex = startDayOfWeek === 0 ? 6 : startDayOfWeek - 1;
  const totalDays = new Date(year, month + 1, 0).getDate();

  const days: (number | null)[] = [];
  
  // Empty spaces before the first day of the month
  for (let i = 0; i < startMondayIndex; i++) {
    days.push(null);
  }
  
  // Fill the days
  for (let d = 1; d <= totalDays; d++) {
    days.push(d);
  }

  const weekDays = ['月', '火', '水', '木', '金', '土', '日'];

  // JST time helper
  const getJstToday = () => {
    return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  };

  const today = getJstToday();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const handlePrevMonth = () => {
    setCurrentMonth(new Date(year, month - 1, 1));
  };

  const handleNextMonth = () => {
    setCurrentMonth(new Date(year, month + 1, 1));
  };

  const monthLabel = `${year}年 ${month + 1}月`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2.5 sm:p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-stone-900/50 backdrop-blur-xs transition-opacity" 
        onClick={onClose} 
      />

      {/* Modal Content */}
      <div className="relative bg-white w-full max-w-lg rounded-2xl sm:rounded-3xl overflow-hidden shadow-2xl border border-sleek-border animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[92vh]">
        
        {/* Header */}
        <div className="bg-sleek-dark text-white px-4 sm:px-6 py-3.5 sm:py-5 flex items-center justify-between gap-2 relative">
          <div className="space-y-0.5 sm:space-y-1 min-w-0">
            <div className="flex items-center gap-1.5 text-sleek-gold text-[9px] sm:text-[10px] font-bold tracking-widest uppercase font-mono whitespace-nowrap">
              <CalendarIcon className="w-3.5 h-3.5 shrink-0" />
              <span>Happy Café Information</span>
            </div>
            <h3 className="text-sm sm:text-lg font-serif font-light tracking-wide text-white whitespace-nowrap">ケーキお受取り（営業日）カレンダー</h3>
          </div>
          <button 
            type="button" 
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 transition-all flex items-center justify-center text-stone-300 hover:text-white shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Info Strip (Business hours 11:30~15:00 & 3-day rule banner) */}
        <div className="bg-sleek-cream border-b border-sleek-border px-3.5 sm:px-6 py-3 sm:py-4 space-y-2 text-xs">
          <div className="flex items-start gap-2 text-sleek-dark">
            <Clock className="w-4 h-4 text-sleek-gold shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-stone-900 text-xs sm:text-sm whitespace-nowrap">
                営業時間：<span className="font-bold text-sleek-gold font-mono">11:30〜15:00</span>
              </p>
              <p className="text-[10px] sm:text-[11px] text-sleek-muted leading-relaxed">
                <span className="inline-block">※上記時間帯に Happy Café（ハッピー製菓調理専門学校 1F）</span>
                <span className="inline-block">店舗にて直接お渡しします。</span>
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2 text-amber-900 border-t border-sleek-border/40 pt-2">
            <AlertTriangle className="w-4 h-4 text-sleek-gold shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-amber-950 text-xs whitespace-nowrap">
                ご予約はお受取り希望日の<span className="font-black underline font-serif">3日前まで</span>
              </p>
              <p className="text-[10px] sm:text-[11px] text-stone-600 leading-relaxed">
                <span className="inline-block">仕込みと準備のため、受取日の3日前の23:59をもって</span>
                <span className="inline-block">自動で予約受付を締め切らせていただきます。</span>
              </p>
            </div>
          </div>
        </div>

        {/* Scrollable calendar view section */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-grow space-y-4 sm:space-y-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 space-y-3">
              <div className="w-8 h-8 border-3 border-sleek-gold border-t-transparent rounded-full animate-spin"></div>
              <p className="text-xs text-sleek-muted font-mono">営業スケジュールを読み込み中...</p>
            </div>
          ) : (
            <div className="space-y-4">
              
              {/* Calendar Navigator */}
              <div className="flex items-center justify-between">
                <span className="font-serif font-medium text-sleek-dark text-sm sm:text-base tracking-wider">{monthLabel}</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={handlePrevMonth}
                    className="p-1.5 sm:p-2 hover:bg-sleek-cream text-sleek-muted hover:text-sleek-dark rounded-xl border border-sleek-border transition-all"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setCurrentMonth(new Date())}
                    className="px-2.5 sm:px-3 py-1.5 hover:bg-sleek-cream text-sleek-muted hover:text-sleek-dark text-[10px] font-bold tracking-wider uppercase rounded-xl border border-sleek-border transition-all"
                  >
                    今月
                  </button>
                  <button
                    type="button"
                    onClick={handleNextMonth}
                    className="p-1.5 sm:p-2 hover:bg-sleek-cream text-sleek-muted hover:text-sleek-dark rounded-xl border border-sleek-border transition-all"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Day headers starting Monday */}
              <div className="grid grid-cols-7 text-center border-b border-sleek-border pb-1.5">
                {weekDays.map((wd, idx) => (
                  <span
                    key={wd}
                    className={`text-[10px] sm:text-xs font-bold tracking-wider font-mono ${
                      idx === 5 ? 'text-blue-500/80' : idx === 6 ? 'text-red-500/80' : 'text-sleek-muted'
                    }`}
                  >
                    {wd}
                  </span>
                ))}
              </div>

              {/* Day cells */}
              <div className="grid grid-cols-7 gap-1 sm:gap-2">
                {days.map((day, idx) => {
                  if (day === null) {
                    return <div key={`empty-${idx}`} className="aspect-square" />;
                  }

                  const formattedDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  const isSelected = businessDays.includes(formattedDate);
                  const isPast = formattedDate < todayStr;
                  const isToday = formattedDate === todayStr;

                  // Calculate booking deadline
                  const diffMs = new Date(formattedDate + "T00:00:00+09:00").getTime() - new Date(todayStr + "T00:00:00+09:00").getTime();
                  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
                  const isClosed = isSelected && diffDays < 3;

                  return (
                    <div
                      key={`day-${day}`}
                      className={`aspect-square rounded-lg sm:rounded-xl flex flex-col items-center justify-between p-1 sm:p-1.5 border text-xs font-semibold relative select-none ${
                        isSelected
                          ? isClosed
                            ? 'bg-amber-50 text-amber-900 border-amber-200'
                            : 'bg-emerald-50 text-emerald-950 border-emerald-200 ring-1 ring-emerald-100'
                          : 'bg-white border-transparent text-stone-300'
                      } ${isPast ? 'opacity-40 bg-stone-50' : ''}`}
                    >
                      <span className={`text-[11px] sm:text-xs ${isToday ? 'border-b-2 border-sleek-gold font-bold px-0.5 text-sleek-dark' : 'text-sleek-dark'}`}>
                        {day}
                      </span>
                      
                      {isSelected && (
                        <span className={`text-[7px] sm:text-[8px] font-black tracking-tighter block leading-none ${isClosed ? 'text-amber-800 font-medium' : 'text-emerald-700 font-bold'}`}>
                          {isClosed ? '締切' : '受取可'}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Legends explanation row */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-sleek-border text-[9px] sm:text-[10px] text-sleek-muted">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-sm bg-emerald-50 border border-emerald-200 shrink-0" />
                    <span className="text-emerald-800 font-semibold">受付中 (受取可)</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-sm bg-amber-50 border border-amber-200 shrink-0" />
                    <span className="text-amber-800 font-semibold">受付終了 (締切済)</span>
                  </span>
                </div>
              </div>

            </div>
          )}
        </div>

        {/* Modal Actions Footer */}
        <div className="bg-stone-50 border-t border-sleek-border px-4 sm:px-6 py-3 sm:py-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="w-full sm:w-auto bg-sleek-dark hover:bg-black text-white font-semibold px-6 py-2.5 rounded-xl text-xs uppercase tracking-wider transition-all shadow-md flex items-center justify-center gap-1.5 active:scale-95"
          >
            <Check className="w-3.5 h-3.5 text-sleek-gold" />
            <span>閉じる</span>
          </button>
        </div>

      </div>
    </div>
  );
}
