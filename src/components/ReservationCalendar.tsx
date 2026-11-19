import React from 'react';
import { Reservation } from '../types';
import { Calendar } from 'lucide-react';

interface ReservationCalendarProps {
  reservations: Reservation[];
  selectedDate: string | null;
  onSelectDate: (date: string | null) => void;
  currentMonth: Date;
  setCurrentMonth: React.Dispatch<React.SetStateAction<Date>>;
}

export default function ReservationCalendar({
  reservations,
  selectedDate,
  onSelectDate,
  currentMonth,
  setCurrentMonth,
}: ReservationCalendarProps) {
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth(); // 0-based

  // Calculate calendar days
  const firstDay = new Date(year, month, 1);
  const startDayOfWeek = firstDay.getDay(); // 0 (Sun) to 6 (Sat)
  const totalDays = new Date(year, month + 1, 0).getDate();

  // Array for calendar grid
  const days: (number | null)[] = [];
  
  // Fill initial blank spaces
  for (let i = 0; i < startDayOfWeek; i++) {
    days.push(null);
  }
  
  // Fill days of the month
  for (let d = 1; d <= totalDays; d++) {
    days.push(d);
  }

  const weekDays = ['日', '月', '火', '水', '木', '金', '土'];

  const handlePrevMonth = () => {
    setCurrentMonth(new Date(year, month - 1, 1));
  };

  const handleNextMonth = () => {
    setCurrentMonth(new Date(year, month + 1, 1));
  };

  const handleCurrentMonth = () => {
    setCurrentMonth(new Date());
  };

  const monthLabel = `${year}年 ${month + 1}月`;

  return (
    <div className="bg-white rounded-2xl p-3 sm:p-4 border border-sleek-border shadow-xs space-y-3">
      {/* Header control area */}
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-serif font-medium text-sleek-dark text-xs sm:text-sm flex items-center gap-1.5">
          <Calendar className="w-3.5 h-3.5 text-sleek-gold shrink-0" />
          <span>{monthLabel} の予約</span>
        </h4>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={handlePrevMonth}
            className="p-1 px-2 bg-white hover:bg-sleek-bg rounded-lg text-sleek-muted hover:text-sleek-dark text-[11px] transition-all border border-sleek-border"
          >
            前月
          </button>
          <button
            type="button"
            onClick={handleCurrentMonth}
            className="p-1 px-2 bg-white hover:bg-sleek-bg rounded-lg text-sleek-muted hover:text-sleek-dark text-[11px] transition-all border border-sleek-border font-medium font-sans"
          >
            今月
          </button>
          <button
            type="button"
            onClick={handleNextMonth}
            className="p-1 px-2 bg-white hover:bg-sleek-bg rounded-lg text-sleek-muted hover:text-sleek-dark text-[11px] transition-all border border-sleek-border"
          >
            翌月
          </button>
        </div>
      </div>

      {/* Week Header Row */}
      <div className="grid grid-cols-7 text-center border-b border-sleek-border pb-1">
        {weekDays.map((wd, idx) => (
          <span
            key={idx}
            className={`text-[9px] sm:text-[10px] font-bold tracking-wider font-mono ${
              idx === 0 ? 'text-red-500/70' : idx === 6 ? 'text-blue-500/70' : 'text-sleek-muted'
            }`}
          >
            {wd}
          </span>
        ))}
      </div>

      {/* Grid cells */}
      <div className="grid grid-cols-7 gap-1">
        {days.map((day, idx) => {
          if (day === null) {
            return <div key={`empty-${idx}`} className="aspect-square" />;
          }

          const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          
          // Filter reservations specifically for this date representation
          const dayReservations = reservations.filter(res => res.date === dateStr);
          const hasReservations = dayReservations.length > 0;
          const isSelected = selectedDate === dateStr;

          // Check if today
          const today = new Date();
          const isToday =
            today.getFullYear() === year &&
            today.getMonth() === month &&
            today.getDate() === day;

          return (
            <button
              key={`day-${day}`}
              type="button"
              onClick={() => onSelectDate(isSelected ? null : dateStr)}
              className={`aspect-square rounded-lg flex flex-col items-center justify-between p-0.5 sm:p-1 relative transition-all border ${
                isSelected
                  ? 'bg-sleek-dark text-white border-sleek-dark ring-1 ring-sleek-gold/50 shadow-xs'
                  : hasReservations
                  ? 'bg-amber-50/80 border-amber-200 hover:bg-amber-100 text-amber-900'
                  : 'bg-white border-transparent hover:bg-sleek-bg text-sleek-text'
              }`}
            >
              <span
                className={`text-[10px] sm:text-[11px] font-medium leading-none ${
                  isToday && !isSelected
                    ? 'border-b border-sleek-gold text-sleek-gold font-bold'
                    : ''
                }`}
              >
                {day}
              </span>

              {hasReservations && (
                <div className="flex items-center justify-center">
                  <span className={`text-[8px] font-bold font-mono leading-none ${isSelected ? 'text-amber-300' : 'text-amber-800'}`}>
                    {dayReservations.length}件
                  </span>
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Footer calendar legend & selected date status */}
      <div className="pt-2 border-t border-sleek-border space-y-2">
        <div className="flex items-center justify-between gap-2 text-[10px] sm:text-[11px] text-sleek-muted">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs bg-amber-50 border border-amber-300" />
              <span>予約あり</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-xs bg-sleek-dark" />
              <span>選択中</span>
            </span>
          </div>
          {selectedDate && (
            <button
              type="button"
              onClick={() => onSelectDate(null)}
              className="text-sleek-gold hover:text-amber-700 underline font-bold cursor-pointer"
            >
              選択解除（全件表示）
            </button>
          )}
        </div>

        <div className={`px-2.5 py-1.5 rounded-lg text-[10px] sm:text-[11px] flex items-center justify-between ${
          selectedDate
            ? 'bg-amber-50/90 text-amber-950 border border-amber-200 font-medium'
            : 'bg-stone-50 text-stone-500 border border-stone-200/70'
        }`}>
          {selectedDate ? (
            <>
              <span>📅 選択日：<strong className="font-mono">{selectedDate}</strong></span>
              <span className="font-mono font-bold text-amber-800">
                {reservations.filter(r => r.date === selectedDate).length}件表示中
              </span>
            </>
          ) : (
            <span>日付をタップするとその日の予約詳細に絞り込めます</span>
          )}
        </div>
      </div>
    </div>
  );
}
