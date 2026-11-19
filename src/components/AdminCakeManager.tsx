import React, { useState, useEffect, useMemo } from 'react';
import { Cake, SalesStopScheduleRule } from '../types';
import { CATEGORY_LABELS } from '../data/cakes';
import {
  updateCakeSoldOut,
  updateCakeSchedule,
  bulkUpdateCakesSoldOut,
  saveCakeItem,
  deleteCakeItem,
  fetchSalesStopRules,
  subscribeToSalesStopRules,
  addSalesStopRule,
  toggleSalesStopRule,
  deleteSalesStopRule,
  evaluateAndExecuteSalesSchedules,
  isScheduledStopTimeElapsed,
  syncCakesFromDefaultCode,
} from '../lib/dbService';
import { motion, AnimatePresence } from 'motion/react';
import {
  Plus,
  Edit3,
  Trash2,
  Check,
  Power,
  AlertCircle,
  ShoppingBag,
  Image as ImageIcon,
  Tag,
  ChevronDown,
  ChevronUp,
  Info,
  Clock,
  Calendar,
  Zap,
  RotateCcw,
  Upload,
  RefreshCw,
  Sparkles,
} from 'lucide-react';

const DEFAULT_FALLBACK_IMAGE = 'https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=600&auto=format&fit=crop&q=80';

// Converts Google Drive share links to direct raw image URLs and cleans input
function normalizeImageUrl(url: string): string {
  const trimmed = (url || '').trim();
  if (!trimmed) return '';
  // Check if user entered a Google Drive file link
  const gdriveMatch = trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (gdriveMatch && gdriveMatch[1]) {
    const fileId = gdriveMatch[1];
    // Google's direct CDN image endpoint works with public files
    return `https://lh3.googleusercontent.com/d/${fileId}=w1000`;
  }
  return trimmed;
}

// Preset gallery for quick 1-click cake photo selection
const CAKE_IMAGE_PRESETS = [
  { name: '苺ショート', url: 'https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=600&auto=format&fit=crop&q=80' },
  { name: 'ブッシュドノエル', url: 'https://images.unsplash.com/photo-1607958996333-41aef7caefaa?w=600&auto=format&fit=crop&q=80' },
  { name: 'ベイクドチーズ', url: 'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?w=600&auto=format&fit=crop&q=80' },
  { name: 'モンブラン', url: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=600&auto=format&fit=crop&q=80' },
  { name: 'ガトーショコラ', url: 'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=600&auto=format&fit=crop&q=80' },
  { name: 'シュークリーム', url: 'https://images.unsplash.com/photo-1612203985729-70726954388c?w=600&auto=format&fit=crop&q=80' },
  { name: 'フルーツタルト', url: 'https://images.unsplash.com/photo-1519869325930-281384150729?w=600&auto=format&fit=crop&q=80' },
  { name: '濃厚チョコ', url: 'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=600&auto=format&fit=crop&q=80' },
];

interface AdminCakeManagerProps {
  cakes: Cake[];
  onCakesChanged: (newCakes: Cake[]) => void;
  onToast?: (message: string) => void;
}

function formatDateTimeDisplay(scheduledAt?: string): string {
  if (!scheduledAt) return '';
  const dt = new Date(scheduledAt);
  if (isNaN(dt.getTime())) return scheduledAt.replace('T', ' ');
  return dt.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatShortScheduleBadge(scheduledAt?: string): string {
  if (!scheduledAt) return '';
  const dt = new Date(scheduledAt);
  if (isNaN(dt.getTime())) return scheduledAt.replace('T', ' ');
  return dt.toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRemainingTime(scheduledAt: string, nowMs: number): string {
  const targetMs = new Date(scheduledAt).getTime();
  if (isNaN(targetMs)) return '';
  const diff = targetMs - nowMs;
  if (diff <= 0) return '時刻到達（自動移行済）';
  const totalMinutes = Math.floor(diff / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;
  if (days > 0) {
    return `残り ${days}日 ${hours}時間${mins}分`;
  }
  if (hours > 0) {
    return `残り ${hours}時間 ${mins}分`;
  }
  const secs = Math.max(1, Math.floor((diff % 60000) / 1000));
  return mins > 0 ? `残り ${mins}分` : `残り ${secs}秒`;
}

function getLocalDateStr(dateObj: Date): string {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export default function AdminCakeManager({ cakes, onCakesChanged, onToast }: AdminCakeManagerProps) {
  const [editingCake, setEditingCake] = useState<Cake | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Expanded cake IDs for showing description, #tags & individual schedule on demand
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  // Category / Status filter to minimize scrolling
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'hall' | 'cut' | 'soldout' | 'scheduled'>('all');

  // Auto Sales-Stop Scheduler State
  const [scheduleRules, setScheduleRules] = useState<SalesStopScheduleRule[]>([]);
  const [isSchedulerOpen, setIsSchedulerOpen] = useState(true);
  const [schedDate, setSchedDate] = useState<string>(() => getLocalDateStr(new Date()));
  const [schedTime, setSchedTime] = useState<string>('18:00');
  const [schedScope, setSchedScope] = useState<'all' | 'hall' | 'cut' | 'custom'>('all');
  const [schedCustomCakeIds, setSchedCustomCakeIds] = useState<string[]>([]);
  const [schedLabel, setSchedLabel] = useState<string>('');
  const [isSavingSchedule, setIsSavingSchedule] = useState(false);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  // Inline per-cake schedule input state: { [cakeId]: "YYYY-MM-DDTHH:mm" }
  const [inlineCakeSchedules, setInlineCakeSchedules] = useState<Record<string, string>>({});

  // Form State for Cake Edit/Create Modal
  const [formId, setFormId] = useState('');
  const [formJpName, setFormJpName] = useState('');
  const [formName, setFormName] = useState('');
  const [formPrice, setFormPrice] = useState(3000);
  const [formCategory, setFormCategory] = useState<'hall' | 'cut' | 'seasonal' | 'tart'>('hall');
  const [formPortionLabel, setFormPortionLabel] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formImageUrl, setFormImageUrl] = useState('');
  const [formTags, setFormTags] = useState('');
  const [formStopSellingAt, setFormStopSellingAt] = useState('');
  const [imageLoadError, setImageLoadError] = useState(false);
  const [isSyncingFromCode, setIsSyncingFromCode] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  // Load and subscribe to sales-stop scheduler rules + run periodic evaluation
  useEffect(() => {
    let mounted = true;

    fetchSalesStopRules()
      .then((rules) => {
        if (mounted) setScheduleRules(rules);
      })
      .catch((err) => console.warn('Failed loading schedule rules:', err));

    const unsubscribe = subscribeToSalesStopRules((rules) => {
      if (mounted) setScheduleRules(rules);
    });

    const runCheck = async () => {
      try {
        const res = await evaluateAndExecuteSalesSchedules();
        if (mounted) {
          setScheduleRules(res.rules);
          if (res.triggered) {
            onCakesChanged(res.cakes);
            if (onToast && res.triggeredCakeNames.length > 0) {
              onToast(
                `⏰ スケジューラーにより「${res.triggeredCakeNames.join('・')}」を自動販売停止（オーダーストップ）に移行しました`
              );
            }
          }
        }
      } catch (err) {
        console.warn('Schedule evaluation notice:', err);
      }
    };

    runCheck();

    const intervalId = window.setInterval(() => {
      setNowTick(Date.now());
      runCheck();
    }, 10000);

    return () => {
      mounted = false;
      unsubscribe();
      window.clearInterval(intervalId);
    };
  }, []);

  const toggleExpand = (id: string, currentStopAt?: string) => {
    setExpandedIds((prev) => {
      const nextOpen = !prev[id];
      if (nextOpen && currentStopAt && !inlineCakeSchedules[id]) {
        setInlineCakeSchedules((s) => ({ ...s, [id]: currentStopAt }));
      }
      return { ...prev, [id]: nextOpen };
    });
  };

  // Counts for filter bar
  const safeCakes = useMemo(() => (Array.isArray(cakes) ? cakes.filter(Boolean) : []), [cakes]);

  const counts = useMemo(() => {
    const hall = safeCakes.filter((c) => c.category === 'hall').length;
    const cut = safeCakes.filter((c) => c.category === 'cut').length;
    const soldOut = safeCakes.filter((c) => c.isSoldOut).length;
    const scheduled = safeCakes.filter(
      (c) => c.stopSellingAt && !isScheduledStopTimeElapsed(c.stopSellingAt) && !c.isSoldOut
    ).length;
    return { all: safeCakes.length, hall, cut, soldOut, scheduled };
  }, [safeCakes, nowTick]);

  const activeWaitingRulesCount = useMemo(
    () =>
      scheduleRules.filter(
        (r) => r.enabled && !r.executed && !isScheduledStopTimeElapsed(r.scheduledAt)
      ).length,
    [scheduleRules, nowTick]
  );

  const filteredCakes = useMemo(() => {
    if (categoryFilter === 'all') return safeCakes;
    if (categoryFilter === 'soldout') return safeCakes.filter((c) => c.isSoldOut);
    if (categoryFilter === 'scheduled') {
      return safeCakes.filter((c) => Boolean(c.stopSellingAt));
    }
    return safeCakes.filter((c) => c.category === categoryFilter);
  }, [safeCakes, categoryFilter]);

  // Preset helper for quick date/time selection
  const applySchedulePreset = (preset: '1h' | 'today18' | 'tomorrow18' | '3days2359') => {
    const now = new Date();
    if (preset === '1h') {
      const target = new Date(now.getTime() + 60 * 60 * 1000);
      setSchedDate(getLocalDateStr(target));
      setSchedTime(
        `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`
      );
    } else if (preset === 'today18') {
      setSchedDate(getLocalDateStr(now));
      setSchedTime('18:00');
    } else if (preset === 'tomorrow18') {
      const tmr = new Date(now);
      tmr.setDate(now.getDate() + 1);
      setSchedDate(getLocalDateStr(tmr));
      setSchedTime('18:00');
    } else if (preset === '3days2359') {
      const d3 = new Date(now);
      d3.setDate(now.getDate() + 3);
      setSchedDate(getLocalDateStr(d3));
      setSchedTime('23:59');
    }
  };

  // Add new schedule rule
  const handleCreateScheduleRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!schedDate || !schedTime) {
      if (onToast) onToast('⚠️ 自動販売停止する日付と時間を指定してください');
      return;
    }
    if (schedScope === 'custom' && schedCustomCakeIds.length === 0) {
      if (onToast) onToast('⚠️ 対象とするケーキを1つ以上選択してください');
      return;
    }

    const scheduledAt = `${schedDate}T${schedTime}`;
    const defaultScopeLabel =
      schedScope === 'all'
        ? '全ケーキ一括自動停止'
        : schedScope === 'hall'
        ? 'ホールケーキ自動停止'
        : schedScope === 'cut'
        ? 'カットケーキ自動停止'
        : '選択ケーキ自動停止';

    setIsSavingSchedule(true);
    try {
      const result = await addSalesStopRule({
        label: schedLabel.trim() || defaultScopeLabel,
        scheduledAt,
        targetScope: schedScope,
        targetCakeIds: schedScope === 'custom' ? schedCustomCakeIds : undefined,
      });
      setScheduleRules(result.rules);
      onCakesChanged(result.cakes);
      setSchedLabel('');
      if (onToast) {
        onToast(
          result.executedImmediately
            ? `⚡ 指定日時が現在時刻を過ぎているため、直ちに販売停止ステータスへ移行しました`
            : `⏰ 自動販売停止スケジュール（${formatDateTimeDisplay(scheduledAt)}）を登録しました`
        );
      }
    } catch (err) {
      console.error('Failed creating schedule rule:', err);
      if (onToast) onToast('スケジュールの登録に失敗しました');
    } finally {
      setIsSavingSchedule(false);
    }
  };

  const handleToggleRule = async (rule: SalesStopScheduleRule) => {
    try {
      const res = await toggleSalesStopRule(rule.id, !rule.enabled);
      setScheduleRules(res.rules);
      onCakesChanged(res.cakes);
      if (onToast) {
        onToast(!rule.enabled ? `スケジュール「${rule.label}」を有効にしました` : `スケジュール「${rule.label}」を一時停止しました`);
      }
    } catch (err) {
      console.error('Failed toggling schedule rule:', err);
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    try {
      const res = await deleteSalesStopRule(ruleId);
      setScheduleRules(res.rules);
      onCakesChanged(res.cakes);
      if (onToast) onToast('スケジュールを削除しました');
    } catch (err) {
      console.error('Failed deleting schedule rule:', err);
    }
  };

  const handleBulkSoldOutChange = async (scope: 'all' | 'hall' | 'cut', isSoldOut: boolean) => {
    try {
      const updated = await bulkUpdateCakesSoldOut(scope, isSoldOut);
      onCakesChanged(updated);
      if (onToast) {
        const scopeLabel = scope === 'all' ? '全ケーキ' : scope === 'hall' ? 'ホールケーキ' : 'カットケーキ';
        onToast(isSoldOut ? `${scopeLabel}を一括で販売停止（売切）にしました` : `${scopeLabel}の販売を一括再開しました`);
      }
    } catch (err) {
      console.error('Bulk sold out update error:', err);
    }
  };

  // Toggle Sold-out (オーダーストップ)
  const handleToggleSoldOut = async (cake: Cake) => {
    const nextSoldOut = !cake.isSoldOut;
    try {
      const updated = await updateCakeSoldOut(cake.id, nextSoldOut);
      onCakesChanged(updated);
      if (onToast) {
        onToast(
          nextSoldOut
            ? `「${cake.jpName}」をオーダーストップ（売り切れ）に設定しました`
            : `「${cake.jpName}」の販売を再開しました`
        );
      }
    } catch (err) {
      console.error('Failed to toggle sold-out state:', err);
      if (onToast) onToast('売り切れステータスの更新に失敗しました');
    }
  };

  // Save per-cake inline schedule
  const handleSaveInlineCakeSchedule = async (cake: Cake, scheduledAtValue: string | null) => {
    try {
      const updated = await updateCakeSchedule(cake.id, scheduledAtValue);
      onCakesChanged(updated);
      if (!scheduledAtValue) {
        setInlineCakeSchedules((prev) => {
          const copy = { ...prev };
          delete copy[cake.id];
          return copy;
        });
        if (onToast) onToast(`「${cake.jpName}」の自動販売停止スケジュールを解除しました`);
      } else {
        if (onToast) {
          onToast(`⏰ 「${cake.jpName}」の自動販売停止日時を ${formatDateTimeDisplay(scheduledAtValue)} に設定しました`);
        }
      }
    } catch (err) {
      console.error('Failed saving cake schedule:', err);
      if (onToast) onToast('個別スケジュールの保存に失敗しました');
    }
  };

  // Open Edit Modal
  const handleOpenEdit = (cake: Cake) => {
    setIsCreatingNew(false);
    setEditingCake(cake);
    setFormId(cake.id);
    setFormJpName(cake.jpName);
    setFormName(cake.name);
    setFormPrice(cake.price);
    setFormCategory(cake.category);
    setFormPortionLabel(cake.portionLabel || '');
    setFormDescription(cake.description);
    setFormImageUrl(cake.imageUrl);
    setFormTags(cake.tags ? cake.tags.join(', ') : '');
    setFormStopSellingAt(cake.stopSellingAt || '');
    setImageLoadError(false);
  };

  // Open Create Modal
  const handleOpenCreate = () => {
    setIsCreatingNew(true);
    const newId = 'cake-' + Date.now();
    setEditingCake({
      id: newId,
      name: '',
      jpName: '',
      description: '',
      price: 3000,
      imageUrl: DEFAULT_FALLBACK_IMAGE,
      category: 'hall',
      tags: ['新作', '限定'],
      isSoldOut: false,
      portionLabel: '４号（直径１５㎝）',
    });
    setFormId(newId);
    setFormJpName('');
    setFormName('');
    setFormPrice(3000);
    setFormCategory('hall');
    setFormPortionLabel('４号（直径１５㎝）');
    setFormDescription('');
    setFormImageUrl(DEFAULT_FALLBACK_IMAGE);
    setFormTags('新作, 限定');
    setFormStopSellingAt('');
    setImageLoadError(false);
  };

  // Image File Upload with Auto-Resizing & Compression to Data URL
  const handleImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      if (onToast) onToast('⚠️ 写真・画像ファイル（JPG, PNG, WebPなど）を選択してください');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const rawDataUrl = event.target?.result as string;
      if (!rawDataUrl) return;

      const img = new Image();
      img.onload = () => {
        const maxDim = 640;
        let width = img.width;
        let height = img.height;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.75);
          setFormImageUrl(compressedDataUrl);
          setImageLoadError(false);
          if (onToast) onToast('📸 端末から写真を読み込み、最適化しました！');
        } else {
          setFormImageUrl(rawDataUrl);
          setImageLoadError(false);
        }
      };
      img.src = rawDataUrl;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // Sync cake images and definitions from codebase (src/data/cakes.ts)
  const handleSyncFromCode = async () => {
    setIsSyncingFromCode(true);
    try {
      const updated = await syncCakesFromDefaultCode();
      onCakesChanged(updated);
      if (onToast) onToast('🔄 コード定義の最新ケーキ画像・情報をデータベースへ同期しました！');
    } catch (err) {
      console.error('Failed to sync cakes from code:', err);
      if (onToast) onToast('⚠️ コード定義の同期に失敗しました');
    } finally {
      setIsSyncingFromCode(false);
    }
  };

  // Save Cake Form
  const handleSaveCake = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formJpName.trim()) {
      if (onToast) onToast('⚠️ ケーキ名（日本語）を入力してください');
      return;
    }
    if (formPrice <= 0) {
      if (onToast) onToast('⚠️ 有効な価格を入力してください');
      return;
    }

    setIsSubmitting(true);
    try {
      const parsedTags = formTags
        .split(/[,、]/)
        .map((t) => t.trim())
        .filter(Boolean);

      const cleanStopAt = formStopSellingAt.trim() || undefined;
      const scheduleElapsed = isScheduledStopTimeElapsed(cleanStopAt);
      const normalizedImg = normalizeImageUrl(formImageUrl.trim()) || DEFAULT_FALLBACK_IMAGE;

      const cakeToSave: Cake = {
        id: formId || 'cake-' + Date.now(),
        jpName: formJpName.trim(),
        name: formName.trim() || formJpName.trim(),
        price: Number(formPrice),
        category: formCategory,
        portionLabel: formPortionLabel.trim() || undefined,
        description: formDescription.trim(),
        imageUrl: normalizedImg,
        tags: parsedTags.length > 0 ? parsedTags : ['おすすめ'],
        isSoldOut: Boolean(editingCake?.isSoldOut) || scheduleElapsed,
        ...(cleanStopAt ? { stopSellingAt: cleanStopAt } : {}),
        ...(scheduleElapsed ? { autoStoppedAt: new Date().toISOString() } : {}),
      };

      const updatedList = await saveCakeItem(cakeToSave);
      onCakesChanged(updatedList);
      if (onToast) {
        onToast(
          isCreatingNew
            ? `「${cakeToSave.jpName}」を新規登録しました`
            : `「${cakeToSave.jpName}」の情報を更新しました（画像反映完了）`
        );
      }
      setEditingCake(null);
    } catch (err) {
      console.error('Failed to save cake:', err);
      if (onToast) onToast('ケーキ情報の保存に失敗しました');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Delete Cake
  const handleDeleteCake = async (cake: Cake) => {
    try {
      const updatedList = await deleteCakeItem(cake.id);
      onCakesChanged(updatedList);
      if (onToast) {
        onToast(`「${cake.jpName}」を削除しました`);
      }
    } catch (err) {
      console.error('Failed to delete cake:', err);
      if (onToast) onToast('ケーキの削除に失敗しました');
    }
  };

  return (
    <div id="admin-cake-manager-section" className="space-y-4">
      {/* ===================================================================== */}
      {/* AUTO SALES-STOP SCHEDULER CARD (自動販売停止スケジューラー設定) */}
      {/* ===================================================================== */}
      <div
        id="admin-sales-stop-scheduler"
        className="bg-white rounded-2xl border border-amber-300/90 shadow-xs overflow-hidden"
      >
        {/* Scheduler Top Bar */}
        <div
          onClick={() => setIsSchedulerOpen((prev) => !prev)}
          className="px-4 py-3.5 sm:px-5 sm:py-4 bg-gradient-to-r from-stone-900 via-stone-900 to-stone-800 text-white flex items-center justify-between gap-3 cursor-pointer select-none"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-amber-500/20 border border-amber-400/40 flex items-center justify-center text-[#D4AF37] shrink-0">
              <Clock className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm sm:text-base font-serif font-medium text-white tracking-wide">
                  自動販売停止スケジューラー設定
                </h3>
                {activeWaitingRulesCount > 0 || counts.scheduled > 0 ? (
                  <span className="text-[10px] sm:text-[11px] font-mono font-bold bg-amber-500 text-stone-950 px-2 py-0.5 rounded-full">
                    稼働中スケジュール: {Math.max(activeWaitingRulesCount, counts.scheduled)}件
                  </span>
                ) : (
                  <span className="text-[10px] font-mono text-stone-300 bg-white/10 px-2 py-0.5 rounded-full">
                    待機中スケジュールなし
                  </span>
                )}
              </div>
              <p className="text-[11px] text-stone-300 mt-0.5 leading-relaxed break-words">
                指定した日付・時刻が経過した際に、自動的に「売り切れ（販売停止）」ステータスへ移行します
              </p>
            </div>
          </div>

          <button
            type="button"
            className="text-xs text-amber-300 hover:text-white font-semibold flex items-center gap-1 shrink-0 px-2.5 py-1 rounded-lg bg-white/10"
          >
            <span>{isSchedulerOpen ? '閉じる' : '設定を開く'}</span>
            {isSchedulerOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>

        {/* Scheduler Body */}
        {isSchedulerOpen && (
          <div className="p-4 sm:p-5 space-y-4 bg-[#FCFBF9] text-xs">
            {/* Add New Schedule Form */}
            <form
              onSubmit={handleCreateScheduleRule}
              className="bg-white p-3.5 sm:p-4 rounded-xl border border-stone-200/90 space-y-3.5 shadow-2xs"
            >
              <div className="flex items-center justify-between gap-2 flex-wrap border-b border-stone-100 pb-2">
                <span className="font-bold text-stone-800 flex items-center gap-1.5 text-xs sm:text-sm">
                  <Calendar className="w-4 h-4 text-sleek-gold" />
                  新しい自動販売停止タイマーを登録
                </span>

                {/* Quick Time Presets */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] text-stone-400 font-mono">クイック指定:</span>
                  <button
                    type="button"
                    onClick={() => applySchedulePreset('1h')}
                    className="px-2 py-1 rounded-md bg-stone-100 hover:bg-amber-50 hover:text-amber-900 text-stone-700 font-medium text-[11px] border border-stone-200 cursor-pointer"
                  >
                    1時間後
                  </button>
                  <button
                    type="button"
                    onClick={() => applySchedulePreset('today18')}
                    className="px-2 py-1 rounded-md bg-stone-100 hover:bg-amber-50 hover:text-amber-900 text-stone-700 font-medium text-[11px] border border-stone-200 cursor-pointer"
                  >
                    本日 18:00
                  </button>
                  <button
                    type="button"
                    onClick={() => applySchedulePreset('tomorrow18')}
                    className="px-2 py-1 rounded-md bg-stone-100 hover:bg-amber-50 hover:text-amber-900 text-stone-700 font-medium text-[11px] border border-stone-200 cursor-pointer"
                  >
                    明日 18:00
                  </button>
                  <button
                    type="button"
                    onClick={() => applySchedulePreset('3days2359')}
                    className="px-2 py-1 rounded-md bg-stone-100 hover:bg-amber-50 hover:text-amber-900 text-stone-700 font-medium text-[11px] border border-stone-200 cursor-pointer"
                  >
                    3日後 23:59
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
                {/* Date Input */}
                <div className="sm:col-span-3 space-y-1">
                  <label className="block text-[11px] font-bold text-stone-700">
                    販売停止日 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={schedDate}
                    onChange={(e) => setSchedDate(e.target.value)}
                    className="w-full px-2.5 py-2 border border-stone-300 rounded-xl text-xs font-mono bg-white focus:outline-none focus:ring-1 focus:ring-sleek-gold"
                  />
                </div>

                {/* Time Input */}
                <div className="sm:col-span-2 space-y-1">
                  <label className="block text-[11px] font-bold text-stone-700">
                    停止時刻 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="time"
                    required
                    value={schedTime}
                    onChange={(e) => setSchedTime(e.target.value)}
                    className="w-full px-2.5 py-2 border border-stone-300 rounded-xl text-xs font-mono bg-white focus:outline-none focus:ring-1 focus:ring-sleek-gold"
                  />
                </div>

                {/* Target Scope */}
                <div className="sm:col-span-3 space-y-1">
                  <label className="block text-[11px] font-bold text-stone-700">
                    対象ケーキ範囲
                  </label>
                  <select
                    value={schedScope}
                    onChange={(e) => setSchedScope(e.target.value as any)}
                    className="w-full px-2.5 py-2 border border-stone-300 rounded-xl text-xs bg-white focus:outline-none focus:ring-1 focus:ring-sleek-gold font-medium"
                  >
                    <option value="all">すべてのケーキ（一括停止）</option>
                    <option value="hall">ホールケーキのみすべて</option>
                    <option value="cut">カットケーキのみすべて</option>
                    <option value="custom">ケーキを個別に選択...</option>
                  </select>
                </div>

                {/* Optional Label */}
                <div className="sm:col-span-2 space-y-1">
                  <label className="block text-[11px] font-bold text-stone-700">
                    メモ・名称（任意）
                  </label>
                  <input
                    type="text"
                    value={schedLabel}
                    onChange={(e) => setSchedLabel(e.target.value)}
                    placeholder="例: 予約締切"
                    className="w-full px-2.5 py-2 border border-stone-300 rounded-xl text-xs bg-white focus:outline-none focus:ring-1 focus:ring-sleek-gold"
                  />
                </div>

                {/* Submit Button */}
                <div className="sm:col-span-2">
                  <button
                    type="submit"
                    disabled={isSavingSchedule}
                    className="w-full py-2 px-3 bg-sleek-dark hover:bg-black disabled:opacity-50 text-[#D4AF37] font-bold rounded-xl text-xs flex items-center justify-center gap-1.5 shadow-sm transition-all cursor-pointer active:scale-95"
                  >
                    <Clock className="w-3.5 h-3.5 shrink-0" />
                    <span>{isSavingSchedule ? '保存中...' : 'タイマー登録'}</span>
                  </button>
                </div>
              </div>

              {/* Custom Cake Checkboxes when targetScope === 'custom' */}
              {schedScope === 'custom' && (
                <div className="pt-2 border-t border-stone-100 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-stone-700">
                      自動販売停止するケーキを選択してください（{schedCustomCakeIds.length}件選択中）
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSchedCustomCakeIds(safeCakes.map((c) => c.id))}
                        className="text-[11px] text-amber-800 hover:underline font-semibold cursor-pointer"
                      >
                        すべて選択
                      </button>
                      <button
                        type="button"
                        onClick={() => setSchedCustomCakeIds([])}
                        className="text-[11px] text-stone-500 hover:underline cursor-pointer"
                      >
                        選択解除
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-1.5 max-h-36 overflow-y-auto p-1">
                    {safeCakes.map((c) => {
                      const checked = schedCustomCakeIds.includes(c.id);
                      return (
                        <label
                          key={c.id}
                          className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs cursor-pointer transition-colors ${
                            checked
                              ? 'bg-amber-50 border-amber-300 text-amber-950 font-semibold'
                              : 'bg-stone-50 border-stone-200 text-stone-700 hover:bg-stone-100'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSchedCustomCakeIds((prev) => [...prev, c.id]);
                              } else {
                                setSchedCustomCakeIds((prev) => prev.filter((id) => id !== c.id));
                              }
                            }}
                            className="rounded accent-stone-900"
                          />
                          <span className="truncate">{c.jpName}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </form>

            {/* Registered Schedule Rules List */}
            {scheduleRules.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[11px] font-bold text-stone-600 px-1">
                  <span>登録済み自動販売停止スケジュール（{scheduleRules.length}件）</span>
                  <span className="font-mono text-[10px] text-stone-400">※10秒ごとに自動判定・予約確定時にもリアルタイム判定されます</span>
                </div>
                <div className="divide-y divide-stone-200 border border-stone-200 rounded-xl bg-white overflow-hidden">
                  {scheduleRules.map((rule) => {
                    const isElapsed = Boolean(rule.executed) || isScheduledStopTimeElapsed(rule.scheduledAt);
                    const scopeBadge =
                      rule.targetScope === 'all'
                        ? '全ケーキ一括'
                        : rule.targetScope === 'hall'
                        ? 'ホールケーキすべて'
                        : rule.targetScope === 'cut'
                        ? 'カットケーキすべて'
                        : `個別選択 (${rule.targetCakeIds?.length || 0}種)`;

                    return (
                      <div
                        key={rule.id}
                        className={`p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 ${
                          !rule.enabled
                            ? 'bg-stone-50 text-stone-400'
                            : isElapsed
                            ? 'bg-red-50/35'
                            : 'bg-white'
                        }`}
                      >
                        <div className="flex items-start sm:items-center gap-2.5 flex-wrap min-w-0">
                          {!rule.enabled ? (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-stone-200 text-stone-600 shrink-0">
                              ⏸ 一時停止
                            </span>
                          ) : isElapsed ? (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-600 text-white flex items-center gap-1 shrink-0">
                              <Zap className="w-3 h-3" />
                              自動販売停止 実行済
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300 flex items-center gap-1 shrink-0">
                              <Clock className="w-3 h-3 text-amber-700" />
                              {formatRemainingTime(rule.scheduledAt, nowTick)}
                            </span>
                          )}

                          <span className="font-mono font-bold text-xs sm:text-sm text-stone-900">
                            {formatDateTimeDisplay(rule.scheduledAt)}
                          </span>

                          <span className="px-2 py-0.5 rounded-md bg-stone-100 border border-stone-200 text-stone-700 text-[11px] font-semibold">
                            対象: {scopeBadge}
                          </span>

                          <span className="text-xs font-medium text-stone-700 truncate">
                            {rule.label}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5 self-end sm:self-center shrink-0">
                          {!isElapsed && (
                            <button
                              type="button"
                              onClick={() => handleToggleRule(rule)}
                              className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border cursor-pointer transition-colors ${
                                rule.enabled
                                  ? 'bg-stone-100 hover:bg-stone-200 text-stone-700 border-stone-300'
                                  : 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-700'
                              }`}
                            >
                              {rule.enabled ? '一時無効化' : '有効にする'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleDeleteRule(rule.id)}
                            className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-white hover:bg-red-50 text-stone-500 hover:text-red-600 border border-stone-200 cursor-pointer flex items-center gap-1"
                          >
                            <Trash2 className="w-3 h-3" />
                            <span>削除</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Quick Bulk Manual Override Controls */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-stone-200/80">
              <span className="text-[11px] text-stone-500">
                💡 各ケーキの「詳細」または「編集」から、ケーキ1品ごとに異なる自動販売停止日時を設定することも可能です。
              </span>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => handleBulkSoldOutChange('all', true)}
                  className="px-3 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 text-[11px] font-bold flex items-center gap-1 cursor-pointer"
                >
                  <Power className="w-3 h-3" />
                  全ケーキを今すぐ販売停止
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkSoldOutChange('all', false)}
                  className="px-3 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 text-[11px] font-bold flex items-center gap-1 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  全ケーキの売切を一括解除
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Compact Header with Add Button & Quick Category Filter */}
      <div className="bg-white p-4 sm:p-5 rounded-2xl border border-sleek-border shadow-xs space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-base sm:text-lg font-serif font-light text-sleek-dark flex items-center gap-2">
              <ShoppingBag className="w-4 h-4 sm:w-5 sm:h-5 text-sleek-gold shrink-0" />
              <span>ケーキ商品管理・売り切れ設定</span>
            </h3>
            <p className="text-[11px] sm:text-xs text-sleek-muted mt-0.5">
              各商品の「ケーキ情報を編集」から画像・価格・紹介文を変更して保存すると、即座にサイト全体へ反映されます。
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <button
              type="button"
              onClick={handleSyncFromCode}
              disabled={isSyncingFromCode}
              className="px-3.5 py-2 bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all shadow-2xs active:scale-95 cursor-pointer disabled:opacity-50"
              title="コード（src/data/cakes.ts）側の最新画像や商品定義をデータベースへ同期・反映します"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-amber-700 ${isSyncingFromCode ? 'animate-spin' : ''}`} />
              <span>{isSyncingFromCode ? '同期中...' : 'コード定義データを同期'}</span>
            </button>
            <button
              id="btn-add-new-cake"
              onClick={handleOpenCreate}
              className="px-3.5 py-2 bg-sleek-dark hover:bg-black text-white rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all shadow-sm active:scale-95 cursor-pointer"
            >
              <Plus className="w-4 h-4 text-sleek-gold" />
              <span>新しいケーキを追加</span>
            </button>
          </div>
        </div>

        {/* Helpful Info Tip */}
        <div className="bg-amber-50/60 p-2.5 rounded-xl border border-amber-200/80 text-[11px] text-amber-900 flex items-start gap-2">
          <Info className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
          <div className="leading-relaxed">
            <strong>画像の変更について：</strong> 各商品の「ケーキ情報を編集」画面で「写真・画像ファイルを選択」から直接画像を選ぶと、自動最適化されて即座に反映されます。また、コード（<code className="bg-amber-100 px-1 py-0.5 rounded font-mono text-[10px]">src/data/cakes.ts</code>）で画像や説明文を変更した場合は、右上の「コード定義データを同期」を押すとデータベースへ即時反映されます。
          </div>
        </div>

        {/* Filter Bar to minimize scrolling */}
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-stone-100 flex-wrap">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setCategoryFilter('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                categoryFilter === 'all'
                  ? 'bg-sleek-dark text-white'
                  : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
              }`}
            >
              すべて ({counts.all})
            </button>
            <button
              type="button"
              onClick={() => setCategoryFilter('hall')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                categoryFilter === 'hall'
                  ? 'bg-sleek-dark text-white'
                  : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
              }`}
            >
              ホールケーキ ({counts.hall})
            </button>
            <button
              type="button"
              onClick={() => setCategoryFilter('cut')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                categoryFilter === 'cut'
                  ? 'bg-sleek-dark text-white'
                  : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
              }`}
            >
              カットケーキ ({counts.cut})
            </button>
            <button
              type="button"
              onClick={() => setCategoryFilter('soldout')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                categoryFilter === 'soldout'
                  ? 'bg-red-600 text-white'
                  : counts.soldOut > 0
                  ? 'bg-red-50 text-red-700 border border-red-200 hover:bg-red-100'
                  : 'bg-stone-100 text-stone-500 hover:bg-stone-200'
              }`}
            >
              売切中 ({counts.soldOut})
            </button>
            <button
              type="button"
              onClick={() => setCategoryFilter('scheduled')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer flex items-center gap-1 ${
                categoryFilter === 'scheduled'
                  ? 'bg-amber-600 text-white'
                  : counts.scheduled > 0
                  ? 'bg-amber-50 text-amber-900 border border-amber-300 hover:bg-amber-100'
                  : 'bg-stone-100 text-stone-500 hover:bg-stone-200'
              }`}
            >
              <Clock className="w-3 h-3" />
              <span>自動停止予定 ({counts.scheduled})</span>
            </button>
          </div>

          {filteredCakes.length > 0 && (
            <button
              type="button"
              onClick={() => {
                const allExpanded = filteredCakes.every((c) => expandedIds[c.id]);
                const next: Record<string, boolean> = { ...expandedIds };
                filteredCakes.forEach((c) => {
                  next[c.id] = !allExpanded;
                });
                setExpandedIds(next);
              }}
              className="text-[11px] text-stone-500 hover:text-sleek-dark font-medium flex items-center gap-1 whitespace-nowrap cursor-pointer"
            >
              {filteredCakes.every((c) => expandedIds[c.id]) ? (
                <>
                  <ChevronUp className="w-3.5 h-3.5" />
                  <span>詳細をすべて閉じる</span>
                </>
              ) : (
                <>
                  <ChevronDown className="w-3.5 h-3.5" />
                  <span>詳細をすべて開く</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Compact Cakes List (2 columns on desktop, 1 column compact rows on mobile) */}
      {filteredCakes.length === 0 ? (
        <div className="bg-white rounded-2xl border border-sleek-border p-8 text-center text-xs text-sleek-muted">
          該当するケーキはありません。
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
          {filteredCakes.map((cake, index) => {
            const isSoldOut = !!cake.isSoldOut;
            const isExpanded = !!expandedIds[cake.id];
            const hasFutureSchedule =
              Boolean(cake.stopSellingAt) && !isScheduledStopTimeElapsed(cake.stopSellingAt) && !isSoldOut;
            const wasAutoStopped = isSoldOut && Boolean(cake.autoStoppedAt);

            return (
              <div
                key={cake.id}
                id={`admin-cake-item-${cake.id}`}
                className={`rounded-xl border transition-all overflow-hidden ${
                  isSoldOut
                    ? 'border-red-300 bg-red-50/40'
                    : hasFutureSchedule
                    ? 'border-amber-300 bg-amber-50/20'
                    : index % 2 === 0
                    ? 'border-sleek-border bg-white'
                    : 'border-sleek-border bg-[#FAF8F5]'
                }`}
              >
                {/* Main Compact Row */}
                <div className="p-2.5 sm:p-3 flex items-center gap-2.5 sm:gap-3">
                  {/* Small Thumbnail Image */}
                  <div className="relative w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-sleek-cream overflow-hidden shrink-0 border border-stone-200/80">
                    <img
                      src={cake.imageUrl}
                      alt={cake.jpName}
                      className={`w-full h-full object-cover ${isSoldOut ? 'grayscale opacity-75' : ''}`}
                      referrerPolicy="no-referrer"
                      onError={(e) => {
                        const target = e.currentTarget as HTMLImageElement;
                        if (target.src !== DEFAULT_FALLBACK_IMAGE) {
                          target.src = DEFAULT_FALLBACK_IMAGE;
                        }
                      }}
                    />
                    {isSoldOut && (
                      <div className="absolute inset-0 bg-red-900/45 flex items-center justify-center">
                        <span className="text-[9px] font-bold text-white bg-red-600 px-1 py-0.5 rounded leading-none">
                          売切
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Center: Essential Info (Category, Name, Price, Schedule Badge) */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center flex-wrap gap-x-1.5 gap-y-0.5 text-[10px] sm:text-[11px] text-stone-500 leading-tight">
                      <span className="font-semibold text-stone-700">
                        {CATEGORY_LABELS[cake.category as keyof typeof CATEGORY_LABELS] || cake.category}
                      </span>
                      {cake.portionLabel && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="truncate">{cake.portionLabel}</span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      {isSoldOut ? (
                        <span className="text-red-600 font-bold inline-flex items-center gap-0.5">
                          <AlertCircle className="w-3 h-3" />
                          {wasAutoStopped ? '自動販売停止済' : '売切（ストップ中）'}
                        </span>
                      ) : (
                        <span className="text-emerald-700 font-bold inline-flex items-center gap-0.5">
                          <Check className="w-3 h-3" />
                          販売中
                        </span>
                      )}
                      {hasFutureSchedule && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded bg-amber-100 text-amber-900 border border-amber-300 font-mono font-bold text-[10px]">
                          <Clock className="w-2.5 h-2.5 text-amber-700" />
                          {formatShortScheduleBadge(cake.stopSellingAt)} 停止予定
                        </span>
                      )}
                    </div>

                    <div className="flex items-baseline justify-between gap-2 mt-0.5">
                      <h4
                        className={`font-serif text-sm sm:text-base font-medium truncate ${
                          isSoldOut ? 'text-red-950' : 'text-sleek-dark'
                        }`}
                      >
                        {cake.jpName}
                      </h4>
                      <span className="text-sm sm:text-base font-serif font-semibold text-sleek-gold tabular-nums shrink-0">
                        ¥{(Number(cake.price) || 0).toLocaleString()}
                      </span>
                    </div>
                  </div>

                  {/* Right: Compact Action Buttons (1-tap Sold-Out Toggle + Details) */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      id={`btn-toggle-soldout-${cake.id}`}
                      type="button"
                      onClick={() => handleToggleSoldOut(cake)}
                      className={`px-2.5 py-2 rounded-lg text-[11px] sm:text-xs font-bold transition-all flex items-center gap-1 whitespace-nowrap cursor-pointer active:scale-95 ${
                        isSoldOut
                          ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs'
                          : 'bg-red-50 hover:bg-red-100 text-red-700 border border-red-200'
                      }`}
                      title={isSoldOut ? '販売再開にする' : '手動で売り切れにする'}
                    >
                      <Power className="w-3.5 h-3.5 shrink-0" />
                      <span>{isSoldOut ? '販売再開' : '売切にする'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => toggleExpand(cake.id, cake.stopSellingAt)}
                      aria-expanded={isExpanded}
                      className={`px-2.5 py-2 rounded-lg text-[11px] sm:text-xs font-semibold border transition-colors flex items-center gap-1 whitespace-nowrap cursor-pointer ${
                        isExpanded
                          ? 'bg-stone-800 text-white border-stone-800'
                          : 'bg-white hover:bg-stone-100 text-stone-700 border-stone-200'
                      }`}
                    >
                      <span>詳細</span>
                      {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                {/* Collapsible Detail Section: Individual Auto-Stop Timer, Description, #Tags, Edit & Delete */}
                {isExpanded && (
                  <div className="px-3 pb-3 pt-2 border-t border-stone-200/80 bg-stone-50/70 space-y-2.5 text-xs">
                    {/* Individual Cake Auto-Stop Schedule Control */}
                    <div className="bg-amber-50/70 border border-amber-200/90 rounded-lg p-2.5 space-y-1.5">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="text-[11px] font-bold text-amber-950 flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5 text-amber-700" />
                          このケーキの自動販売停止日時（指定日時で売切へ自動移行）
                        </span>
                        {cake.stopSellingAt && (
                          <span className="text-[10px] font-mono font-bold text-amber-800">
                            現在設定: {formatDateTimeDisplay(cake.stopSellingAt)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <input
                          type="datetime-local"
                          value={
                            inlineCakeSchedules[cake.id] !== undefined
                              ? inlineCakeSchedules[cake.id]
                              : cake.stopSellingAt || ''
                          }
                          onChange={(e) =>
                            setInlineCakeSchedules((prev) => ({
                              ...prev,
                              [cake.id]: e.target.value,
                            }))
                          }
                          className="px-2.5 py-1.5 bg-white border border-amber-300 rounded-lg text-xs font-mono text-stone-800 focus:outline-none focus:ring-1 focus:ring-sleek-gold"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const val =
                              inlineCakeSchedules[cake.id] !== undefined
                                ? inlineCakeSchedules[cake.id]
                                : cake.stopSellingAt || '';
                            if (!val) {
                              if (onToast) onToast('⚠️ 日時を選択してください');
                              return;
                            }
                            handleSaveInlineCakeSchedule(cake, val);
                          }}
                          className="px-2.5 py-1.5 bg-stone-900 hover:bg-black text-amber-300 rounded-lg text-[11px] font-bold cursor-pointer"
                        >
                          日時を保存
                        </button>
                        {cake.stopSellingAt && (
                          <button
                            type="button"
                            onClick={() => handleSaveInlineCakeSchedule(cake, null)}
                            className="px-2.5 py-1.5 bg-white hover:bg-red-50 text-red-600 border border-red-200 rounded-lg text-[11px] font-semibold cursor-pointer"
                          >
                            スケジュール解除
                          </button>
                        )}
                      </div>
                    </div>

                    {/* English Name & Full Price info */}
                    <div className="flex items-center justify-between gap-2 text-[11px] text-stone-500">
                      <span className="font-mono truncate">洋名: {cake.name || '—'}</span>
                      <span>税込価格: ¥{(Number(cake.price) || 0).toLocaleString()}</span>
                    </div>

                    {/* Cake Description (紹介文) */}
                    <div className="bg-white p-2.5 rounded-lg border border-stone-200/80 text-stone-700 leading-relaxed">
                      <div className="text-[10px] font-bold text-stone-400 mb-0.5 flex items-center gap-1">
                        <Info className="w-3 h-3 text-sleek-gold" />
                        <span>紹介文・こだわり</span>
                      </div>
                      <p className="text-xs text-stone-700 whitespace-pre-wrap">
                        {cake.description || '紹介文は登録されていません。'}
                      </p>
                    </div>

                    {/* #Tags & Edit/Delete Controls */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-0.5">
                      {/* Tags */}
                      <div className="flex items-center flex-wrap gap-1.5 text-[11px] text-stone-600 font-mono">
                        {Array.isArray(cake.tags) && cake.tags.length > 0 ? (
                          cake.tags.map((t, idx) => (
                            <React.Fragment key={`${t}-${idx}`}>
                              {idx > 0 && <span className="text-stone-300">·</span>}
                              <span>#{t}</span>
                            </React.Fragment>
                          ))
                        ) : (
                          <span className="text-stone-400">タグなし</span>
                        )}
                      </div>

                      {/* Edit & Delete Buttons */}
                      <div className="flex items-center gap-1.5 self-end sm:self-auto shrink-0">
                        <button
                          type="button"
                          onClick={() => handleOpenEdit(cake)}
                          className="py-1.5 px-3 bg-white hover:bg-sleek-cream text-sleek-dark border border-sleek-border rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer active:scale-95"
                        >
                          <Edit3 className="w-3.5 h-3.5 text-sleek-gold" />
                          <span>ケーキ情報を編集</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteCake(cake)}
                          className="py-1.5 px-2.5 bg-white hover:bg-red-50 text-stone-400 hover:text-red-600 border border-sleek-border rounded-lg text-xs flex items-center gap-1 transition-colors cursor-pointer"
                          title="ケーキを削除"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>削除</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Edit / Create Cake Modal Drawer */}
      <AnimatePresence>
        {editingCake && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-stone-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50 overflow-y-auto"
            onClick={() => setEditingCake(null)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-white rounded-3xl max-w-lg w-full overflow-hidden shadow-2xl border border-sleek-border flex flex-col max-h-[90vh]"
            >
              {/* Modal Header */}
              <div className="p-5 border-b border-sleek-border flex items-center justify-between bg-sleek-cream">
                <div className="flex items-center gap-2">
                  <ShoppingBag className="w-5 h-5 text-sleek-gold" />
                  <h3 className="font-serif font-light text-lg text-sleek-dark">
                    {isCreatingNew ? '新しいケーキを追加' : `ケーキ情報の変更（${editingCake.jpName}）`}
                  </h3>
                </div>
                <button
                  onClick={() => setEditingCake(null)}
                  className="p-1 rounded-full text-stone-400 hover:text-stone-700 hover:bg-stone-200 text-xs w-7 h-7 flex items-center justify-center font-bold"
                >
                  ✕
                </button>
              </div>

              {/* Modal Form Body */}
              <form onSubmit={handleSaveCake} className="p-5 space-y-4 overflow-y-auto flex-grow text-xs">
                {/* Cake Name (JP) & Romanized Name */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="font-bold text-stone-700 block">
                      ケーキ名（日本語） <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      value={formJpName}
                      onChange={(e) => setFormJpName(e.target.value)}
                      placeholder="例: クリスマスショート"
                      className="w-full px-3 py-2 border border-sleek-border rounded-xl text-xs sm:text-sm focus:outline-none focus:ring-1 focus:ring-sleek-gold"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="font-bold text-stone-700 block">洋名（アルファベット）</label>
                    <input
                      type="text"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="例: Gâteau aux fraises"
                      className="w-full px-3 py-2 border border-sleek-border rounded-xl text-xs sm:text-sm focus:outline-none focus:ring-1 focus:ring-sleek-gold font-mono"
                    />
                  </div>
                </div>

                {/* Price, Category & Portion Label */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <label className="font-bold text-stone-700 block">
                      価格（税込・円） <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="number"
                      required
                      min={50}
                      step={10}
                      value={formPrice}
                      onChange={(e) => setFormPrice(Number(e.target.value))}
                      className="w-full px-3 py-2 border border-sleek-border rounded-xl text-xs sm:text-sm focus:outline-none focus:ring-1 focus:ring-sleek-gold font-sans font-bold text-sleek-gold"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="font-bold text-stone-700 block">カテゴリ</label>
                    <select
                      value={formCategory}
                      onChange={(e) => setFormCategory(e.target.value as any)}
                      className="w-full px-3 py-2 border border-sleek-border rounded-xl text-xs bg-white focus:outline-none focus:ring-1 focus:ring-sleek-gold"
                    >
                      <option value="hall">ホールケーキ</option>
                      <option value="cut">カットケーキ</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="font-bold text-stone-700 block">サイズ目安表記</label>
                    <input
                      type="text"
                      value={formPortionLabel}
                      onChange={(e) => setFormPortionLabel(e.target.value)}
                      placeholder="例: ４号（直径１５㎝）"
                      className="w-full px-3 py-2 border border-sleek-border rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-sleek-gold"
                    />
                  </div>
                </div>

                {/* Auto Sales-Stop DateTime in Modal */}
                <div className="space-y-1 bg-amber-50/70 p-3 rounded-xl border border-amber-200">
                  <label className="font-bold text-amber-950 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5 text-amber-700" />
                      自動販売停止日時（指定日時で自動的に売切へ移行）
                    </span>
                    {formStopSellingAt && (
                      <button
                        type="button"
                        onClick={() => setFormStopSellingAt('')}
                        className="text-[11px] text-red-600 hover:underline font-medium"
                      >
                        クリア
                      </button>
                    )}
                  </label>
                  <input
                    type="datetime-local"
                    value={formStopSellingAt}
                    onChange={(e) => setFormStopSellingAt(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-amber-300 rounded-xl text-xs font-mono focus:outline-none focus:ring-1 focus:ring-sleek-gold"
                  />
                </div>

                {/* Description */}
                <div className="space-y-1">
                  <label className="font-bold text-stone-700 block">
                    商品説明・紹介文（パティシエのこだわり）
                  </label>
                  <textarea
                    rows={3}
                    value={formDescription}
                    onChange={(e) => setFormDescription(e.target.value)}
                    placeholder="素材や製法のこだわり、おすすめの食べ方など..."
                    className="w-full px-3 py-2 border border-sleek-border rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-sleek-gold leading-relaxed"
                  />
                </div>

                {/* Image Selection & URL (ファイルアップロード / URL入力 / 定番写真プリセット) */}
                <div className="space-y-2.5 bg-stone-50 p-3.5 sm:p-4 rounded-2xl border border-stone-200">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <label className="font-bold text-stone-800 text-xs flex items-center gap-1.5">
                      <ImageIcon className="w-4 h-4 text-sleek-gold" />
                      <span>ケーキ画像の設定</span>
                      <span className="text-red-500">*</span>
                    </label>

                    {/* Direct File Upload Trigger Button */}
                    <div>
                      <input
                        type="file"
                        ref={fileInputRef}
                        accept="image/*"
                        className="hidden"
                        onChange={handleImageFileChange}
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="px-3 py-1.5 bg-amber-100 hover:bg-amber-200 text-amber-950 border border-amber-300 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all shadow-2xs active:scale-95 cursor-pointer"
                        title="スマホやパソコンの写真ファイルを直接選択して設定できます"
                      >
                        <Upload className="w-3.5 h-3.5 text-amber-700" />
                        <span>写真・画像ファイルを選択</span>
                      </button>
                    </div>
                  </div>

                  {/* URL Text input with Google Drive Auto-converter */}
                  <div className="space-y-1">
                    <input
                      type="text"
                      value={formImageUrl}
                      onChange={(e) => {
                        const converted = normalizeImageUrl(e.target.value);
                        setFormImageUrl(converted);
                        setImageLoadError(false);
                      }}
                      placeholder="画像URL（https://... または Googleドライブ共有URL）"
                      className="w-full px-3 py-2 border border-sleek-border rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-sleek-gold font-mono bg-white"
                    />
                    <p className="text-[10px] text-stone-500 leading-tight">
                      💡 端末の写真ファイルを上の「画像ファイルを選択」から選ぶか、画像URL（Googleドライブの共有URLも自動変換対応）を入力してください。
                    </p>
                  </div>

                  {/* Preset Cake Photos for 1-Click Pick */}
                  <div className="pt-1.5 border-t border-stone-200/80 space-y-1.5">
                    <span className="text-[10px] font-bold text-stone-500 block">
                      ▼ 定番ケーキ写真からワンクリックで選ぶ：
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {CAKE_IMAGE_PRESETS.map((preset) => (
                        <button
                          key={preset.name}
                          type="button"
                          onClick={() => {
                            setFormImageUrl(preset.url);
                            setImageLoadError(false);
                          }}
                          className={`px-2 py-1 rounded-lg text-[10px] font-medium border flex items-center gap-1 transition-all cursor-pointer ${
                            formImageUrl === preset.url
                              ? 'bg-amber-600 text-white border-amber-600 font-bold shadow-2xs'
                              : 'bg-white text-stone-700 border-stone-200 hover:border-amber-400 hover:bg-amber-50/50'
                          }`}
                        >
                          <Sparkles className="w-2.5 h-2.5 text-amber-500" />
                          <span>{preset.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Live Image Preview & Verification Status */}
                  {formImageUrl ? (
                    <div className="pt-2 border-t border-stone-200/80 flex items-start gap-3">
                      <div className="relative w-20 h-20 rounded-xl overflow-hidden border border-stone-300 bg-white shrink-0 shadow-xs">
                        <img
                          src={formImageUrl}
                          alt="プレビュー"
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                          onLoad={() => setImageLoadError(false)}
                          onError={() => setImageLoadError(true)}
                        />
                        {imageLoadError && (
                          <div className="absolute inset-0 bg-red-950/80 text-white flex flex-col items-center justify-center p-1 text-center">
                            <AlertCircle className="w-4 h-4 text-red-400 mb-0.5" />
                            <span className="text-[9px] font-bold leading-tight">表示不可</span>
                          </div>
                        )}
                      </div>

                      <div className="min-w-0 flex-1 space-y-1">
                        {imageLoadError ? (
                          <div className="p-2 bg-red-50 border border-red-200 rounded-xl text-red-700 text-[11px] leading-relaxed">
                            <strong className="block font-bold">⚠️ 画像を読み込めませんでした</strong>
                            パソコン内のローカルパス（C:\...等）や無効なURLはWeb上で表示できません。上の「写真・画像ファイルを選択」から画像ファイルを直接選ぶか、有効なURLをご指定ください。
                          </div>
                        ) : (
                          <div className="text-[11px] text-emerald-800 space-y-0.5">
                            <div className="flex items-center gap-1 font-bold">
                              <Check className="w-3.5 h-3.5 text-emerald-600 font-bold" />
                              <span>画像プレビュー表示OK</span>
                            </div>
                            <p className="text-[10px] text-stone-500 truncate font-mono">
                              {formImageUrl.startsWith('data:') ? 'アップロードされた写真データ (Data URL)' : formImageUrl}
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* Tags */}
                <div className="space-y-1">
                  <label className="font-bold text-stone-700 block flex items-center gap-1">
                    <Tag className="w-3.5 h-3.5 text-sleek-gold" />
                    タグ（カンマ区切りで入力）
                  </label>
                  <input
                    type="text"
                    value={formTags}
                    onChange={(e) => setFormTags(e.target.value)}
                    placeholder="定番, 苺, お祝い"
                    className="w-full px-3 py-2 border border-sleek-border rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-sleek-gold"
                  />
                </div>

                {/* Submit Actions */}
                <div className="pt-3 border-t border-sleek-border flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingCake(null)}
                    className="px-4 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-xl font-medium transition-colors"
                  >
                    キャンセル
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="px-5 py-2 bg-sleek-dark hover:bg-black text-white font-bold rounded-xl shadow-md transition-all flex items-center gap-1.5 active:scale-95"
                  >
                    <Check className="w-4 h-4 text-sleek-gold" />
                    <span>{isCreatingNew ? '登録する' : '変更を保存'}</span>
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
