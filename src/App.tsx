import React, { useState, useEffect } from 'react';
import { Cake, Reservation } from './types';
import { CAKES } from './data/cakes';
import CakeGrid from './components/CakeGrid';
import ReservationForm from './components/ReservationForm';
import AdminDashboard from './components/AdminDashboard';
import CustomerCalendarModal from './components/CustomerCalendarModal';
import StaffPickupMode from './components/StaffPickupMode';
import { 
  initializeDatabase, subscribeToAuth, googleLogin, userSignOut, saveMockSession, fetchReservations, updateReservationStatus, fetchCakes, subscribeToCakes, fetchBusinessDays, evaluateAndExecuteSalesSchedules
} from './lib/dbService';
import { motion, AnimatePresence } from 'motion/react';
import { 
  ShoppingBag, Calendar, Lock, Users, Sparkles, Check, Database, FileText, ArrowRight, X, Heart, Clock
} from 'lucide-react';
// @ts-ignore
export default function App() {
  const [activeTab, setActiveTab] = useState<'catalog' | 'checkout' | 'history' | 'admin'>('catalog');
  const [cart, setCart] = useState<{ [cakeId: string]: number }>({});
  const [dbAvailable, setDbAvailable] = useState<boolean | null>(null);
  const [isBusinessDaysOpen, setIsBusinessDaysOpen] = useState(false);
  const [user, setUser] = useState<{ email: string | null; isManager: boolean; displayName: string | null; uid: string | null } | null>(null);
  
  // Dynamic Cakes list
  const [cakes, setCakes] = useState<Cake[]>(CAKES);

  // Staff Pickup Quick Mode (hpy001)
  const [isStaffMode, setIsStaffMode] = useState(false);

  // My 予約 (Booking lookup)
  const [myEmailLookup, setMyEmailLookup] = useState('');
  const [myReservations, setMyReservations] = useState<Reservation[]>([]);
  const [searchAttempted, setSearchAttempted] = useState(false);
  const [isSearchingHistory, setIsSearchingHistory] = useState(false);
  const [cancellingResId, setCancellingResId] = useState<string | null>(null);

  // Notifications
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Initialize DB and load cakes on mount
  useEffect(() => {
    let unsubscribeAuth: (() => void) | null = null;
    let unsubscribeCakes: (() => void) | null = null;

    async function setup() {
      const res = await initializeDatabase();
      setDbAvailable(res.available);

      // Subscribe to real-time cakes catalog (including sold-out states)
      unsubscribeCakes = subscribeToCakes((updatedCakes) => {
        if (Array.isArray(updatedCakes) && updatedCakes.length > 0) {
          setCakes(updatedCakes);
        }
      });

      // Fetch latest cakes and business days from cloud (also auto-migrates any local admin settings and evaluates scheduled sales stops)
      try {
        const [schedResult] = await Promise.all([
          evaluateAndExecuteSalesSchedules(),
          fetchBusinessDays()
        ]);
        if (Array.isArray(schedResult.cakes) && schedResult.cakes.length > 0) {
          setCakes(schedResult.cakes);
        }
      } catch (err) {
        console.error('Failed to fetch initial store data:', err);
      }

      // Setup Auth observer
      unsubscribeAuth = subscribeToAuth((userData) => {
        setUser(userData);
        if (userData?.email && !userData.isManager) {
          // pre-fill search input only for non-admin customers
          setMyEmailLookup(userData.email);
          triggerHistorySearch(userData.email);
        }
      });
    }
    setup();

    const scheduleTimer = window.setInterval(() => {
      evaluateAndExecuteSalesSchedules()
        .then((res) => {
          if (res.triggered && Array.isArray(res.cakes) && res.cakes.length > 0) {
            setCakes(res.cakes);
          }
        })
        .catch(() => {});
    }, 15000);

    return () => {
      if (unsubscribeAuth) unsubscribeAuth();
      if (unsubscribeCakes) unsubscribeCakes();
      window.clearInterval(scheduleTimer);
    };
  }, []);

  // Automatically remove any cake from cart if it becomes sold out while browsing catalog
  useEffect(() => {
    if (activeTab === 'checkout') {
      // Do not silently delete cart items while customer is in ReservationForm so ReservationForm's exclusive control can display an explicit error
      return;
    }
    setCart((prevCart) => {
      const nextCart = { ...prevCart };
      let removedNames: string[] = [];
      for (const cakeId of Object.keys(nextCart)) {
        const found = cakes.find((c) => c.id === cakeId);
        if (!found || found.isSoldOut) {
          if (found?.jpName) removedNames.push(found.jpName);
          delete nextCart[cakeId];
        }
      }
      if (removedNames.length > 0) {
        setTimeout(() => {
          triggerToast(`⚠️ 「${removedNames.join('・')}」は現在売り切れのためカートから除外されました`);
        }, 0);
        return nextCart;
      }
      return prevCart;
    });
  }, [cakes, activeTab]);

  // Keep cake catalog synced when switching back to catalog tab
  useEffect(() => {
    if (activeTab === 'catalog') {
      fetchCakes()
        .then((loadedCakes) => {
          if (Array.isArray(loadedCakes)) {
            setCakes(loadedCakes);
          }
        })
        .catch((err) => console.error('Failed to refresh cakes:', err));
    }
  }, [activeTab]);

  const triggerToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  };

  const handleAddToCart = (cake: Cake, quantity: number) => {
    if (cake.isSoldOut) {
      triggerToast(`⚠️「${cake.jpName}」は現在売り切れ（オーダーストップ）となっております。`);
      return;
    }

    const isHall = cake.category === 'hall';
    const isCut = cake.category === 'cut';
    
    const currentQty = cart[cake.id] || 0;
    
    if (isHall) {
      if (currentQty + quantity > 2) {
        triggerToast(`⚠️ ホールケーキ（${cake.jpName}）は各種2台までとなっております。`);
        return;
      }
    }
    
    if (isCut) {
      const currentCutTotal = Object.entries(cart).reduce((sum, [id, qty]) => {
        const c = cakes.find(item => item.id === id);
        return c?.category === 'cut' ? sum + (qty as number) : sum;
      }, 0);
      
      if (currentCutTotal + quantity > 10) {
        triggerToast(`⚠️ カットケーキは全種類合わせて合計10点までとなっております。（現在カート内: ${currentCutTotal}点）`);
        return;
      }
    }

    setCart(prev => {
      const current = prev[cake.id] || 0;
      return { ...prev, [cake.id]: current + quantity };
    });
    triggerToast(`🎂 ${cake.jpName}（${quantity}個）をカートに追加しました`);
  };

  const handleUpdateCartQty = (cakeId: string, quantity: number) => {
    const cake = cakes.find(c => c.id === cakeId);
    if (!cake) return;
    if (cake.isSoldOut && quantity > 0) {
      triggerToast(`⚠️「${cake.jpName}」は現在売り切れ（オーダーストップ）となっております。`);
      setCart(prev => {
        const next = { ...prev };
        delete next[cakeId];
        return next;
      });
      return;
    }
    
    const isHall = cake.category === 'hall';
    const isCut = cake.category === 'cut';
    
    if (isHall && quantity > 2) {
      triggerToast(`⚠️ ホールケーキ（${cake.jpName}）は各種2台までとなっております。`);
      return;
    }
    
    if (isCut) {
      const otherCutTotal = Object.entries(cart).reduce((sum, [id, qty]) => {
        if (id === cakeId) return sum;
        const c = cakes.find(item => item.id === id);
        return c?.category === 'cut' ? sum + (qty as number) : sum;
      }, 0);
      
      if (otherCutTotal + quantity > 10) {
        triggerToast(`⚠️ カットケーキは全種類合わせて合計10点までとなっております。`);
        return;
      }
    }

    setCart(prev => {
      const next = { ...prev };
      if (quantity <= 0) {
        delete next[cakeId];
      } else {
        next[cakeId] = quantity;
      }
      return next;
    });
  };

  const handleClearCart = () => {
    setCart({});
  };

  const totalCartQty = (Object.values(cart) as number[]).reduce((sum, qty) => sum + qty, 0);
  const totalCartPrice = Object.entries(cart).reduce((sum, [cakeId, qty]) => {
    const cake = cakes.find(c => c.id === cakeId);
    return sum + (cake ? cake.price * (qty as number) : 0);
  }, 0);

  // Client Mock Logins
  const handleAuthClick = async () => {
    try {
      if (user) {
        await userSignOut();
        setUser(null);
        saveMockSession(null);
        setMyReservations([]);
        setSearchAttempted(false);
        triggerToast('ログアウトしました');
      } else {
        const result = await googleLogin();
        if (result.user) {
          const uInfo = {
            email: result.email,
            isManager: result.isManager,
            displayName: result.user.displayName,
            uid: result.user.uid
          };
          setUser(uInfo);
          saveMockSession(uInfo);
          if (result.email) {
            setMyEmailLookup(result.email);
            triggerHistorySearch(result.email);
          }
          triggerToast(`こんにちは、${result.user.displayName || 'ゲスト'} 様`);
          
          if (result.isManager) {
            setActiveTab('admin');
          }
        }
      }
    } catch (err) {
      console.error('Login action error:', err);
    }
  };

  const triggerHistorySearch = async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      triggerToast('⚠️ メールアドレスまたはお電話番号を入力してください。');
      return;
    }

    const isEmail = trimmed.includes('@');
    const isPhone = trimmed.replace(/[-\s]/g, '').length >= 7;

    if (!isEmail && !isPhone) {
      triggerToast('⚠️ 正しいメールアドレス、またはお電話番号（7桁以上）を入力してください。');
      return;
    }

    setIsSearchingHistory(true);
    setSearchAttempted(true);
    try {
      const data = await fetchReservations(trimmed);
      setMyReservations(data);
    } catch (err) {
      console.error('Failed to look up bookings:', err);
      triggerToast('予約情報の取得に失敗しました');
    } finally {
      setIsSearchingHistory(false);
    }
  };

  const handleManualSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const query = myEmailLookup.trim();
    if (!query) return;

    const digitsOnly = query.replace(/[-\s]/g, '');

    // 1. Secret Admin Access: 07064685230 -> Redirect to Admin Dashboard
    if (digitsOnly === '07064685230') {
      const adminManager = {
        email: 'kanamori@happy-sweets.jp',
        isManager: true,
        displayName: '管理者（金森様）',
        uid: 'manager_admin_07064685230'
      };
      setUser(adminManager);
      saveMockSession(adminManager);
      setActiveTab('admin');
      setIsStaffMode(false);
      setMyEmailLookup('');
      triggerToast('🔑 管理者画面を開きました（コード認証完了）');
      return;
    }

    // 2. Secret Staff Pickup Mode: hpy001 -> Open 2-tap pickup completion mode
    if (query.toLowerCase() === 'hpy001') {
      setIsStaffMode(true);
      setMyEmailLookup('');
      triggerToast('🍰 店舗受取確認モード（hpy001）を開きました');
      return;
    }

    // 3. Normal reservation search by email or phone
    triggerHistorySearch(query);
  };

  return (
    <div className="min-h-screen bg-sleek-bg text-sleek-text font-sans flex flex-col justify-between">
      
      {/* Dynamic Database Mode Indicator Tag */}
      {dbAvailable !== null && (
        <div className={`text-center py-1.5 sm:py-2 px-2.5 sm:px-4 text-[10px] sm:text-[11px] font-medium tracking-wide select-none flex items-center justify-center gap-1.5 transition-colors border-b leading-snug ${
          dbAvailable 
            ? 'bg-emerald-50/40 text-emerald-800 border-emerald-100' 
            : 'bg-sleek-cream text-sleek-muted border-sleek-border'
        }`}>
          <Database className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-sleek-gold shrink-0" />
          {dbAvailable ? (
            <span>
              <span className="inline-block">クラウド・データベース (Firebase Firestore) 接続完了。</span>
              <span className="inline-block">予約は安全にクラウドに同期されます。</span>
            </span>
          ) : (
            <span>
              <span className="inline-block">（体験デモモード）Firestore接続を準備中です。</span>
              <span className="inline-block">ご入力データは一時保存され、管理者画面をお試しいただけます。</span>
            </span>
          )}
        </div>
      )}

      {/* Main Luxury Brand Header Banner */}
      <header className="bg-white border-b border-sleek-border sticky top-0 z-30 shadow-xs backdrop-blur-md bg-white/95">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 md:px-12 py-3 sm:py-4 md:py-5 flex items-center justify-between gap-2">
          
          {/* Logo & title brand headings */}
          <div className="cursor-pointer select-none shrink-0" onClick={() => setActiveTab('catalog')}>
            <div className="flex flex-col items-start sm:items-center text-left sm:text-center">
              <h1 className="font-serif font-semibold tracking-[0.06em] sm:tracking-[0.08em] text-sleek-dark leading-none text-lg sm:text-2xl md:text-[2rem] flex items-center gap-1 sm:gap-2 whitespace-nowrap">
                Happy Café
                <Sparkles className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-sleek-gold animate-pulse fill-sleek-gold shrink-0" />
              </h1>
              <p className="text-[8px] sm:text-[10px] text-sleek-muted font-mono tracking-[0.1em] sm:tracking-[0.22em] uppercase mt-1 whitespace-nowrap">ハッピー製菓調理専門学校</p>
            </div>
          </div>

          {/* Tab Menu Options (Desktop) */}
          <nav className="hidden md:flex items-center gap-8 text-xs font-semibold uppercase tracking-widest">
            <button
              id="nav-catalog"
              onClick={() => setActiveTab('catalog')}
              className={`transition-colors pb-1 border-b-2 whitespace-nowrap ${
                activeTab === 'catalog' 
                  ? 'border-sleek-gold text-sleek-gold' 
                  : 'border-transparent text-sleek-muted hover:text-sleek-dark'
              }`}
            >
              ケーキを選ぶ
            </button>
            <button
              id="nav-history"
              onClick={() => setActiveTab('history')}
              className={`transition-colors pb-1 border-b-2 whitespace-nowrap ${
                activeTab === 'history' 
                  ? 'border-sleek-gold text-sleek-gold' 
                  : 'border-transparent text-sleek-muted hover:text-sleek-dark'
              }`}
            >
              予約確認・変更
            </button>
          </nav>

          {/* Quick Access Actions Header Column */}
          <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
            {/* Business Schedule quick access link */}
            <button
              id="btn-business-calendar"
              onClick={() => setIsBusinessDaysOpen(true)}
              title="Happy Caféのクリスマスケーキお受取り可能日・営業時間を確認します"
              className="flex items-center gap-1 sm:gap-1.5 px-2.5 py-1.5 sm:px-3.5 sm:py-2.5 bg-emerald-50/80 hover:bg-emerald-100 text-emerald-800 border border-emerald-200/60 rounded-xl transition-all text-[11px] sm:text-xs font-semibold tracking-wider font-sans focus:outline-none shrink-0 whitespace-nowrap"
            >
              <Calendar className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-600 shrink-0" />
              <span>営業日</span>
            </button>


            {/* Shopping cart trigger */}
            <button
              id="btn-cart-header"
              onClick={() => setActiveTab('checkout')}
              className="relative bg-sleek-dark hover:bg-black text-white px-3 py-1.5 sm:px-5 sm:py-2.5 rounded-xl transition-all shadow-md flex items-center gap-1 sm:gap-1.5 font-semibold text-[11px] sm:text-xs uppercase tracking-wider shrink-0 active:scale-95 whitespace-nowrap"
            >
              <ShoppingBag className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-sleek-gold shrink-0" />
              <span>カート</span>
              {totalCartQty > 0 && (
                <span className="bg-[#D4AF37] text-white rounded-full w-4 h-4 sm:w-5 sm:h-5 flex items-center justify-center text-[9px] sm:text-[10px] font-black absolute -top-1.5 -right-1.5 shadow-sm border border-white">
                  {totalCartQty}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Mobile Tab Switcher Strip */}
        <div className="md:hidden flex border-t border-sleek-border/70 bg-[#FAF9F6] text-[11px] sm:text-xs font-semibold text-center">
          <button
            onClick={() => setActiveTab('catalog')}
            className={`flex-1 py-2.5 flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap ${
              activeTab === 'catalog'
                ? 'text-sleek-gold bg-white border-b-2 border-sleek-gold font-bold shadow-xs'
                : 'text-sleek-muted hover:text-sleek-dark'
            }`}
          >
            <span>🎂 ケーキを選ぶ</span>
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`flex-1 py-2.5 flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap ${
              activeTab === 'history'
                ? 'text-sleek-gold bg-white border-b-2 border-sleek-gold font-bold shadow-xs'
                : 'text-sleek-muted hover:text-sleek-dark'
            }`}
          >
            <span>📋 予約確認・変更</span>
          </button>
        </div>
      </header>

      {/* Main Container Core Wrapper */}
      <main className="max-w-7xl mx-auto px-3 sm:px-6 md:px-8 py-4 sm:py-8 md:py-12 pb-24 sm:pb-12 flex-grow w-full">
          
          {/* CATALOG TAB VIEW */}
          {activeTab === 'catalog' && (
            <div
              key="catalog-tab"
              className="space-y-5 sm:space-y-10"
            >
              {/* Marketing hero banner section */}
              <div className="bg-sleek-cream rounded-2xl sm:rounded-3xl p-4 sm:p-8 md:p-12 border border-sleek-border text-center space-y-3.5 sm:space-y-5 max-w-4xl mx-auto relative overflow-hidden shadow-xs">
                <div className="absolute top-0 right-0 w-48 sm:w-64 h-48 sm:h-64 bg-[#D4AF37]/5 rounded-full filter blur-3xl translate-x-24 sm:translate-x-32 -translate-y-24 sm:-translate-y-32 pointer-events-none"></div>
                <div className="absolute bottom-0 left-0 w-48 sm:w-64 h-48 sm:h-64 bg-[#D4AF37]/5 rounded-full filter blur-3xl -translate-x-24 sm:-translate-x-32 translate-y-24 sm:translate-y-32 pointer-events-none"></div>

                <h2 className="text-xl sm:text-3xl md:text-5xl font-light leading-tight flex items-center justify-center text-sleek-dark whitespace-nowrap">
                  <span 
                    className="tracking-[0.16em] sm:tracking-[0.22em] text-black text-[0.95em]"
                    style={{ fontFamily: '"Yu Mincho", "YuMincho", "MS Mincho", "MS PMincho", Georgia, serif', fontWeight: 500 }}
                  >
                    ケーキ予約
                  </span>
                </h2>
                <p className="text-sleek-muted text-[11px] sm:text-sm md:text-base max-w-xl mx-auto leading-relaxed">
                  <span className="inline-block">パティシエのたまごたちが心を込めて作る</span>
                  <span className="inline-block">クリスマスケーキ。</span>
                  <br />
                  <span className="inline-block">是非ご賞味ください。</span>
                </p>

                <div className="space-y-2 sm:space-y-2.5 max-w-xl mx-auto pt-1 sm:pt-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 sm:gap-3 text-xs">
                    <div className="flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3.5 py-2 sm:py-2.5 bg-white border border-sleek-border-light rounded-xl text-sleek-dark shadow-xs justify-center whitespace-nowrap">
                      <Clock className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-sleek-gold font-bold shrink-0" />
                      <span className="text-[11px] sm:text-xs">営業時間：<strong className="text-sleek-gold font-sans font-bold">11:30〜15:00</strong></span>
                    </div>
                    <div className="flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3.5 py-2 sm:py-2.5 bg-white border border-sleek-border-light rounded-xl text-sleek-dark shadow-xs justify-center whitespace-nowrap">
                      <Calendar className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-sleek-gold shrink-0" />
                      <span className="text-[11px] sm:text-xs">締切：<strong className="text-sleek-gold font-sans font-bold">受取希望日の3日前まで</strong></span>
                    </div>
                  </div>
                  <div className="text-xs text-center">
                    <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3.5 py-2 sm:py-2.5 bg-white border border-sleek-border-light rounded-xl text-sleek-dark shadow-xs justify-center w-full whitespace-nowrap">
                      <ShoppingBag className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-sleek-gold shrink-0" />
                      <span className="text-[10px] sm:text-xs leading-tight">
                        1回のご注文上限：<strong className="text-sleek-gold font-sans font-bold">ホール各種2台 / カット合計10個</strong>
                      </span>
                    </div>
                  </div>
                </div>

                <div className="h-0.5 w-10 sm:w-12 bg-sleek-gold mx-auto opacity-70"></div>
              </div>

              {/* Grid lists with categories filters */}
              <CakeGrid cakes={cakes} onAddToCart={handleAddToCart} cart={cart} />
            </div>
          )}

          {/* CHECKOUT TABLE CARTS TAB VIEW */}
          {activeTab === 'checkout' && (
            <div
              key="checkout-tab"
            >
              <h2 className="text-lg sm:text-2xl md:text-3xl font-light text-sleek-dark tracking-tight mb-5 sm:mb-8 text-center font-serif whitespace-nowrap">
                ご予約・お会計内容の確認
              </h2>
              <ReservationForm
                cart={cart}
                cakes={cakes}
                onCakesUpdated={(latestCakes) => setCakes(latestCakes)}
                onUpdateCartQty={handleUpdateCartQty}
                onClearCart={handleClearCart}
                onReservationSuccess={(bookingId, res) => {
                  triggerToast('🎉 予約が完了しました！');
                  if (res?.email) {
                    setMyEmailLookup(res.email);
                  }
                }}
                onReturnToCatalog={() => setActiveTab('catalog')}
                userName={user?.displayName}
                userEmail={user?.email}
                onToast={triggerToast}
              />
            </div>
          )}

          {/* BOOKING HISTORY RESEARCH TAB VIEW */}
          {activeTab === 'history' && (
            isStaffMode ? (
              <StaffPickupMode 
                onExit={() => setIsStaffMode(false)} 
                onToast={triggerToast} 
              />
            ) : (
            <div
              key="history-tab"
              className="max-w-4xl mx-auto space-y-4 sm:space-y-5"
            >
              {/* Lookup Search Card */}
              <div className="bg-white rounded-2xl p-4 sm:p-5 border border-sleek-border shadow-xs space-y-3 max-w-xl mx-auto">
                <div className="text-center space-y-1">
                  <h2 className="text-base sm:text-xl font-light text-sleek-dark font-serif whitespace-nowrap">ご予約状況の照会・確認</h2>
                  <p className="text-sleek-muted text-[11px] sm:text-xs leading-relaxed">
                    <span className="inline-block">ご予約時のメールアドレスまたはお電話番号を入力して、</span>
                    <br className="hidden sm:inline" />
                    <span className="inline-block">予約内容の確認やキャンセルが可能です。</span>
                  </p>
                </div>

                {/* Form lookup field */}
                <form onSubmit={handleManualSearchSubmit} className="flex gap-2">
                  <input
                    type="text"
                    value={myEmailLookup}
                    onChange={(e) => setMyEmailLookup(e.target.value)}
                    placeholder="メールアドレス または お電話番号"
                    required
                    className="flex-grow min-w-0 border border-sleek-border px-3 sm:px-3.5 py-2 rounded-xl text-xs sm:text-sm text-sleek-dark placeholder-sleek-muted focus:outline-none focus:ring-1 focus:ring-sleek-gold bg-white"
                  />
                  <button
                    type="submit"
                    id="btn-search-history"
                    disabled={isSearchingHistory}
                    className="bg-sleek-dark hover:bg-black text-white font-medium px-3.5 sm:px-5 py-2 rounded-xl text-[11px] sm:text-xs uppercase tracking-wider transition-all shadow-xs shrink-0 active:scale-95 disabled:opacity-50 whitespace-nowrap"
                  >
                    {isSearchingHistory ? '検索中...' : '予約を照会'}
                  </button>
                </form>

                {/* Contact inquiry info */}
                <div className="text-center pt-1">
                  <p className="text-[11px] sm:text-xs text-sleek-muted font-medium leading-relaxed">
                    <span className="inline-block">お忘れの場合は、</span>
                    <a
                      href="tel:043-239-2520"
                      className="text-sleek-gold hover:text-amber-700 underline font-semibold transition-colors inline-block"
                    >
                      043-239-2520
                    </a>
                    <span className="inline-block">におかけください。</span>
                    <span className="inline-block">（平日9:00~18:00）</span>
                  </p>
                </div>
              </div>

              {/* Booking List results - Compact list showing only #1 Name cards directly */}
              {searchAttempted && (
                <div className="max-w-2xl mx-auto">
                  {myReservations.length > 0 ? (
                    <div className="bg-white rounded-2xl border border-stone-300 shadow-sm overflow-hidden divide-y-2 divide-stone-300">
                      {myReservations.map((res, cardIdx) => {
                        const isCancelled = res.status === 'cancelled';
                        const isCompleted = res.status === 'completed';
                        const isEven = cardIdx % 2 === 0;
                        const isConfirmingCancel = cancellingResId === res.id;
                        const safeItems = Array.isArray(res.items) ? res.items : [];
                        const totalQty = safeItems.reduce((sum, item) => sum + (Number(item?.quantity) || 0), 0);

                        // Alternating background styling for clear visual separation
                        const cardBgClass = isCancelled
                          ? 'bg-red-50/85 text-red-700'
                          : isCompleted
                          ? isEven
                            ? 'bg-emerald-50/35 text-sleek-dark'
                            : 'bg-emerald-50/65 text-sleek-dark'
                          : isEven
                          ? 'bg-white text-sleek-dark'
                          : 'bg-[#F5F2EB] text-sleek-dark';

                        const headerBgClass = isCancelled
                          ? 'bg-red-100/80 border-red-200'
                          : isEven
                          ? 'bg-stone-50/90 border-stone-200/90'
                          : 'bg-[#EBE6DC]/80 border-[#DDD5C7]';

                        return (
                          <div
                            key={res.id}
                            className={`transition-colors ${cardBgClass}`}
                          >
                            {/* Card Top Header Bar with Index Badge, Customer Name, Status & Action */}
                            <div className={`px-4 py-2.5 sm:px-5 sm:py-3 border-b flex items-center justify-between gap-2 flex-wrap ${headerBgClass}`}>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded-md border ${
                                  isCancelled
                                    ? 'bg-red-600 text-white border-red-700'
                                    : isEven
                                    ? 'bg-stone-800 text-white border-stone-800'
                                    : 'bg-amber-800 text-white border-amber-800'
                                }`}>
                                  #{cardIdx + 1}
                                </span>
                                <span className={`font-serif font-bold text-sm sm:text-base ${isCancelled ? 'text-red-700' : 'text-stone-900'}`}>
                                  {res.name} <span className="text-xs font-normal">様</span>
                                </span>
                                {res.status === 'pending' && (
                                  <span className="bg-amber-100 text-amber-950 border border-amber-300 text-[10px] sm:text-[11px] px-2.5 py-0.5 rounded-full font-bold">
                                    受付済み
                                  </span>
                                )}
                                {res.status === 'confirmed' && (
                                  <span className="bg-blue-100 text-blue-950 border border-blue-300 text-[10px] sm:text-[11px] px-2.5 py-0.5 rounded-full font-bold">
                                    予約確定済
                                  </span>
                                )}
                                {res.status === 'completed' && (
                                  <span className="bg-emerald-100 text-emerald-950 border border-emerald-300 text-[10px] sm:text-[11px] px-2.5 py-0.5 rounded-full font-bold">
                                    お渡し完了
                                  </span>
                                )}
                                {res.status === 'cancelled' && (
                                  <span className="bg-red-600 text-white border border-red-700 text-[10px] sm:text-[11px] px-2.5 py-0.5 rounded-full font-bold">
                                    キャンセル済
                                  </span>
                                )}
                              </div>

                              {/* Order cancellation trigger for pending or confirmed status */}
                              {(res.status === 'pending' || res.status === 'confirmed') && (
                                isConfirmingCancel ? (
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        try {
                                          await updateReservationStatus(res.id, 'cancelled');
                                          setCancellingResId(null);
                                          triggerToast('予約をキャンセルしました（店舗スタッフへ通知を送信しました）');
                                          triggerHistorySearch(myEmailLookup);
                                        } catch (err) {
                                          console.error(err);
                                        }
                                      }}
                                      className="text-[11px] bg-red-600 hover:bg-red-700 text-white font-bold px-2.5 py-1 rounded-lg transition-colors shadow-xs whitespace-nowrap cursor-pointer"
                                    >
                                      キャンセルを確定する
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setCancellingResId(null)}
                                      className="text-[11px] bg-stone-200 hover:bg-stone-300 text-stone-700 font-medium px-2 py-1 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                                    >
                                      戻る
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setCancellingResId(res.id)}
                                    className="text-[11px] text-red-600 hover:text-red-700 font-semibold px-2.5 py-1 rounded-lg bg-white hover:bg-red-50 transition-colors border border-red-200 whitespace-nowrap cursor-pointer shadow-2xs"
                                  >
                                    予約キャンセル
                                  </button>
                                )
                              )}
                            </div>

                            {/* Card Body with Divided Sections - Compact spacing to minimize scrolling */}
                            <div className="p-3.5 sm:p-4 space-y-3">
                              {/* Key Schedule & Total Info Grid */}
                              <div className={`grid grid-cols-2 sm:grid-cols-4 rounded-xl border overflow-hidden divide-y sm:divide-y-0 sm:divide-x ${
                                isCancelled
                                  ? 'bg-red-50/90 border-red-200 divide-red-200 text-red-700'
                                  : isEven
                                  ? 'bg-[#FAF9F6] border-stone-200 divide-stone-200'
                                  : 'bg-white border-stone-300/90 divide-stone-200'
                              }`}>
                                <div className="p-2 sm:p-2.5">
                                  <span className={`text-[10px] block font-mono mb-0.5 ${isCancelled ? 'text-red-500' : 'text-stone-500'}`}>
                                    受取日
                                  </span>
                                  <strong className={`text-xs sm:text-sm font-mono font-bold ${isCancelled ? 'text-red-700' : 'text-sleek-dark'}`}>
                                    {res.date}
                                  </strong>
                                </div>
                                <div className="p-2 sm:p-2.5">
                                  <span className={`text-[10px] block font-mono mb-0.5 ${isCancelled ? 'text-red-500' : 'text-stone-500'}`}>
                                    受取時間帯
                                  </span>
                                  <strong className={`text-xs sm:text-sm font-mono font-bold ${isCancelled ? 'text-red-700' : 'text-amber-800'}`}>
                                    {res.time}
                                  </strong>
                                </div>
                                <div className="p-2 sm:p-2.5">
                                  <span className={`text-[10px] block font-mono mb-0.5 ${isCancelled ? 'text-red-500' : 'text-stone-500'}`}>
                                    合計金額（{totalQty}点）
                                  </span>
                                  <strong className={`text-xs sm:text-sm font-mono font-bold ${isCancelled ? 'text-red-700' : 'text-sleek-gold'}`}>
                                    ¥{(Number(res.totalPrice) || 0).toLocaleString()}
                                  </strong>
                                </div>
                                <div className="p-2 sm:p-2.5">
                                  <span className={`text-[10px] block font-mono mb-0.5 ${isCancelled ? 'text-red-500' : 'text-stone-500'}`}>
                                    お支払い方法
                                  </span>
                                  <span className={`text-xs sm:text-sm font-medium ${isCancelled ? 'text-red-700' : 'text-sleek-dark'}`}>
                                    店頭払い
                                  </span>
                                </div>
                              </div>

                              {/* Ordered Cake Items List */}
                              <div className={`rounded-xl border overflow-hidden ${
                                isCancelled
                                  ? 'bg-white/90 border-red-200'
                                  : isEven
                                  ? 'bg-stone-50/70 border-stone-200/90'
                                  : 'bg-white border-stone-300/80'
                              }`}>
                                <div className={`px-3 py-1.5 text-[10px] font-bold tracking-wider uppercase border-b flex items-center justify-between ${
                                  isCancelled
                                    ? 'bg-red-100/60 border-red-200 text-red-700'
                                    : 'bg-stone-100/80 border-stone-200/80 text-stone-600'
                                }`}>
                                  <span>ご予約ケーキ内訳</span>
                                  <span className="font-mono">数量</span>
                                </div>
                                <ul className={`divide-y text-xs ${isCancelled ? 'divide-red-200/70' : 'divide-stone-200/80'}`}>
                                  {safeItems.map((item, index) => (
                                    <li
                                      key={index}
                                      className={`px-3 py-1.5 flex items-center justify-between text-xs sm:text-sm ${
                                        isCancelled ? 'text-red-700 font-semibold' : 'text-sleek-dark'
                                      }`}
                                    >
                                      <span className="flex items-center gap-1.5 font-medium">
                                        <span>🎂</span>
                                        <span>{item.cakeName}</span>
                                      </span>
                                      <span className={`font-mono font-bold px-2 py-0.5 rounded border text-xs ${
                                        isCancelled
                                          ? 'bg-red-50 border-red-200 text-red-700'
                                          : 'bg-amber-50/80 border-amber-200/80 text-amber-900'
                                      }`}>
                                        × {item.quantity}個
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="bg-white p-6 sm:p-8 rounded-2xl text-center border border-sleek-border text-sleek-muted text-xs leading-relaxed max-w-sm mx-auto shadow-xs">
                      ご予約データが見つかりませんでした。<br />入力されたメールアドレスまたはお電話番号をご確認ください。
                    </div>
                  )}
                </div>
              )}
            </div>
            )
          )}

          {/* STORE MANAGEMENT BACKEND ADMIN DASH VIEW */}
          {activeTab === 'admin' && (
            <div
              key="admin-tab"
            >
              {/* Force mock authentication gate screen if user is not a manager */}
              {user && user.isManager ? (
                <AdminDashboard 
                  userEmail={user.email} 
                  cakes={cakes}
                  onCakesUpdated={setCakes}
                  onToast={triggerToast}
                  onLogout={async () => {
                    await userSignOut();
                    setUser(null);
                    saveMockSession(null);
                    setActiveTab('catalog');
                  }} 
                />
              ) : (
                <div className="max-w-md mx-auto bg-white border border-sleek-border rounded-3xl p-8 shadow-sm space-y-6 text-center">
                  <div className="w-16 h-16 bg-sleek-cream rounded-full flex items-center justify-center text-sleek-gold mx-auto border border-sleek-border-light">
                    <Lock className="w-7 h-7" />
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-xl font-light text-sleek-dark font-serif">店舗関係者 ログインゲート</h2>
                    <p className="text-sleek-muted text-xs leading-relaxed">
                      こちらは「Happy Café」店舗用の管理画面です。売上指標やご予約台帳の操作ができます。
                    </p>
                  </div>

                  {/* Single-button mock log in bypass to let reviewers explore */}
                  <div className="bg-sleek-cream p-5 rounded-xl text-left border border-sleek-border text-xs space-y-2.5">
                    <p className="font-semibold text-sleek-gold tracking-wider uppercase">🔔 レビュー用バイパスのご案内</p>
                    <p className="text-sleek-text leading-relaxed">
                      管理者としての認証をテストするために以下のデモボタンをご利用いただけます。自動的にマネージャーメール（<strong>kanamori@happy-sweets.jp</strong>）で模擬セッションが開始されます。
                    </p>
                    <button
                      onClick={async () => {
                        const mockManger = {
                          email: 'kanamori@happy-sweets.jp',
                          isManager: true,
                          displayName: '管理者１',
                          uid: 'manager_uid_demo'
                        };
                        setUser(mockManger);
                        saveMockSession(mockManger);
                        triggerToast('管理者１としてログインしました');
                      }}
                      className="w-full mt-2 bg-sleek-dark hover:bg-black text-white font-medium py-3 px-4 rounded-xl flex items-center justify-center gap-1.5 transition-colors text-xs uppercase tracking-widest shadow-md shadow-sleek-dark/10"
                    >
                      関係者としてデモに入る
                    </button>
                  </div>

                  {/* Trigger Standard Auth */}
                  <div className="flex items-center justify-between border-t border-sleek-border-light pt-4 text-xs font-semibold">
                    <button
                      onClick={() => setActiveTab('catalog')}
                      className="text-sleek-muted hover:text-sleek-dark transition-colors uppercase tracking-wider"
                    >
                      ケーキ一覧に戻る
                    </button>
                    <button
                      onClick={handleAuthClick}
                      className="text-sleek-gold hover:underline transition-colors uppercase tracking-wider"
                    >
                      通常のサインインを試す
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

      </main>

      {/* Decorative Brand Footer layout column */}
      <footer className="bg-sleek-dark text-sleek-muted border-t border-sleek-border py-10 sm:py-12 text-xs">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 md:px-12 space-y-5 sm:space-y-6">
          <div className="flex items-center justify-center gap-3">
            <span className="w-1.5 h-1.5 bg-sleek-gold rounded-full"></span>
            <span className="font-serif font-medium text-white text-base tracking-widest uppercase whitespace-nowrap">Happy Café</span>
            <span className="w-1.5 h-1.5 bg-sleek-gold rounded-full"></span>
          </div>
          <p className="max-w-2xl mx-auto text-[#8E8A83] text-center leading-relaxed text-[11px] sm:text-xs">
            <span className="block whitespace-nowrap">〒260-0021　千葉市中央区新宿2-6-21</span>
            <span className="block whitespace-nowrap">学校法人中村学園 ハッピー製菓調理専門学校</span>
            <span className="block whitespace-nowrap">TEL：043-239-2520</span>
          </p>
          <div className="flex items-center justify-center text-[9px] sm:text-[10px] text-[#706B63] uppercase tracking-[0.15em] sm:tracking-[0.2em] border-t border-[#2D2D2D] pt-6 mt-6 gap-4 sm:gap-6 whitespace-nowrap">
            <span>&copy; 2026 HAPPY CAFÉ CRAFT PASTRY</span>
            <span className="text-white">PRIVACY POLICY</span>
          </div>
        </div>
      </footer>

      {/* Quick dynamic pop Toast notifications feedback */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            id="toast-alert-notification"
            initial={{ opacity: 0, y: 30, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 30, scale: 0.95 }}
            className="fixed bottom-20 sm:bottom-6 right-3 sm:right-6 left-3 sm:left-auto bg-stone-900/95 backdrop-blur-md border border-stone-800 text-white px-4 py-3 sm:px-5 sm:py-4 rounded-xl shadow-2xl z-50 flex items-center justify-between gap-3 max-w-sm"
          >
            <span className="text-xs font-semibold">{toastMessage}</span>
            <button
              onClick={() => setToastMessage(null)}
              className="text-stone-400 hover:text-white font-bold text-xs p-1"
            >
              ✕
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mobile Sticky Floating Cart Bar */}
      <AnimatePresence>
        {activeTab === 'catalog' && totalCartQty > 0 && (
          <motion.div
            id="mobile-floating-cart-bar"
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            className="md:hidden fixed bottom-3 left-3 right-3 z-40 bg-[#1A1A1A]/95 text-white backdrop-blur-md p-3 rounded-2xl shadow-2xl border border-[#D4AF37]/30 flex items-center justify-between gap-3 animate-in fade-in slide-in-from-bottom-4 duration-200"
          >
            <div className="flex items-center gap-2.5 pl-1.5">
              <div className="relative">
                <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center">
                  <ShoppingBag className="w-4 h-4 text-sleek-gold" />
                </div>
                <span className="absolute -top-1 -right-1 bg-[#D4AF37] text-black font-black text-[10px] w-4 h-4 rounded-full flex items-center justify-center shadow-xs">
                  {totalCartQty}
                </span>
              </div>
              <div>
                <p className="text-[10px] text-stone-400 font-mono tracking-wider uppercase">合計（税込）</p>
                <p className="text-base font-bold text-sleek-gold font-sans leading-none">
                  ¥{totalCartPrice.toLocaleString()}
                </p>
              </div>
            </div>

            <button
              onClick={() => setActiveTab('checkout')}
              className="bg-[#D4AF37] hover:bg-[#B5853B] text-[#1A1A1A] font-bold text-xs px-4 py-2.5 rounded-xl shadow-md flex items-center gap-1.5 active:scale-95 transition-all"
            >
              <span>カートを見る</span>
              <ArrowRight className="w-3.5 h-3.5 text-[#1A1A1A]" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <CustomerCalendarModal
        isOpen={isBusinessDaysOpen}
        onClose={() => setIsBusinessDaysOpen(false)}
      />
    </div>
  );
}
