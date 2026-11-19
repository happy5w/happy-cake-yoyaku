/**
 * Cake Reservation System type definitions.
 */

export interface Cake {
  id: string;
  name: string;
  jpName: string;
  description: string;
  price: number;
  imageUrl: string;
  category: 'hall' | 'cut' | 'seasonal' | 'tart';
  tags: string[];
  isSoldOut?: boolean;
  stock?: number;
  stockByDate?: Record<string, number>;
  portionLabel?: string;
  stopSellingAt?: string;
  autoStoppedAt?: string;
}

export interface SalesStopScheduleRule {
  id: string;
  label: string;
  scheduledAt: string; // YYYY-MM-DDTHH:mm
  targetScope: 'all' | 'hall' | 'cut' | 'custom';
  targetCakeIds?: string[];
  enabled: boolean;
  executed?: boolean;
  executedAt?: string;
  createdAt: string;
}

export interface ReservationItem {
  cakeId: string;
  cakeName: string;
  quantity: number;
  price: number;
}

export type ReservationStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed';

export interface Reservation {
  id: string;
  name: string;
  nameKana?: string;
  email: string;
  phone: string;
  date: string;
  time: string;
  items: ReservationItem[];
  totalPrice: number;
  notes?: string;
  status: ReservationStatus;
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string;
}

export interface CancellationNotification {
  id: string;
  reservationId: string;
  customerName: string;
  customerKana?: string;
  phone: string;
  date: string;
  time: string;
  itemsSummary: string;
  totalPrice: number;
  cancelledAt: string;
  read: boolean;
}

export interface AdminSettings {
  storeName: string;
  openTime: string;
  closeTime: string;
  maxReservationsPerSlot: number;
}
