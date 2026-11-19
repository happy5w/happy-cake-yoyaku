import React, { useState } from 'react';
import { Smartphone, Share, PlusSquare, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  className?: string;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ className = '' }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        title="スマホのホーム画面に「Happy Café」を追加します"
        className={`items-center gap-1.5 px-3 py-2 bg-[#FAF8F5] hover:bg-[#F3EFE6] text-sleek-dark border border-[#D4AF37]/50 rounded-xl transition-all text-[11px] sm:text-xs font-semibold tracking-wider cursor-pointer whitespace-nowrap shadow-xs active:scale-95 ${className || 'inline-flex'}`}
      >
        <Smartphone className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-sleek-gold shrink-0" />
        <span>ホーム画面に追加</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          title="iPhoneのホーム画面に「Happy Café」を追加する方法"
          className={`items-center gap-1.5 px-3 py-2 bg-[#FAF8F5] hover:bg-[#F3EFE6] text-sleek-dark border border-[#D4AF37]/50 rounded-xl transition-all text-[11px] sm:text-xs font-semibold tracking-wider cursor-pointer whitespace-nowrap shadow-xs active:scale-95 ${className || 'inline-flex'}`}
        >
          <Smartphone className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-sleek-gold shrink-0" />
          <span>ホーム画面に追加</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
            <div className="w-full max-w-sm rounded-3xl bg-white border border-sleek-border p-6 shadow-2xl space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <img
                    src="/apple-touch-icon.png"
                    alt="Happy Café アイコン"
                    className="w-12 h-12 rounded-2xl border border-stone-200 shadow-xs shrink-0"
                  />
                  <div>
                    <h3 className="text-base font-bold font-serif text-sleek-dark">
                      ホーム画面に追加
                    </h3>
                    <p className="text-xs text-sleek-muted">
                      アイコン名：Happy Café
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="閉じる"
                  className="p-1.5 rounded-full text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="bg-[#FAF8F5] border border-sleek-border-light rounded-2xl p-4 space-y-3 text-xs text-sleek-dark leading-relaxed">
                <p className="flex items-start gap-2">
                  <span className="w-5 h-5 rounded-full bg-sleek-dark text-white font-bold flex items-center justify-center shrink-0 text-[11px]">
                    1
                  </span>
                  <span>
                    画面下（または右上）の
                    <strong className="inline-flex items-center gap-0.5 mx-1 text-sleek-gold">
                      <Share className="w-3.5 h-3.5 inline" /> 共有ボタン
                    </strong>
                    をタップします。
                  </span>
                </p>
                <p className="flex items-start gap-2">
                  <span className="w-5 h-5 rounded-full bg-sleek-dark text-white font-bold flex items-center justify-center shrink-0 text-[11px]">
                    2
                  </span>
                  <span>
                    メニューの中から
                    <strong className="inline-flex items-center gap-0.5 mx-1 text-sleek-dark">
                      <PlusSquare className="w-3.5 h-3.5 inline" /> ホーム画面に追加
                    </strong>
                    を選びます。
                  </span>
                </p>
                <p className="flex items-start gap-2">
                  <span className="w-5 h-5 rounded-full bg-sleek-dark text-white font-bold flex items-center justify-center shrink-0 text-[11px]">
                    3
                  </span>
                  <span>
                    右上の「追加」をタップすると、このアイコンと「Happy Café」の名前でホーム画面に並びます。
                  </span>
                </p>
              </div>

              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="w-full rounded-xl bg-sleek-dark hover:bg-black py-2.5 text-xs font-bold text-white transition-colors cursor-pointer"
              >
                閉じる
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
