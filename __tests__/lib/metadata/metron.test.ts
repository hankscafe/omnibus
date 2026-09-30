// __tests__/lib/metadata/metron.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetronProvider } from '@/lib/metadata/providers/metron';
import { __resetMetronLimiterForTests } from '@/lib/metron/client';
import { loggerLog } from '../../helpers/setup-global';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findManySettings: vi.fn(),
    log: vi.fn()
}));

// 2. Mock Dependencies
vi.mock('@/lib/db', () => ({
    prisma: { systemSetting: { findMany: mocks.findManySettings } }
}));
vi.mock('@/lib/utils/system-flags', () => ({ logApiUsage: vi.fn() }));

describe('Metadata Pipeline: Metron.Cloud Provider', () => {
    let provider: MetronProvider;

    beforeEach(() => {
        // Provide mock credentials
        mocks.findManySettings.mockResolvedValue([
            { key: 'metron_user', value: 'test_user' },
            { key: 'metron_pass', value: 'test_pass' }
        ]);
        provider = new MetronProvider();
        
        // Mock global fetch
        global.fetch = vi.fn();
    });

    it('should correctly slice Metron 50-item pages into Omnibus 10-item UI pages', async () => {
        // Create 50 dummy items
        const dummyResults = Array.from({ length: 50 }, (_, i) => ({
            id: i, series: 'Batman', year_began: 2016, publisher: { name: 'DC' }
        }));

        vi.mocked(global.fetch).mockResolvedValueOnce({
            status: 200,
            headers: new Headers(),
            json: async () => ({ results: dummyResults })
        } as any);

        // We request page 2 in the UI (which should be items 10-19 from Metron's page 1)
        const results = await provider.searchSeries('Batman', 2);

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('page=1'), // It should hit page 1 on the API
            expect.any(Object)
        );
        
        expect(results).toHaveLength(10);
        expect(results[0].sourceId).toBe('10'); // Index 10
        expect(results[9].sourceId).toBe('19'); // Index 19
    });

    // Metron beta 4 (#216 follow-up): Metron's series search carries no image, so a cover costs one
    // issue_list request per result. Only a search someone is looking at pays for them now. And a
    // Metron page holds 100 results (checked live 2026-09-30), not the 50 the paging assumed, so
    // results 51-100 of every page could never be reached.
    describe('search covers and paging (Metron beta 4)', () => {
        const series = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: from + i, series: `Series ${from + i}`, year_began: 2020, publisher: { name: 'DC' } }));
        const respond = (body: any) => ({ status: 200, headers: new Headers(), json: async () => body }) as any;
        const coverCalls = () => vi.mocked(global.fetch).mock.calls.filter(c => String(c[0]).includes('/issue_list/'));

        beforeEach(() => __resetMetronLimiterForTests());

        it('fetches no covers unless asked - an automated search never uses them', async () => {
            vi.mocked(global.fetch).mockResolvedValue(respond({ results: series(3) }));

            const results = await provider.searchSeries('Batman', 1);

            expect(global.fetch).toHaveBeenCalledTimes(1);
            expect(coverCalls()).toHaveLength(0);
            expect(results.map(r => r.coverUrl)).toEqual([null, null, null]);
        });

        it('fetches one first-issue cover per result for a search someone is looking at', async () => {
            vi.mocked(global.fetch).mockImplementation(async (url: any) => {
                const id = String(url).match(/series\/(\d+)\/issue_list/)?.[1];
                return id !== undefined ? respond({ results: [{ image: `https://static.metron.cloud/${id}.jpg` }] }) : respond({ results: series(3) });
            });

            const results = await provider.searchSeries('Batman', 1, { covers: true });

            expect(coverCalls()).toHaveLength(3);
            expect(results.map(r => r.coverUrl)).toEqual(['https://static.metron.cloud/0.jpg', 'https://static.metron.cloud/1.jpg', 'https://static.metron.cloud/2.jpg']);
            expect(results.some(r => r.coverPending)).toBe(false);
        });

        it('tells a skipped cover apart from a series that has none, so the page is not cached without it', async () => {
            vi.mocked(global.fetch).mockImplementation(async (url: any) => {
                const u = String(url);
                if (u.includes('/series/0/issue_list/')) throw new Error('socket hang up');
                if (u.includes('/series/1/issue_list/')) return respond({ results: [] });
                return respond({ results: series(2) });
            });

            const [skipped, none] = await provider.searchSeries('Batman', 1, { covers: true });

            expect(skipped).toMatchObject({ coverUrl: null, coverPending: true });
            expect(none.coverUrl).toBeNull();
            expect(none.coverPending).toBeFalsy();
        });

        it('slices Metron\'s 100-result pages into ten 10-result pages', async () => {
            vi.mocked(global.fetch).mockImplementation(async (url: any) =>
                respond({ results: String(url).includes('page=2') ? series(100, 100) : series(100) }));

            const sixth = await provider.searchSeries('Spider', 6);
            expect(vi.mocked(global.fetch).mock.calls.at(-1)![0]).toContain('page=1');
            expect(sixth.map(r => r.sourceId)).toEqual(Array.from({ length: 10 }, (_, i) => String(50 + i)));

            const eleventh = await provider.searchSeries('Spider', 11);
            expect(vi.mocked(global.fetch).mock.calls.at(-1)![0]).toContain('page=2');
            expect(eleventh.map(r => r.sourceId)).toEqual(Array.from({ length: 10 }, (_, i) => String(100 + i)));
        });
    });

    it('should respect the Retry-After header when hitting a 429 Rate Limit', async () => {
        // First call returns 429 Too Many Requests, telling us to wait 1 second
        const headers = new Headers();
        headers.set('retry-after', '1');

        vi.mocked(global.fetch)
            .mockResolvedValueOnce({ status: 429, headers, json: async () => ({}) } as any)
            .mockResolvedValueOnce({ status: 200, headers: new Headers(), json: async () => ({ results: [{ id: 1, series: 'Batman' }] }) } as any);

        const started = Date.now();
        const results = await provider.searchSeries('Batman', 1);

        expect(results).toHaveLength(1);
        // The shared Metron client (src/lib/metron/client.ts) held the retry for the full Retry-After.
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('Rate limited: waiting 1s'), 'warn');
        expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
        expect(vi.mocked(global.fetch).mock.calls[1][0]).toContain('/series/?name=Batman');
    });
});