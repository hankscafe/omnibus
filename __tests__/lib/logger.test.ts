import { describe, it, expect, vi } from 'vitest';
// This file tests the REAL logger module — undo setup-global's suite-wide Logger mock (which
// doesn't even export isoWeekKey) before the import resolves.
vi.unmock('@/lib/logger');
import { isoWeekKey } from '@/lib/logger';

// The weekly rotation trigger keys off isoWeekKey(); a wrong week number would either roll too often or
// never. These dates are hand-verified against the ISO-8601 calendar (2026 starts on a Thursday, so it
// is a 53-week year and Dec 29 2025 already belongs to 2026-W01).
describe('Logger: ISO week keys (rotation boundary)', () => {
    it('keys the first ISO week correctly, including the spill from late December', () => {
        expect(isoWeekKey(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01'); // Thursday, W01
        expect(isoWeekKey(new Date('2025-12-29T12:00:00Z'))).toBe('2026-W01'); // Monday of W01
    });

    it('keys a mid-year week and the 53rd week of a long year', () => {
        expect(isoWeekKey(new Date('2026-06-24T12:00:00Z'))).toBe('2026-W26');
        expect(isoWeekKey(new Date('2026-12-31T12:00:00Z'))).toBe('2026-W53'); // Thursday, W53
    });
});
