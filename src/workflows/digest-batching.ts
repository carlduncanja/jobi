import { stableBucket } from '../lib/utils';

export interface BroadcastWindow {
  dateKey: string;
  windowStart: string;
  windowEnd: string;
}

export function getBroadcastWindow(date: Date, startUtcHour: number, durationMinutes: number): BroadcastWindow {
  const start = new Date(date);
  start.setUTCHours(startUtcHour, 0, 0, 0);

  const end = new Date(start);
  end.setUTCMinutes(end.getUTCMinutes() + durationMinutes);

  return {
    dateKey: start.toISOString().slice(0, 10),
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
  };
}

export function computeDeliverySlotMinute(userId: string, durationMinutes: number): number {
  return stableBucket(userId, durationMinutes);
}

export function computeScheduledDelivery(date: Date, slotMinute: number, startUtcHour: number): string {
  const scheduledAt = new Date(date);
  scheduledAt.setUTCHours(startUtcHour, 0, 0, 0);
  scheduledAt.setUTCMinutes(scheduledAt.getUTCMinutes() + slotMinute);
  return scheduledAt.toISOString();
}

export function isInsideBroadcastWindow(
  date: Date,
  startUtcHour: number,
  durationMinutes: number,
): boolean {
  const start = new Date(date);
  start.setUTCHours(startUtcHour, 0, 0, 0);

  const end = new Date(start);
  end.setUTCMinutes(end.getUTCMinutes() + durationMinutes);

  return date >= start && date <= end;
}
