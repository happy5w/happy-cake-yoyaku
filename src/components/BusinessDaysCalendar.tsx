import React, { useState, useEffect } from 'react';
import { Calendar as CalendarIcon, Check, HelpCircle, Save } from 'lucide-react';
import { fetchBusinessDays, saveBusinessDays, subscribeToBusinessDays } from '../lib/dbService';

interface BusinessDaysCalendarProps {
  onSaved: () => void;
}

export default function BusinessDaysCalendar({ onSaved }: BusinessDaysCalendarProps) {
  const [selectedDays, setSelectedDays] = useState<string[]>([]);
  const [lastSavedDays, setLastSavedDays] = useState<string[]>([]);
  const [currentMonth, setCurrentMonth] = useState<Date>(new Date());
  const [isInitializing, setIsInitializing] = useState(true);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Load registered business days and subscribe to real-time cloud updates
  useEffect(() => {
    let isMounted = true;
    const unsubscribe = subscribeToBusinessDays((days) => {
      if (isMounted) {
        setSelectedDays(days);
        setLastSavedDays(days);
        setIsInitializing(false);
      }
    });

    async function loadData() {
      try {
        const days = await fetchBusinessDays();
        if (isMounted) {
          setSelectedDays(days);
          setLastSavedDays(days);
        }
      } catch (err) {
        console.error('Failed to fetch initial business days:', err);
      } finally {
        if (isMounted) {
          setIsInitializing(false);
        }
      }
    }
    loadData();

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  const handleSave = async () => {
    setSyncStatus('saving');
    try {
      await saveBusinessDays(selectedDays);
      setLastSavedDays([...selectedDays]);
      setSyncStatus('saved');
      onSaved();
      setTimeout(() => {
        setSyncStatus('idle');
      }, 2500);
    } catch (err) {
      console.warn('Notice while saving business days:', err);
      // Fallback: localStorage is saved by saveBusinessDays
      setLastSavedDays([...selectedDays]);
      setSyncStatus('saved');
      onSaved();
      setTimeout(() => {
        setSyncStatus('idle');
      }, 2500);
    }
  };

  const hasUnsavedChanges = JSON.stringify([...selectedDays].sort()) !== JSON.stringify([...lastSavedDays].sort());

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth(); // 0-based

  // Calculate calendar days
  const firstDay = new Date(year, month, 1);
  const startDayOfWeek = firstDay.getDay(); // 0 (Sun) to 6 (Sat)
  
  // Convert standard Sunday = 0-6 to Monday = 0-6
  // Sun(0) -> 6, Mon(1) -> 0, Tue(2) -> 1, Wed(3) -> 2, Thu(4) -> 3, Fri(5) -> 4, Sat(6) -> 5
  const startMondayIndex = startDayOfWeek === 0 ? 6 : startDayOfWeek - 1;
  const totalDays = new Date(year, month + 1, 0).getDate();

  // Array for calendar grid
  const days: (number | null)[] = [];
  
  // Fill initial blank spaces for Monday-start calendar
  for (let i = 0; i < startMondayIndex; i++) {
    days.push(null);
  }
  
  // Fill days of the month
  for (let d = 1; d <= totalDays; d++) {
    days.push(d);
  }

  // Weekdays header starting with Monday (月曜日始まり)
  const weekDays = ['月', '火', '水', '木', '金', '土', '日'];

  const handlePrevMonth = () => {
    setCurrentMonth(new Date(year, month - 1, 1));
  };

  const handleNextMonth = () => {
    setCurrentMonth(new Date(year, month + 1, 1));
  };

  const handleDayToggle = (dateStr: string) => {
    const nextDays = selectedDays.includes(dateStr)
      ? selectedDays.filter(d => d !== dateStr)
      : [...selectedDays, dateStr].sort();

    setSelectedDays(nextDays);
    // Immediately persist to cloud & localStorage so changes are never left unsaved
    setSyncStatus('saving');
    saveBusinessDays(nextDays)
      .then(() => {
        setLastSavedDays([...nextDays]);
        setSyncStatus('saved');
        onSaved();
        setTimeout(() => {
          setSyncStatus((prev) => (prev === 'saved' ? 'idle' : prev));
        }, 2000);
      })
      .catch((err) => {
        console.warn('Auto-save business days notice:', err);
        setLastSavedDays([...nextDays]);
        setSyncStatus('saved');
      });
  };

  // Helper inside JST boundary for "today"
  const getJstToday = () => {
    return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  };

  const today = getJstToday();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const monthLabel = `${year}年 ${month + 1}月`;

  return (
    <div id="business-days-setting-panel" className="bg-white rounded-3xl p-6 border border-sleek-border shadow-xs space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-sleek-border pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-sleek-cream flex items-center justify-center text-sleek-gold border border-sleek-border-light">
            <CalendarIcon className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-serif font-light text-sleek-dark text-lg md:text-xl">営業日（受取可能日）設定</h3>
            <p className="text-xs text-sleek-muted">
              お客様がケーキのご予約を受け取れる営業日を設定します（トグル選択・月曜始まり表示）。
            </p>
          </div>
        </div>
        
        {/* Real-time Save buttons and status badges */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          {hasUnsavedChanges && syncStatus === 'idle' && (
            <span className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-xl font-medium text-center animate-pulse">
              ⚠️ 未保存の変更があります
            </span>
          )}
          {syncStatus === 'saved' && (
            <span className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-xl font-semibold text-center flex items-center justify-center gap-1 animate-fade-in">
              <Check className="w-3.5 h-3.5 text-emerald-600 font-bold" />
              保存しました！
            </span>
          )}
          {syncStatus === 'error' && (
            <span className="text-[11px] text-red-650 bg-red-50 border border-red-200 px-3 py-1.5 rounded-xl font-semibold text-center">
              保存に失敗しました。再試行してください
            </span>
          )}

          <button
            onClick={handleSave}
            disabled={syncStatus === 'saving' || isInitializing}
            className={`font-semibold px-5 py-2.5 rounded-xl text-xs uppercase tracking-widest flex items-center justify-center gap-1.5 transition-all shadow-xs ${
              syncStatus === 'saving'
                ? 'bg-[#B5853B]/20 text-[#B5853B] border border-[#B5853B]/30 cursor-not-allowed'
                : hasUnsavedChanges
                ? 'bg-[#D2A052] hover:bg-[#B5853B] text-white border border-[#D2A052] active:scale-98 cursor-pointer shadow-sm animate-pulse-subtle'
                : 'bg-sleek-dark hover:bg-black text-white border border-sleek-dark active:scale-98 cursor-pointer'
            }`}
          >
            {syncStatus === 'saving' ? (
              <>
                <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-[#D2A052]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>保存中...</span>
              </>
            ) : (
              <>
                <Save className="w-3.5 h-3.5" />
                <span>設定を保存</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Info Warning banner block */}
      <div className="bg-amber-50/50 border border-amber-100 rounded-2xl p-4 text-xs text-amber-900 leading-relaxed space-y-1">
        <p className="font-bold flex items-center gap-1.5 text-amber-850">
          <HelpCircle className="w-4 h-4 text-sleek-gold shrink-0" />
          💡 3日前自動予約締め切りルールについて
        </p>
        <p className="text-stone-700">
          ここで設定された営業日は、その営業日当日から起算して<strong className="text-sleek-dark font-bold">3日前の段階で自動的に予約が締め切られ</strong>、お客様の画面（カレンダー選択画面）から自動で非表示または非活性になります。
          <br />
          <em>例: 12月24日を営業日に設定した場合、3日前にあたる12月21日の23:59までで予約は締め切られ、12月22日以降は予約出来なくなります。</em>
        </p>
      </div>

      {/* Selector and Calendar Grid wrapper */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
        {/* Left column: Calendar View (Span 7) */}
        <div className="md:col-span-7 bg-sleek-bg/40 p-4 rounded-2xl border border-sleek-border/40 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-semibold text-xs uppercase tracking-wider text-sleek-dark">{monthLabel}</h4>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handlePrevMonth}
                className="p-1 px-2 text-sleek-muted hover:text-sleek-dark hover:bg-white rounded border border-sleek-border text-[10px] transition-all"
              >
                先月
              </button>
              <button
                type="button"
                onClick={() => setCurrentMonth(new Date())}
                className="p-1 px-2 text-sleek-muted hover:text-sleek-dark hover:bg-white rounded border border-sleek-border text-[10px] transition-all"
              >
                今月
              </button>
              <button
                type="button"
                onClick={handleNextMonth}
                className="p-1 px-2 text-sleek-muted hover:text-sleek-dark hover:bg-white rounded border border-sleek-border text-[10px] transition-all"
              >
                翌月
              </button>
            </div>
          </div>

          {/* Weekday Row Header starting with Monday */}
          <div className="grid grid-cols-7 text-center border-b border-sleek-border pb-1.5">
            {weekDays.map((wd, index) => (
              <span
                key={wd}
                className={`text-[10px] font-bold tracking-wider font-mono ${
                  index === 5 ? 'text-blue-500/70' : index === 6 ? 'text-red-500/70' : 'text-sleek-muted'
                }`}
              >
                {wd}
              </span>
            ))}
          </div>

          {/* Calendar Day grid */}
          <div className="grid grid-cols-7 gap-1.5">
            {days.map((day, idx) => {
              if (day === null) {
                return <div key={`empty-${idx}`} className="aspect-square" />;
              }

              const formattedDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              const isSelected = selectedDays.includes(formattedDate);
              const isPast = formattedDate < todayStr;
              const isToday = formattedDate === todayStr;

              // Calculate days until booking deadline
              const diffMs = new Date(formattedDate + "T00:00:00+09:00").getTime() - new Date(todayStr + "T00:00:00+09:00").getTime();
              const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
              const isClosed = isSelected && diffDays < 3;

              return (
                <button
                  key={`day-${day}`}
                  type="button"
                  onClick={() => handleDayToggle(formattedDate)}
                  className={`aspect-square rounded-xl flex flex-col items-center justify-between p-1.5 relative transition-all border text-xs font-semibold ${
                    isSelected
                      ? isClosed
                        ? 'bg-amber-100 hover:bg-amber-20s border-amber-300 text-amber-900 ring-1 ring-amber-200'
                        : 'bg-sleek-dark hover:bg-black border-sleek-dark text-white shadow-sm'
                      : 'bg-white border-sleek-border/40 hover:bg-sleek-cream text-sleek-text'
                  } ${isPast ? 'opacity-40 cursor-not-allowed bg-stone-50' : 'cursor-pointer'}`}
                >
                  <span className={isToday ? 'border-b-2 border-sleek-gold font-bold px-0.5' : ''}>{day}</span>
                  
                  {isSelected && (
                    <span className="text-[8px] font-bold font-mono tracking-tighter block leading-none">
                      {isClosed ? '締切済' : '営業日'}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Right column: Selected list & Status summary (Span 5) */}
        <div className="md:col-span-5 bg-sleek-cream/30 p-4 rounded-2xl border border-sleek-border/40 space-y-4 text-xs">
          <h4 className="font-semibold text-xs text-sleek-dark uppercase tracking-wider flex items-center gap-1.5 border-b border-sleek-border pb-2">
            <span>設定済みの営業日一覧 ({selectedDays.length}日間)</span>
          </h4>

          {selectedDays.length === 0 ? (
            <p className="text-xs text-sleek-muted italic text-center py-6">
              営業日が設定されていません。左のカレンダーから選択してください。
            </p>
          ) : (
            <div className="max-h-56 overflow-y-auto space-y-1.5 pr-1 divide-y divide-sleek-border/20">
              {selectedDays.map(dateStr => {
                const isPast = dateStr < todayStr;
                // Deadline computation
                const diffMs = new Date(dateStr + "T00:00:00+09:00").getTime() - new Date(todayStr + "T00:00:00+09:00").getTime();
                const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
                const isClosed = diffDays < 3;

                return (
                  <div key={dateStr} className="flex items-center justify-between py-1.5 first:pt-0">
                    <span className={`font-mono text-xs font-medium ${isPast ? 'line-through text-sleek-muted' : ''}`}>
                      {dateStr}
                    </span>
                    <div className="flex items-center gap-1.5 text-[10px] shrink-0">
                      {isPast ? (
                        <span className="text-stone-400 bg-stone-100 px-2 py-0.5 rounded-full">過去</span>
                      ) : isClosed ? (
                        <span className="text-amber-800 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-100 font-bold">予約締切</span>
                      ) : (
                        <span className="text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-155 font-bold">予約受付中 (残り{diffDays - 3}日)</span>
                      )}
                      <button
                        type="button"
                        onClick={() => handleDayToggle(dateStr)}
                        className="text-red-500 hover:text-red-700 hover:underline px-1 py-0.5"
                      >
                        削除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
