// __tests__/lib/metadata/metron.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetronProvider } from '@/lib/metadata/providers/metron';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findManySettings: vi.fn(),
    log: vi.fn()
}));

// 2. Mock Dependencies
vi.mock('@/lib/db', () => ({
    prisma: { systemSetting: { findMany: mocks.findManySettings } }
}));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('@/lib/utils/system-flags', () => ({ logApiUsage: vi.fn() }));

describe('Metadata Pipeline: Metron.Cloud Provider', () => {
    let provider: MetronProvider;

    beforeEach(() => {
        vi.clearAllMocks();
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

    it('should respect the Retry-After header when hitting a 429 Rate Limit', async () => {
        // First call returns 429 Too Many Requests, telling us to wait 1 second
        const headers = new Headers();
        headers.set('retry-after', '1');
        
        vi.mocked(global.fetch)
            .mockResolvedValueOnce({ status: 429, headers, json: async () => ({}) } as any)
            .mockResolvedValueOnce({ status: 200, headers: new Headers(), json: async () => ({ results: [{ id: 1, series: 'Batman' }] }) } as any);

        // Spy on global setTimeout
        const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

        const results = await provider.searchSeries('Batman', 1);

        expect(results).toHaveLength(1);
        expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining('Rate Limit Hit'), 'warn');
        
        // Assert it waited 2 seconds (1 sec from header + 1 sec buffer) before retrying
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
    });
});