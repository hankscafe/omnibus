// __tests__/lib/metron-health.test.ts
//
// The System Health modal's Metron limits (Metron beta 3). Metron reports the account's limits on every
// response: a per-minute burst limit that varies with server load, and a daily (sustained) limit that
// depends on the account's supporter tier - 5,000 standard, raised to 7,500 / 10,000 / 15,000 / 25,000
// for supporters. The modal showed a line of text frozen at the last health run (up to 15 minutes old)
// with no tier and no countdown; it now shows these from the shared state, with live timers.
import { describe, it, expect } from 'vitest';
import { metronTier, metronCalls24h, formatCountdown, metronLimitsView, describeMetronHealth } from '@/lib/metron/health';

const T0 = Date.UTC(2026, 8, 29, 21, 0, 0);
const inS = (s: number) => Math.floor(T0 / 1000) + s; // a Unix-seconds reset `s` seconds from T0

describe('lib: Metron limits for the Health modal', () => {
    it('names the tier from the daily limit Metron reports', () => {
        expect(metronTier(5_000)).toEqual({ supporter: false, label: 'Standard' });
        for (const limit of [7_500, 10_000, 15_000, 25_000]) {
            expect(metronTier(limit)).toEqual({ supporter: true, label: 'Supporter' });
        }
    });

    it('counts our own Metron calls in the last 24 hours (the fallback before Metron reports a window)', () => {
        const usage = JSON.stringify({ '/issue': [T0 - 1_000, T0 - 25 * 3600_000], '/series': [T0 - 60_000] });
        expect(metronCalls24h(usage, T0)).toBe(2);
        expect(metronCalls24h('not json', T0)).toBe(0);
        expect(metronCalls24h(undefined, T0)).toBe(0);
    });

    it('formats a countdown as h:mm:ss (m:ss under an hour), never negative', () => {
        expect(formatCountdown((3 * 3600 + 12 * 60 + 5) * 1000)).toBe('3:12:05');
        expect(formatCountdown(65_000)).toBe('1:05');
        expect(formatCountdown(400)).toBe('0:01');
        expect(formatCountdown(-5_000)).toBe('0:00');
    });

    it('shows a supporter account\'s real daily window, the burst limit and when the day resets', () => {
        const v = metronLimitsView({
            status: { burst: { limit: 60, remaining: 58, reset: inS(40) }, sustained: { limit: 10_000, remaining: 8_200, reset: inS(3 * 3600 + 12 * 60) }, updatedAt: T0 - 30_000 },
            localCalls24h: 120, rateLimitFlagMs: 0,
        }, T0);

        expect(v.daily).toEqual({ limit: 10_000, remaining: 8_200, used: 1_800, resetAtMs: (inS(3 * 3600 + 12 * 60)) * 1000, tier: { supporter: true, label: 'Supporter' }, current: true });
        expect(v.burst).toEqual({ limit: 60, remaining: 58, resetAtMs: inS(40) * 1000 });
        expect(v.alerts).toEqual([]);
        expect(v.reportedAtMs).toBe(T0 - 30_000);
        expect(v.health.status).toBe('ok');
    });

    it('alerts while Metron has Omnibus paused, with the time it ends', () => {
        const v = metronLimitsView({ status: { burst: {}, sustained: {}, blockedUntil: T0 + 90_000 }, localCalls24h: 0, rateLimitFlagMs: 0 }, T0);
        expect(v.alerts[0]).toMatchObject({ level: 'error', untilMs: T0 + 90_000 });
        expect(v.alerts[0].text).toMatch(/paused/i);
        expect(v.health.status).toBe('error');
    });

    it('alerts when the daily limit is used up, counting down to the reset', () => {
        const v = metronLimitsView({ status: { burst: {}, sustained: { limit: 5_000, remaining: 0, reset: inS(2 * 3600) } }, localCalls24h: 0, rateLimitFlagMs: 0 }, T0);
        expect(v.alerts[0]).toMatchObject({ level: 'error', untilMs: inS(2 * 3600) * 1000 });
        expect(v.alerts[0].text).toMatch(/daily limit reached/i);
    });

    it('warns under 20% of the day left', () => {
        const v = metronLimitsView({ status: { burst: {}, sustained: { limit: 5_000, remaining: 900, reset: inS(600) } }, localCalls24h: 0, rateLimitFlagMs: 0 }, T0);
        expect(v.alerts).toEqual([expect.objectContaining({ level: 'warning', untilMs: inS(600) * 1000 })]);
    });

    it('flags a long 429 from the last hour until the hour is up', () => {
        const flag = T0 - 10 * 60_000;
        const v = metronLimitsView({ status: { burst: {}, sustained: { limit: 5_000, remaining: 4_000, reset: inS(600) } }, localCalls24h: 0, rateLimitFlagMs: flag }, T0);
        expect(v.alerts[0]).toMatchObject({ level: 'error', untilMs: flag + 3600_000 });
    });

    it('says when the per-minute limit is used up', () => {
        const v = metronLimitsView({ status: { burst: { limit: 60, remaining: 0, reset: inS(20) }, sustained: { limit: 5_000, remaining: 4_000, reset: inS(600) } }, localCalls24h: 0, rateLimitFlagMs: 0 }, T0);
        expect(v.alerts).toEqual([expect.objectContaining({ level: 'info', untilMs: inS(20) * 1000 })]);
    });

    it('a day that reset since the last Metron response is a full window again, not a stale count', () => {
        const v = metronLimitsView({ status: { burst: { limit: 60, remaining: 3, reset: inS(-3600) }, sustained: { limit: 7_500, remaining: 12, reset: inS(-60) } }, localCalls24h: 0, rateLimitFlagMs: 0 }, T0);
        expect(v.daily).toMatchObject({ limit: 7_500, remaining: 7_500, used: 0, resetAtMs: null, current: false, tier: { supporter: true } });
        expect(v.burst).toEqual({ limit: 60, remaining: null, resetAtMs: null });
        expect(v.alerts).toEqual([]);
    });

    it('before any Metron response: no limits yet, our own count, and a note saying so', () => {
        const v = metronLimitsView({ status: { burst: {}, sustained: {} }, localCalls24h: 42, rateLimitFlagMs: 0 }, T0);
        expect(v.daily).toBeNull();
        expect(v.burst).toBeNull();
        expect(v.localCalls24h).toBe(42);
        expect(v.alerts).toEqual([expect.objectContaining({ level: 'info' })]);
        expect(v.health.message).toContain('42');
    });

    it('the health line names the tier and the burst limit', () => {
        const h = describeMetronHealth({ burst: { limit: 60 }, sustained: { limit: 10_000, remaining: 8_200, reset: inS(3 * 3600 + 12 * 60) } }, 0, 0, T0);
        expect(h.message).toContain('8,200 of 10,000 requests left today');
        expect(h.message).toContain('Supporter');
        expect(h.message).toContain('60 per minute');
        expect(h.message).toContain('resets in 3h 12m');
    });
});
