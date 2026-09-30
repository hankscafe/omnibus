import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// In-memory SystemSetting table shared by the client, the usage counter and the flags.
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: {
            findUnique: vi.fn(async ({ where }: any) => (store.has(where.key) ? { key: where.key, value: store.get(where.key) } : null)),
            findMany: vi.fn(async ({ where }: any) => [...store.entries()]
                .filter(([key]) => !where?.key?.in || where.key.in.includes(key))
                .map(([key, value]) => ({ key, value }))),
            upsert: vi.fn(async ({ where, update, create }: any) => {
                store.set(where.key, store.has(where.key) ? update.value : create.value);
                return { key: where.key, value: store.get(where.key) };
            }),
        },
    },
}));
vi.mock('@/lib/metadata/metadata-cache', () => ({
    getCachedResponse: vi.fn(async () => null),
    putCachedResponse: vi.fn(async () => {}),
}));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));

import {
    authFromSettings, authHeader, getMetronAuth, METRON_USER_AGENT, parseRateHeaders, MetronLimiter,
    optionalBudgetSpent, backoffMs, endpointKey, metronGet, readRateStatus, __resetMetronLimiterForTests, MetronBusyError,
    describeMetronHealth, lazyMetronAuth,
} from '@/lib/metron/client';
import packageJson from '../../package.json';

const T0 = 1_790_700_000_000;
const none = () => ({ burst: {}, sustained: {} });

function reply(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
    // A generous burst limit keeps background spacing short (60 s / 600 = 100 ms).
    return new Response(status === 204 || status === 304 ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'x-ratelimit-burst-limit': '600', ...headers },
    });
}

describe('Metron client (Metron API best practices, #216)', () => {
    describe('auth', () => {
        it('prefers an API token over username and password', () => {
            expect(authFromSettings(' tok123 ', 'adam', 'pw')).toEqual({ kind: 'token', token: 'tok123' });
            expect(authFromSettings('', 'adam', 'pw')).toEqual({ kind: 'basic', user: 'adam', pass: 'pw' });
        });

        it('never treats a blank value or the ******** mask as a credential', () => {
            expect(authFromSettings('********', 'adam', 'pw')).toEqual({ kind: 'basic', user: 'adam', pass: 'pw' });
            expect(authFromSettings('', 'adam', '********')).toBeNull();
            expect(authFromSettings(undefined, '', 'pw')).toBeNull();
            expect(authFromSettings(null, null, null)).toBeNull();
        });

        it('sends a token as Bearer and a password as Basic', () => {
            expect(authHeader({ kind: 'token', token: 'tok123' })).toBe('Bearer tok123');
            expect(authHeader({ kind: 'basic', user: 'adam', pass: 'pw' })).toBe('Basic YWRhbTpwdw==');
        });

        it('reads the credentials at most once, and only when a lazy getter is called', async () => {
            store.clear();
            store.set('metron_api_token', 'tok123');
            const { prisma } = await import('@/lib/db');
            const findMany = vi.mocked(prisma.systemSetting.findMany);
            findMany.mockClear();
            const auth = lazyMetronAuth();
            expect(findMany).not.toHaveBeenCalled();
            expect(await auth()).toEqual({ kind: 'token', token: 'tok123' });
            expect(await auth()).toEqual({ kind: 'token', token: 'tok123' });
            expect(findMany).toHaveBeenCalledTimes(1);
        });

        it('reads the settings (token first)', async () => {
            store.clear();
            store.set('metron_user', 'adam').set('metron_pass', 'pw');
            expect(await getMetronAuth()).toEqual({ kind: 'basic', user: 'adam', pass: 'pw' });
            store.set('metron_api_token', 'tok123');
            expect(await getMetronAuth()).toEqual({ kind: 'token', token: 'tok123' });
        });
    });

    it('identifies itself with the real version and the project URL', () => {
        expect(METRON_USER_AGENT).toBe(`Omnibus/${packageJson.version} (+https://github.com/hankscafe/omnibus)`);
    });

    it('reads all six rate-limit headers', () => {
        const h = new Headers({
            'X-RateLimit-Burst-Limit': '20', 'X-RateLimit-Burst-Remaining': '17', 'X-RateLimit-Burst-Reset': '1790700060',
            'X-RateLimit-Sustained-Limit': '10000', 'X-RateLimit-Sustained-Remaining': '9876', 'X-RateLimit-Sustained-Reset': '1790780000',
        });
        expect(parseRateHeaders(h)).toEqual({
            burst: { limit: 20, remaining: 17, reset: 1790700060 },
            sustained: { limit: 10000, remaining: 9876, reset: 1790780000 },
        });
        expect(parseRateHeaders(new Headers())).toEqual({ burst: {}, sustained: {} });
    });

    it('folds usage keys exactly like the engine (numeric ids → {id}, no /api, no query)', () => {
        expect(endpointKey('https://metron.cloud/api/series/123/issue_list/?page=2')).toBe('/series/{id}/issue_list');
        expect(endpointKey('https://metron.cloud/api/issue/?store_date_range_after=2026-09-01')).toBe('/issue');
    });

    describe('limiter', () => {
        it('spaces background work evenly across the burst window; interactive requests only have to fit in it', () => {
            const l = new MetronLimiter();
            expect(l.waitMs(T0, 'background', none())).toBe(0);
            l.recordSend(T0);
            expect(l.waitMs(T0, 'background', none())).toBe(3_000); // 60 s / 20 (Metron's floor)
            expect(l.waitMs(T0 + 1_000, 'background', none())).toBe(2_000);
            expect(l.waitMs(T0, 'interactive', none())).toBe(0);
        });

        it('follows the burst limit Metron reports', () => {
            const l = new MetronLimiter();
            l.observe({ limit: 30, remaining: 29 }, {});
            l.recordSend(T0);
            expect(l.waitMs(T0, 'background', none())).toBe(2_000);
        });

        it('waits for the oldest send to age out of a full window', () => {
            const l = new MetronLimiter();
            for (let i = 0; i < 20; i++) l.recordSend(T0 + i * 100);
            expect(l.waitMs(T0 + 5_000, 'interactive', none())).toBe(55_000);
            expect(l.waitMs(T0 + 60_000, 'interactive', none())).toBe(0);
        });

        it('blocks every caller for a 429\'s Retry-After (a full window when there is none)', () => {
            const l = new MetronLimiter();
            expect(l.onRateLimited(30, T0)).toBe(T0 + 30_000);
            expect(l.waitMs(T0 + 10_000, 'interactive', none())).toBe(20_000);
            expect(new MetronLimiter().onRateLimited(0, T0)).toBe(T0 + 60_000);
        });

        it('refuses instead of waiting hours when the daily window is used up', () => {
            const l = new MetronLimiter();
            l.observe({}, { limit: 5_000, remaining: 0, reset: T0 / 1000 + 3_600 });
            expect(l.waitMs(T0, 'background', none())).toEqual({ dailyLimitRetryAfterS: 3_600 });
            expect(l.waitMs(T0 + 3_600_000, 'background', none())).toBe(0);
        });

        it('honours what the engine recorded', () => {
            const l = new MetronLimiter();
            expect(l.waitMs(T0, 'interactive', { ...none(), blockedUntil: T0 + 45_000 })).toBe(45_000);
            expect(l.waitMs(T0, 'interactive', { burst: { limit: 20, remaining: 0, reset: T0 / 1000 + 12 }, sustained: {} })).toBe(12_000);
            expect(l.waitMs(T0, 'interactive', { burst: {}, sustained: { limit: 5_000, remaining: 0, reset: T0 / 1000 + 600 } }))
                .toEqual({ dailyLimitRetryAfterS: 600 });
            expect(l.waitMs(T0, 'interactive', { burst: { limit: 20, remaining: 0, reset: T0 / 1000 - 5 }, sustained: {} })).toBe(0);
        });
    });

    it('leaves a tenth of the real daily limit for normal syncing', () => {
        const future = T0 / 1000 + 3_600;
        expect(optionalBudgetSpent({ limit: 5_000, remaining: 400, reset: future }, T0, 0)).toBe(true);
        expect(optionalBudgetSpent({ limit: 5_000, remaining: 600, reset: future }, T0, 0)).toBe(false);
        expect(optionalBudgetSpent({ limit: 25_000, remaining: 2_000, reset: future }, T0, 0)).toBe(true);
        expect(optionalBudgetSpent({ limit: 25_000, remaining: 9_000, reset: future }, T0, 4_900)).toBe(false);
        expect(optionalBudgetSpent({}, T0, 4_600)).toBe(true);
        expect(optionalBudgetSpent({}, T0, 4_000)).toBe(false);
    });

    describe('health line', () => {
        const future = T0 / 1000 + 3 * 3600 + 12 * 60; // resets in 3h 12m
        it('reports the real daily window when Metron has told us', () => {
            const h = describeMetronHealth({ burst: {}, sustained: { limit: 10_000, remaining: 8_200, reset: future } }, 120, 0, T0);
            expect(h.status).toBe('ok');
            expect(h.message).toContain('8,200 of 10,000 requests left today');
            expect(h.message).toContain('resets in 3h 12m');
        });
        it('warns under 20% left', () => {
            expect(describeMetronHealth({ burst: {}, sustained: { limit: 5_000, remaining: 900, reset: future } }, 0, 0, T0).status).toBe('warning');
        });
        it('is an error while Metron has us paused, or the day is used up', () => {
            const paused = describeMetronHealth({ burst: {}, sustained: {}, blockedUntil: T0 + 10 * 60_000 }, 0, 0, T0);
            expect(paused.status).toBe('error');
            expect(paused.message).toContain('10m');
            expect(describeMetronHealth({ burst: {}, sustained: { limit: 5_000, remaining: 0, reset: future } }, 0, 0, T0).status).toBe('error');
            expect(describeMetronHealth({ burst: {}, sustained: {} }, 0, T0 - 5 * 60_000, T0).status).toBe('error');
        });
        it('falls back to our own count when Metron has not reported a window', () => {
            const h = describeMetronHealth({ burst: {}, sustained: {} }, 4_100, 0, T0);
            expect(h.status).toBe('warning');
            expect(h.message).toContain('4100');
        });
    });

    it('backs off 1, 2, 4 … seconds, capped at a minute', () => {
        expect([0, 1, 2, 3, 4, 5, 6, 7].map(backoffMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    });

    describe('metronGet', () => {
        const fetchMock = vi.fn();
        const URL = 'https://metron.cloud/api/issue/?series_id=1';
        const token = { kind: 'token' as const, token: 'tok123' };

        beforeEach(() => {
            store.clear();
            __resetMetronLimiterForTests();
            fetchMock.mockReset();
            vi.stubGlobal('fetch', fetchMock);
        });
        afterEach(() => vi.unstubAllGlobals());

        it('sends the token as Bearer with our User-Agent and counts the request', async () => {
            fetchMock.mockResolvedValueOnce(reply(200, { results: [] }));
            const res = await metronGet(URL, { auth: token, cache: false });
            expect(res.status).toBe(200);
            expect(res.data).toEqual({ results: [] });
            const headers = fetchMock.mock.calls[0][1].headers;
            expect(headers.Authorization).toBe('Bearer tok123');
            expect(headers['User-Agent']).toBe(METRON_USER_AGENT);
            expect(JSON.parse(store.get('metron_api_usage')!)['/issue']).toHaveLength(1);
        });

        it('waits out a short 429 and retries', async () => {
            fetchMock.mockResolvedValueOnce(reply(429, {}, { 'retry-after': '1' })).mockResolvedValueOnce(reply(200, { ok: true }));
            const started = Date.now();
            const res = await metronGet(URL, { auth: token, cache: false, pace: 'interactive' });
            expect(res.data).toEqual({ ok: true });
            expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('stops on a long 429, never retries it, and blocks the engine too', async () => {
            fetchMock.mockResolvedValue(reply(429, {}, { 'retry-after': '600' }));
            await expect(metronGet(URL, { auth: token, cache: false })).rejects.toThrow(/FATAL_RATE_LIMIT/);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const status = await readRateStatus();
            expect(status.blockedUntil).toBeGreaterThan(Date.now() + 590_000);
            expect(store.has('metron_rate_limit_time')).toBe(true);
            // The next call is refused without reaching Metron.
            await expect(metronGet(URL, { auth: token, cache: false })).rejects.toThrow(/FATAL_RATE_LIMIT/);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('reads the shared state the engine writes (nulls for unknown values)', async () => {
            store.set('metron_rate_status', JSON.stringify({
                burst: { limit: 20, remaining: null, reset: null },
                sustained: { limit: null, remaining: null, reset: null },
                blockedUntil: null,
                updatedAt: 1790700000000,
            }));
            fetchMock.mockImplementation(async () => reply(200, { ok: true }));
            const res = await metronGet(URL, { auth: token, cache: false });
            expect(res.status).toBe(200);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('honours a block the engine recorded without sending anything', async () => {
            store.set('metron_rate_status', JSON.stringify({ burst: {}, sustained: {}, blockedUntil: Date.now() + 300_000 }));
            await expect(metronGet(URL, { auth: token, cache: false })).rejects.toThrow(/FATAL_RATE_LIMIT/);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('never retries another client error', async () => {
            fetchMock.mockResolvedValue(reply(401, { detail: 'Invalid token.' }));
            await expect(metronGet(URL, { auth: token, cache: false })).rejects.toMatchObject({ status: 401 });
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('retries a server error after a backoff', async () => {
            fetchMock.mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(reply(200, { ok: true }));
            const started = Date.now();
            const res = await metronGet(URL, { auth: token, cache: false, pace: 'interactive' });
            expect(res.status).toBe(200);
            expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('shares the windows Metron reports, and a used-up day stops further calls', async () => {
            const reset = Math.floor(Date.now() / 1000) + 3_600;
            fetchMock.mockResolvedValue(reply(200, { ok: true }, {
                'x-ratelimit-sustained-limit': '10000', 'x-ratelimit-sustained-remaining': '0', 'x-ratelimit-sustained-reset': String(reset),
            }));
            await metronGet(URL, { auth: token, cache: false });
            const status = await readRateStatus();
            expect(status.sustained).toEqual({ limit: 10000, remaining: 0, reset });
            expect(status.burst.limit).toBe(600);
            await expect(metronGet(URL, { auth: token, cache: false })).rejects.toThrow(/FATAL_RATE_LIMIT/);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('skips an optional request instead of waiting when no slot is free right now', async () => {
            fetchMock.mockImplementation(async () => reply(200, { ok: true }));
            await metronGet(URL, { auth: token, cache: false }); // background: the next send is 100 ms out
            await expect(metronGet(URL, { auth: token, cache: false, optional: true })).rejects.toBeInstanceOf(MetronBusyError);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            // With a free slot it goes out like any other request.
            await new Promise(r => setTimeout(r, 150));
            await metronGet(URL, { auth: token, cache: false, optional: true });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('uses the configured credentials when none are passed, and refuses to send without any', async () => {
            fetchMock.mockResolvedValue(reply(200, { ok: true }));
            await expect(metronGet(URL, { cache: false })).rejects.toThrow(/credentials/i);
            expect(fetchMock).not.toHaveBeenCalled();
            store.set('metron_user', 'adam').set('metron_pass', 'pw');
            await metronGet(URL, { cache: false });
            expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Basic YWRhbTpwdw==');
        });
    });
});
