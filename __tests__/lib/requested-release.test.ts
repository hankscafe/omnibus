// Calendar fix A (beta.040): which issues count as "just released" for the Series Monitor's fast re-search
// of not-found requests. A release date is a day, not an instant, so the window's first day counts whole.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ prisma: {} }));

import { releasedWithinDays, FRESH_RELEASE_DAYS, FRESH_RETRY_HOURS } from '@/lib/requested-release';

const NOW = new Date('2026-11-15T12:00:00Z');

describe('releasedWithinDays', () => {
    it('takes an issue released today or in the last N days', () => {
        expect(releasedWithinDays('2026-11-15', 14, NOW)).toBe(true);
        expect(releasedWithinDays('2026-11-12', 14, NOW)).toBe(true);
        // 14 days back is 2026-11-01 12:00; that whole day is in.
        expect(releasedWithinDays('2026-11-01', 14, NOW)).toBe(true);
    });

    it('leaves out an issue released before the window', () => {
        expect(releasedWithinDays('2026-10-31', 14, NOW)).toBe(false);
        expect(releasedWithinDays('2025-11-12', 14, NOW)).toBe(false);
    });

    it('leaves out an issue that is not out yet', () => {
        expect(releasedWithinDays('2026-11-16', 14, NOW)).toBe(false);
    });

    it('leaves out a missing or unreadable date', () => {
        expect(releasedWithinDays(null, 14, NOW)).toBe(false);
        expect(releasedWithinDays(undefined, 14, NOW)).toBe(false);
        expect(releasedWithinDays('', 14, NOW)).toBe(false);
        expect(releasedWithinDays('soon', 14, NOW)).toBe(false);
    });

    it('reads a month-only date as the first of that month', () => {
        expect(releasedWithinDays('2026-11', 14, NOW)).toBe(true);
        expect(releasedWithinDays('2026-10', 14, NOW)).toBe(false);
    });

    it('uses the current time when none is given', () => {
        const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
        expect(releasedWithinDays(yesterday, FRESH_RELEASE_DAYS)).toBe(true);
    });

    it('looks two weeks back, at most twice a day', () => {
        // The engine's monitor window looks the same 14 days back (monitor.rs WINDOW_PAST_DAYS).
        expect(FRESH_RELEASE_DAYS).toBe(14);
        expect(FRESH_RETRY_HOURS).toBe(12);
    });
});
