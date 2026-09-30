import { describe, it, expect } from 'vitest';
import { scheduleOffsetMs, newScheduleSeed } from '@/lib/schedule-jitter';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// #216: every install used to fire its daily jobs at 00:00 UTC together. Each install now gets a
// stable offset inside each job's interval, derived from its own random seed.
describe('schedule jitter (#216)', () => {
    it('puts every offset strictly inside its interval, never 0 (BullMQ reads 0 as "run now")', () => {
        for (const every of [15 * MINUTE, HOUR, 6 * HOUR, 12 * HOUR, DAY, 7 * DAY]) {
            for (let i = 0; i < 500; i++) {
                const offset = scheduleOffsetMs(`install-${i}`, 'METADATA_SYNC', every);
                expect(Number.isInteger(offset)).toBe(true);
                expect(offset).toBeGreaterThan(0);
                expect(offset).toBeLessThan(every);
            }
        }
    });

    it('is stable for the same install and job, so a restart keeps the same slot', () => {
        const seed = newScheduleSeed();
        expect(scheduleOffsetMs(seed, 'SERIES_MONITOR', DAY)).toBe(scheduleOffsetMs(seed, 'SERIES_MONITOR', DAY));
    });

    it("spreads one install's jobs apart instead of starting them on the same second", () => {
        const jobs = ['LIBRARY_SCAN', 'METADATA_SYNC', 'SERIES_MONITOR', 'DISCOVER_SYNC', 'FOR_YOU_SYNC', 'UPDATE_CHECK'];
        const offsets = jobs.map(job => scheduleOffsetMs('one-install', job, DAY));
        expect(new Set(offsets).size).toBe(jobs.length);
    });

    it('spreads installs across the whole day instead of piling onto 00:00 UTC', () => {
        const installs = 2400;
        const perHour = new Array(24).fill(0);
        let withinTenMinutesOfMidnight = 0;
        for (let i = 0; i < installs; i++) {
            const offset = scheduleOffsetMs(`install-${i}`, 'SERIES_MONITOR', DAY);
            perHour[Math.floor(offset / HOUR)]++;
            if (offset < 10 * MINUTE) withinTenMinutesOfMidnight++;
        }
        // A uniform spread is 100 per hour; the bounds are far outside normal variation.
        for (const count of perHour) {
            expect(count).toBeGreaterThan(50);
            expect(count).toBeLessThan(150);
        }
        // Before the fix this was every install (100%); uniform is ~0.7%.
        expect(withinTenMinutesOfMidnight / installs).toBeLessThan(0.02);
    });

    it('makes a fresh random seed for each install', () => {
        const a = newScheduleSeed();
        const b = newScheduleSeed();
        expect(a).toMatch(/^[0-9a-f]{32}$/);
        expect(a).not.toBe(b);
    });
});
