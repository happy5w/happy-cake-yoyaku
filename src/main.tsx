import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; errorMessage: string }
> {
  declare props: Readonly<{ children: React.ReactNode }>;
  state = { hasError: false, errorMessage: '' };

  static getDerivedStateFromError(error: unknown) {
    return {
      hasError: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: unknown, errorInfo: React.ErrorInfo) {
    console.error('Application render error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#FAF8F5] text-[#2D2A26] flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white border border-stone-200 rounded-2xl p-6 shadow-sm text-center space-y-4">
            <h1 className="text-lg font-serif font-bold text-stone-900">
              画面の読み込み中にエラーが発生しました
            </h1>
            <p className="text-xs text-stone-600 leading-relaxed">
              一時的なデータの不整合またはキャッシュが原因の可能性があります。下のボタンを押して画面を再読み込みしてください。
            </p>
            <div className="flex flex-col sm:flex-row gap-2 justify-center pt-2">
              <button
                type="button"
                onClick={() => {
                  window.location.reload();
                }}
                className="px-4 py-2.5 bg-stone-900 text-white rounded-xl text-xs font-bold cursor-pointer"
              >
                再読み込みする
              </button>
              <button
                type="button"
                onClick={() => {
                  try {
                    sessionStorage.clear();
                    localStorage.removeItem('cakes_catalog_list');
                    localStorage.removeItem('staff_cancel_notifications');
                  } catch {}
                  window.location.reload();
                }}
                className="px-4 py-2.5 bg-stone-100 text-stone-700 border border-stone-300 rounded-xl text-xs font-semibold cursor-pointer"
              >
                表示キャッシュをリセットして復旧
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);

