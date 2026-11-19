import { Cake } from '../types';

export const CAKES: Cake[] = [
  {
    id: 'strawberry-decor',
    name: 'Gâteau aux fraises',
    jpName: 'クリスマスショート',
    description: 'ふんわり焼き上げたスポンジに、ほど良い甘味の生クリームと甘酸っぱいいちごをたっぷりサンドしました。学生たちが１台１台丁寧に仕上げました。',
    price: 3000,
    imageUrl: 'https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=600&auto=format&fit=crop&q=80',
    category: 'hall',
    tags: ['定番', '苺', 'お祝い'],
    isSoldOut: false,
    portionLabel: '４号（直径１５㎝）'
  },
  {
    id: 'buche-de-noel',
    name: 'Bûche de Noël',
    jpName: 'ブッシュドノエル',
    description: 'しっとりチョコレートの生地でチョコレートの生クリームで巻き上げました。フランボワーズピューレを混ぜたガナッシュクリームで切株をイメージして周りをコーティングしました。',
    price: 3000,
    imageUrl: 'https://images.unsplash.com/photo-1607958996333-41aef7caefaa?w=600&auto=format&fit=crop&q=80',
    category: 'hall',
    tags: ['チョコレート', 'クリスマス', '限定'],
    isSoldOut: false,
    portionLabel: '長さ１８㎝'
  },
  {
    id: 'strawberry-slice',
    name: 'Gâteau aux fraises',
    jpName: 'ショートケーキ',
    description: 'ふんわり焼き上げたスポンジに、ほど良い甘味の生クリームと甘酸っぱいいちごをたっぷりサンドしました。学生たちが１台１台丁寧に仕上げました。',
    price: 300,
    imageUrl: 'https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=600&auto=format&fit=crop&q=80',
    category: 'cut',
    tags: ['定番', '苺', '人気'],
    isSoldOut: false,
    portionLabel: '１カット'
  },
  {
    id: 'cheesecake',
    name: 'Gâteau au fromage',
    jpName: 'ベイクドチーズケーキ',
    description: 'クリームチーズをたっぷり使用し、じっくり焼き上げました。しっとりなめらかな食感でほどよい酸味が絶妙なバランスです。',
    price: 300,
    imageUrl: 'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?w=600&auto=format&fit=crop&q=80',
    category: 'cut',
    tags: ['定番', 'チーズ', 'なめらか'],
    isSoldOut: false,
    portionLabel: '１カット'
  },
  {
    id: 'mont-blanc',
    name: 'Mont-Blanc',
    jpName: 'モンブラン',
    description: 'なめらかなマロンクリームをたっぷりと絞り、栗本来の風味を存分に味わえるモンブランに仕上げました。サクサクのメレンゲの食感もお楽しみください。',
    price: 300,
    imageUrl: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=600&auto=format&fit=crop&q=80',
    category: 'cut',
    tags: ['定番', '栗', 'なめらか'],
    isSoldOut: false,
    portionLabel: '１カット'
  },
  {
    id: 'gateau-au-chocolat',
    name: 'Gâteau au chocolat',
    jpName: 'ガトーショコラ',
    description: 'しっとりとした食感と濃厚なチョコレートの風味が魅力のガトーショコラ。チョコレート好きの方にぜひ味わっていただきたい一品です。',
    price: 300,
    imageUrl: 'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=600&auto=format&fit=crop&q=80',
    category: 'cut',
    tags: ['定番', 'チョコレート', '濃厚'],
    isSoldOut: false,
    portionLabel: '１カット'
  },
  {
    id: 'rice-chou',
    name: 'Chou à la crème de riz',
    jpName: '米粉のシュークリーム',
    description: '生地とクリームに米粉を使用しました。なめらかなクリームをたっぷり詰め込み、外は香ばしく、中はふんわり。米粉ならではのやさしい甘さが楽しめます。',
    price: 200,
    imageUrl: 'https://images.unsplash.com/photo-1612203985729-70726954388c?w=600&auto=format&fit=crop&q=80',
    category: 'cut',
    tags: ['米粉', 'シュークリーム', '定番'],
    isSoldOut: false,
    portionLabel: '１つ'
  }
];

export const TIME_SLOTS = [
  '11:30 - 12:00',
  '12:00 - 12:30',
  '12:30 - 13:00',
  '13:00 - 13:30',
  '13:30 - 14:00',
  '14:00 - 14:30',
  '14:30 - 15:00'
];

export const CATEGORY_LABELS = {
  hall: 'ホールケーキ',
  cut: 'カットケーキ',
  seasonal: '季節限定',
  tart: 'タルト'
};
