import React, { useState } from 'react';
import { Reservation } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { 
  CheckCircle2, 
  Mail, 
  Calendar, 
  Clock, 
  User, 
  Phone, 
  ShoppingBag, 
  Copy, 
  Check, 
  Printer, 
  X, 
  Send, 
  FileText, 
  ExternalLink,
  Sparkles,
  Info
} from 'lucide-react';

interface ReservationSuccessModalProps {
  isOpen: boolean;
  onClose: () => void;
  reservation: Reservation | null;
  onReturnToCatalog?: () => void;
  onToast?: (message: string) => void;
}

export default function ReservationSuccessModal({
  isOpen,
  onClose,
  reservation,
  onReturnToCatalog,
  onToast
}: ReservationSuccessModalProps) {
  const [activeView, setActiveView] = useState<'details' | 'email'>('details');
  const [copied, setCopied] = useState(false);

  if (!isOpen || !reservation) return null;

  // Format date with Japanese day of week
  const getFormattedDateWithDay = (dateStr: string) => {
    try {
      const parts = dateStr.split('-').map(Number);
      if (parts.length !== 3) return dateStr;
      const d = new Date(parts[0], parts[1] - 1, parts[2]);
      const days = ['日', '月', '火', '水', '木', '金', '土'];
      return `${parts[0]}年${parts[1]}月${parts[2]}日 (${days[d.getDay()]})`;
    } catch {
      return dateStr;
    }
  };

  const formattedDate = getFormattedDateWithDay(reservation.date);
  const nowStr = new Date().toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });

  // Generate plain text reservation receipt for customer copy/save
  const receiptTitle = '【Happy Café】ケーキご予約控え（お客様保存用）';

  const generateReceiptText = () => {
    const itemsText = (reservation.items || []).map((item, idx) => 
      `  ${idx + 1}. ${item.cakeName} × ${item.quantity}個 (¥${(Number(item.price) || 0).toLocaleString()} / 単価) = ¥${((Number(item.price) || 0) * (Number(item.quantity) || 0)).toLocaleString()}`
    ).join('\n');

    return `${receiptTitle}
受付日時: ${nowStr}
ご予約者様: ${reservation.name} 様

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【Happy Café】ケーキご予約内容控え
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

■ ご予約内容
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【お名前】: ${reservation.name} 様 ${reservation.nameKana ? `(${reservation.nameKana})` : ''}
【お電話番号】: ${reservation.phone}
【メールアドレス】: ${reservation.email}
【お受取日時】: ${formattedDate} ${reservation.time}

■ ご注文内訳
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${itemsText}
${reservation.notes ? `  ・備考連絡: ${reservation.notes}\n` : ''}----------------------------------------------------
【お会計合計】: ¥${(Number(reservation.totalPrice) || 0).toLocaleString()} (税込・店頭払い)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

■ 当日のお受け取りについて
・ご予約日時に店頭までお越しいただき、スタッフにお名前「${reservation.name} 様」をお伝えください。
・お代金はお受け取り時に店頭レジにてお支払いをお願いいたします。

■ ご予約の確認・キャンセルについて
・予約サイトの「予約確認・変更」画面にて、12/18（金）の締切までは予約内容の確認やキャンセルが可能です。
・締切後のキャンセル・変更はWebからは行えませんので、お電話のみで承ります。
・ご入力いただいたお電話番号へ、事前に確認の連絡を入れる場合がございます。

────────────────────────────
Happy Café (ハッピー製菓調理専門学校 1F)
〒260-0021 千葉県千葉市中央区新宿2-6-21
TEL: 043-239-2520（受付時間：平日 9：00～17：30）
※事前に確認の連絡を入れる場合がございます。
────────────────────────────
※確認メールの自動送信は行っておりませんので、こちらの控えまたはスクリーンショットを大切に保管してください。`;
  };

  const handleCopyReceipt = () => {
    navigator.clipboard.writeText(generateReceiptText()).then(() => {
      setCopied(true);
      if (onToast) onToast('📋 予約控えテキストをクリップボードにコピーしました');
      setTimeout(() => setCopied(false), 3000);
    });
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <AnimatePresence>
      <div 
        id="reservation-success-modal-backdrop"
        className="fixed inset-0 z-50 bg-stone-950/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-5 overflow-y-auto"
        onClick={onClose}
      >
        <motion.div
          id="reservation-success-modal-card"
          initial={{ opacity: 0, scale: 0.94, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.94, y: 16 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          onClick={(e) => e.stopPropagation()}
          className="bg-white rounded-3xl w-full max-w-2xl my-auto shadow-2xl border border-stone-200 overflow-hidden flex flex-col max-h-[92vh]"
        >
          {/* Header Banner */}
          <div className="bg-gradient-to-r from-stone-900 via-stone-850 to-stone-900 text-white p-4 sm:p-6 relative shrink-0">
            <button
              onClick={onClose}
              className="absolute top-4 right-4 text-stone-400 hover:text-white p-1 rounded-full hover:bg-stone-800 transition-colors cursor-pointer"
              title="閉じる"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-start gap-3.5 pr-8">
              <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-emerald-500/20 border border-emerald-400/30 flex items-center justify-center text-emerald-400 shrink-0">
                <CheckCircle2 className="w-6 h-6 sm:w-7 sm:h-7" />
              </div>
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] sm:text-xs font-mono font-bold bg-emerald-500 text-white px-2 py-0.5 rounded-full uppercase tracking-wider">
                    予約確定
                  </span>
                </div>
                <h2 className="text-base sm:text-xl font-bold font-serif text-white tracking-tight">
                  ご予約が完了いたしました！
                </h2>
                <p className="text-[11px] sm:text-xs text-stone-300 leading-snug">
                  {reservation.name} 様、ご予約ありがとうございます。当日店頭にてお待ちしております。
                </p>
              </div>
            </div>

            {/* Honest On-Screen Receipt Guidance Banner */}
            <div className="mt-3.5 sm:mt-4 bg-amber-950/60 border border-amber-400/50 rounded-2xl p-3 sm:p-3.5 text-xs text-amber-100 flex items-start gap-3 shadow-inner">
              <div className="w-7 h-7 rounded-xl bg-amber-600 text-white flex items-center justify-center shrink-0 mt-0.5">
                <FileText className="w-4 h-4" />
              </div>
              <div className="space-y-0.5 min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <strong className="font-bold text-white text-xs sm:text-sm">
                    ご予約控え（画面保存・メモ用）
                  </strong>
                  <span className="text-[10px] font-mono bg-emerald-800/80 text-emerald-200 border border-emerald-600/60 px-2 py-0.2 rounded-full">
                    予約登録完了
                  </span>
                </div>
                <p className="text-[11px] text-amber-100/95 leading-relaxed">
                  ※確認メールの自動送信は行っておりません。画面のスクリーンショット・下の「予約控えをコピー」・印刷などで保管いただくか、「予約確認・変更」画面（<span className="font-bold text-white underline underline-offset-2 break-all">{reservation.email}</span>）からいつでも確認できます。
                </p>
              </div>
            </div>
          </div>

          {/* View Toggle Tabs */}
          <div className="bg-stone-100/80 border-b border-stone-200 px-4 sm:px-6 pt-3 flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setActiveView('details')}
              className={`px-4 py-2 text-xs sm:text-sm font-bold border-b-2 transition-all flex items-center gap-1.5 cursor-pointer ${
                activeView === 'details'
                  ? 'border-amber-600 text-stone-900 bg-white rounded-t-xl shadow-2xs'
                  : 'border-transparent text-stone-600 hover:text-stone-900'
              }`}
            >
              <ShoppingBag className="w-4 h-4 text-amber-600" />
              <span>ご予約内容・詳細</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveView('email')}
              className={`px-4 py-2 text-xs sm:text-sm font-bold border-b-2 transition-all flex items-center gap-1.5 cursor-pointer ${
                activeView === 'email'
                  ? 'border-emerald-600 text-emerald-950 bg-white rounded-t-xl shadow-2xs'
                  : 'border-transparent text-stone-600 hover:text-stone-900'
              }`}
            >
              <FileText className="w-4 h-4 text-emerald-600" />
              <span>予約控えテキスト（保存用）</span>
            </button>
          </div>

          {/* Scrollable Body Content */}
          <div className="p-4 sm:p-6 overflow-y-auto space-y-4 text-stone-800 flex-1">
            {activeView === 'details' ? (
              <div className="space-y-4">
                {/* Pickup Schedule Banner */}
                <div className="bg-amber-50/70 border border-amber-200/90 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-center sm:text-left">
                  <div className="space-y-1">
                    <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-amber-800 block">
                      お受取り日時
                    </span>
                    <h3 className="text-base sm:text-xl font-bold font-serif text-amber-950 flex items-center justify-center sm:justify-start gap-2">
                      <Calendar className="w-5 h-5 text-amber-600 shrink-0" />
                      <span>{formattedDate}</span>
                      <span className="bg-amber-200/70 text-amber-950 text-xs sm:text-sm px-2.5 py-0.5 rounded-lg font-mono">
                        {reservation.time}
                      </span>
                    </h3>
                  </div>

                  <div className="bg-white/90 border border-amber-200 rounded-xl p-2.5 sm:px-4 text-xs font-semibold text-stone-800 self-center sm:self-auto text-right">
                    <span className="text-[10px] text-stone-500 block">お支払い合計（店頭払い）</span>
                    <span className="text-base sm:text-lg font-bold font-serif text-amber-700">
                      ¥{(Number(reservation.totalPrice) || 0).toLocaleString()}
                    </span>
                    <span className="text-[10px] text-stone-500 font-normal ml-1">（税込）</span>
                  </div>
                </div>

                {/* Customer Information Grid */}
                <div className="bg-stone-50 rounded-2xl p-4 border border-stone-200 space-y-2.5 text-xs">
                  <h4 className="text-[10px] font-mono font-bold text-stone-500 uppercase tracking-wider">
                    お客様情報
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                    <div className="flex items-center gap-2">
                      <User className="w-4 h-4 text-stone-400 shrink-0" />
                      <div>
                        <span className="text-[10px] text-stone-500 block">氏名</span>
                        <strong className="text-stone-900 text-xs sm:text-sm">
                          {reservation.name} 様
                          {reservation.nameKana && (
                            <span className="text-xs text-stone-500 font-normal ml-1 font-sans">
                              ({reservation.nameKana})
                            </span>
                          )}
                        </strong>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Phone className="w-4 h-4 text-stone-400 shrink-0" />
                      <div>
                        <span className="text-[10px] text-stone-500 block">電話番号</span>
                        <span className="font-mono text-stone-900 font-semibold">{reservation.phone}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 sm:col-span-2">
                      <Mail className="w-4 h-4 text-stone-400 shrink-0" />
                      <div className="min-w-0">
                        <span className="text-[10px] text-stone-500 block">ご連絡先メールアドレス</span>
                        <span className="font-mono text-stone-900 font-semibold break-all">{reservation.email}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Ordered Items Table */}
                <div className="bg-white rounded-2xl border border-stone-200 shadow-2xs overflow-hidden">
                  <div className="bg-stone-100/90 px-4 py-2.5 border-b border-stone-200 flex items-center justify-between text-xs font-bold text-stone-700">
                    <span>ご注文ケーキ内訳</span>
                    <span>数量 / 金額</span>
                  </div>
                  <div className="divide-y divide-stone-100 p-3 sm:p-4 space-y-2">
                    {(reservation.items || []).map((item, idx) => (
                      <div key={idx} className="flex items-center justify-between py-1.5 text-xs">
                        <div>
                          <p className="font-bold text-stone-900">{item.cakeName}</p>
                          <p className="text-[11px] text-stone-500 font-mono">
                            単価: ¥{(Number(item.price) || 0).toLocaleString()} × {item.quantity}個
                          </p>
                        </div>
                        <span className="font-mono font-bold text-stone-900 text-sm">
                          ¥{((Number(item.price) || 0) * (Number(item.quantity) || 0)).toLocaleString()}
                        </span>
                      </div>
                    ))}

                    {/* Notes if any */}
                    {reservation.notes && (
                      <div className="pt-2.5 mt-2 border-t border-stone-200 space-y-1 text-xs">
                        <span className="text-[10px] text-stone-500 font-medium">備考連絡：</span>
                        <p className="p-2 bg-stone-100 rounded-lg text-stone-700">
                          {reservation.notes}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Pickup Instructions */}
                <div className="bg-[#FAF8F5] border border-stone-200 rounded-2xl p-4 text-xs space-y-2">
                  <h4 className="font-bold text-stone-900 flex items-center gap-1.5">
                    <Info className="w-4 h-4 text-amber-600" />
                    <span>お受取り当日のご案内</span>
                  </h4>
                  <ul className="list-disc list-inside space-y-1 text-stone-600 text-[11px] leading-relaxed">
                    <li>受取日時に店舗カウンターへお越しいただき、スタッフにお名前（<strong>{reservation.name} 様</strong>）をお伝えください。</li>
                    <li>お代金は店頭レジにてお支払い（現金・各種キャッシュレス対応）となります。</li>
                    <li>予約内容の確認は、画面上部の「予約確認・変更」からいつでも可能です（Webからのキャンセルは12/18（金）まで。締切後のキャンセル・変更はお電話 043-239-2520／平日 9：00～17：30 のみで承ります）。</li>
                    <li>ご予約内容について、事前に確認の連絡を入れる場合がございます。</li>
                  </ul>
                </div>
              </div>
            ) : (
              /* Plain Text Receipt View (お客様保存用テキスト控え) */
              <div className="space-y-3">
                {/* Receipt Header */}
                <div className="bg-stone-50 border border-stone-300 rounded-2xl p-4 text-xs font-mono space-y-1.5">
                  <div className="flex justify-between items-center pb-2 border-b border-stone-200">
                    <span className="font-bold text-stone-800 flex items-center gap-1.5 font-sans">
                      <FileText className="w-4 h-4 text-amber-600" />
                      ご予約控えテキスト（メモ・保存用）
                    </span>
                    <span className="text-[10px] bg-emerald-100 text-emerald-800 border border-emerald-300 px-2 py-0.5 rounded font-bold font-sans">
                      予約確定済
                    </span>
                  </div>
                  <div className="space-y-1 pt-1 text-[11px]">
                    <p><strong className="text-stone-500">お名前:</strong> <span className="font-bold text-stone-900">{reservation.name} 様</span></p>
                    <p><strong className="text-stone-500">お受取日時:</strong> {formattedDate} {reservation.time}</p>
                    <p><strong className="text-stone-500">受付日時:</strong> {nowStr}</p>
                  </div>
                </div>

                {/* Receipt Plain Text Body Box */}
                <div className="relative">
                  <pre className="bg-stone-900 text-stone-100 p-4 sm:p-5 rounded-2xl text-xs font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto max-h-[380px] border border-stone-700 shadow-inner selection:bg-amber-500 selection:text-black">
                    {generateReceiptText()}
                  </pre>

                  <button
                    type="button"
                    onClick={handleCopyReceipt}
                    className="absolute top-3 right-3 px-3 py-1.5 bg-white/90 hover:bg-white text-stone-900 rounded-xl text-xs font-bold font-sans flex items-center gap-1.5 shadow-md active:scale-95 transition-all cursor-pointer"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                        <span className="text-emerald-700">コピー完了！</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 text-stone-700" />
                        <span>控えをコピー</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Modal Footer Actions */}
          <div className="bg-stone-50 p-4 sm:px-6 border-t border-stone-200 flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <button
                type="button"
                onClick={handleCopyReceipt}
                className="flex-1 sm:flex-initial px-3.5 py-2.5 bg-white hover:bg-stone-100 text-stone-800 border border-stone-300 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 shadow-2xs transition-colors cursor-pointer"
                title="予約控えをコピー"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4 text-stone-600" />}
                <span>{copied ? 'コピーしました' : '予約控えをコピー'}</span>
              </button>

              <button
                type="button"
                onClick={handlePrint}
                className="px-3.5 py-2.5 bg-white hover:bg-stone-100 text-stone-800 border border-stone-300 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 shadow-2xs transition-colors cursor-pointer"
                title="予約控えを印刷またはPDF保存"
              >
                <Printer className="w-4 h-4 text-stone-600" />
                <span>印刷 / 保存</span>
              </button>
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
              <button
                type="button"
                onClick={() => {
                  onClose();
                  if (onReturnToCatalog) onReturnToCatalog();
                }}
                className="w-full sm:w-auto px-6 py-2.5 bg-stone-900 hover:bg-black text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm transition-all cursor-pointer"
              >
                <span>閉じてケーキ一覧に戻る</span>
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
