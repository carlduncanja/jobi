import { describe, expect, it } from 'bun:test';

import {
  computeDeliverySlotMinute,
  computeScheduledDelivery,
  getBroadcastWindow,
  isInsideBroadcastWindow,
} from '../src/workflows/digest-batching';

describe('digest batching', () => {
  it('uses a stable delivery slot for the same user', () => {
    const first = computeDeliverySlotMinute('user-123', 120);
    const second = computeDeliverySlotMinute('user-123', 120);

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(120);
  });

  it('builds the fixed EST broadcast window in UTC', () => {
    const date = new Date('2026-03-11T16:30:00.000Z');
    const window = getBroadcastWindow(date, 15, 120);

    expect(window.dateKey).toBe('2026-03-11');
    expect(window.windowStart).toBe('2026-03-11T15:00:00.000Z');
    expect(window.windowEnd).toBe('2026-03-11T17:00:00.000Z');
  });

  it('computes scheduled delivery times inside the window', () => {
    const scheduled = computeScheduledDelivery(new Date('2026-03-11T00:00:00.000Z'), 42, 15);

    expect(scheduled).toBe('2026-03-11T15:42:00.000Z');
    expect(isInsideBroadcastWindow(new Date(scheduled), 15, 120)).toBe(true);
    expect(isInsideBroadcastWindow(new Date('2026-03-11T18:00:00.000Z'), 15, 120)).toBe(false);
  });
});
