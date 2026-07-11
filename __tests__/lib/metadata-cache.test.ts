// __tests__/lib/metadata-cache.test.ts
//
// The shared CV/Metron response cache: key normalization (api_key MUST never leak into keys),
// detail/list classification, read-time TTL from live settings, the size guard, and the
// cachedCvGet contract (hit = no axios + no usage log; miss = fetch + cache + usage log).
// The parity literals at the bottom are asserted byte-for-byte by the engine's
// metadata_cache.rs tests too — if either side changes normalization, both suites fail.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    normalizeCacheUrl, classifyProviderUrl, cacheKey,
    getCachedResponse, putCachedResponse, cachedCvGet, MAX_CACHE_BODY_BYTES
} from '@/lib/metadata/metadata-cache';

const mocks = vi.hoisted(() => ({
    settingFindUnique: vi.fn(),
    cacheFindUnique: vi.fn(),
    cacheUpsert: vi.fn(),
    axiosGet: vi.fn(),
    logApiUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findUnique: mocks.settingFindUnique },
        metadataCache: { findUnique: mocks.cacheFindUnique, upsert: mocks.cacheUpsert },
    }
}));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: mocks.axiosGet } }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));
vi.mock('@/lib/utils/system-flags', () => ({ logApiUsage: mocks.logApiUsage }));

// Settings shape used across tests: cache on, default TTLs unless overridden.
const settings = (overrides: Record<string, string> = {}) => {
    const base: Record<string, string> = { metadata_cache_enabled: 'true', ...overrides };
    mocks.settingFindUnique.mockImplementation(async ({ where }: any) =>
        base[where.key] !== undefined ? { key: where.key, value: base[where.key] } : null
    );
};

describe('metadata-cache: normalization and classification', () => {
    it('strips api_key and sorts params so key rotation and param order cannot fragment the cache', () => {
        const a = normalizeCacheUrl('https://comicvine.gamespot.com/api/issues/?offset=0&filter=volume:123&api_key=SECRET&format=json');
        const b = normalizeCacheUrl('https://comicvine.gamespot.com/api/issues/?format=json&api_key=OTHER&offset=0&filter=volume:123');
        expect(a).toBe(b);
        expect(a).not.toContain('SECRET');
        expect(a).not.toContain('api_key');
        expect(cacheKey('comicvine', a)).toBe(cacheKey('comicvine', b));
    });

    it('classifies by-id lookups as detail and searches/lists as list, and refuses the rest', () => {
        expect(classifyProviderUrl('https://comicvine.gamespot.com/api/volume/4050-123/?format=json')).toBe('detail');
        expect(classifyProviderUrl('https://comicvine.gamespot.com/api/issue/4000-99/')).toBe('detail');
        expect(classifyProviderUrl('https://comicvine.gamespot.com/api/story_arc/4045-1/')).toBe('detail');
        expect(classifyProviderUrl('https://comicvine.gamespot.com/api/issues/?filter=volume:1')).toBe('list');
        expect(classifyProviderUrl('https://comicvine.gamespot.com/api/search/?query=spawn')).toBe('list');
        expect(classifyProviderUrl('https://metron.cloud/api/issue/5555/')).toBe('detail');
        expect(classifyProviderUrl('https://metron.cloud/api/series/123/issue_list/?page=2')).toBe('list');
        expect(classifyProviderUrl('https://metron.cloud/api/series/?name=spawn')).toBe('list');
        // Never cached: key-validation probe and garbage.
        expect(classifyProviderUrl('https://comicvine.gamespot.com/api/types/')).toBeNull();
        expect(classifyProviderUrl('not a url')).toBeNull();
    });

    it('produces the same keys as the engine implementation (cross-language parity literals)', () => {
        // These exact literals are asserted in omnibus-engine/src/metadata_cache.rs — if either
        // implementation drifts, both suites fail and the shared cache silently splitting is caught.
        expect(normalizeCacheUrl('https://metron.cloud/api/issue/5555/')).toBe('https://metron.cloud/api/issue/5555/');
        expect(cacheKey('metron', 'https://metron.cloud/api/issue/5555/'))
            .toBe('metron:9a66f85b10bde831683415a6c18279ab92eebe087361dca79044212f4a4b3986');
        expect(normalizeCacheUrl('https://comicvine.gamespot.com/api/issues/?offset=0&filter=volume:123&api_key=SECRET&format=json'))
            .toBe('https://comicvine.gamespot.com/api/issues/?filter=volume%3A123&format=json&offset=0');
        expect(cacheKey('comicvine', 'https://comicvine.gamespot.com/api/issues/?filter=volume%3A123&format=json&offset=0'))
            .toBe('comicvine:668d64706ea6e2b275307724eb8aec8a3115c8e78302de0bbd6fdcdda0d4aadb');
    });
});

describe('metadata-cache: read/write behavior', () => {
    const DETAIL_URL = 'https://metron.cloud/api/issue/5555/';

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.cacheUpsert.mockResolvedValue({});
    });

    it('returns null when the cache is disabled, without touching the table', async () => {
        settings({ metadata_cache_enabled: 'false' });
        expect(await getCachedResponse('metron', DETAIL_URL)).toBeNull();
        expect(mocks.cacheFindUnique).not.toHaveBeenCalled();
    });

    it('serves a fresh entry and honors the CURRENT TTL settings at read time', async () => {
        settings();
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
        mocks.cacheFindUnique.mockResolvedValue({ key: 'k', kind: 'detail', value: '{"id":5555}', createdAt: threeDaysAgo });

        // Default detail TTL (7d): a 3-day-old entry is fresh.
        expect(await getCachedResponse('metron', DETAIL_URL)).toEqual({ id: 5555 });

        // Admin drops the detail TTL to 1 day: the SAME stored entry is now expired — no waiting
        // for old entries to age out under the TTL they were written with.
        settings({ metadata_cache_detail_days: '1' });
        expect(await getCachedResponse('metron', DETAIL_URL)).toBeNull();
    });

    it('skips oversized bodies but stores normal ones with a fresh createdAt', async () => {
        settings();
        await putCachedResponse('metron', DETAIL_URL, { huge: 'x'.repeat(MAX_CACHE_BODY_BYTES) });
        expect(mocks.cacheUpsert).not.toHaveBeenCalled();

        await putCachedResponse('metron', DETAIL_URL, { id: 5555 });
        expect(mocks.cacheUpsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({ kind: 'detail', value: '{"id":5555}' })
        }));
    });

    it('never caches an unclassified URL', async () => {
        settings();
        await putCachedResponse('comicvine', 'https://comicvine.gamespot.com/api/types/', { ok: 1 });
        expect(mocks.cacheUpsert).not.toHaveBeenCalled();
    });
});

describe('metadata-cache: cachedCvGet contract', () => {
    const URL_ = 'https://comicvine.gamespot.com/api/volume/4050-123/';
    const OPTS = { params: { api_key: 'SECRET', format: 'json', field_list: 'name' } };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.cacheUpsert.mockResolvedValue({});
        mocks.axiosGet.mockResolvedValue({ status: 200, data: { results: { name: 'Spawn' } } });
    });

    it('a hit skips axios AND the usage log (it is not an upstream call)', async () => {
        settings();
        mocks.cacheFindUnique.mockResolvedValue({ key: 'k', kind: 'detail', value: '{"results":{"name":"Cached"}}', createdAt: new Date() });

        const res = await cachedCvGet(URL_, OPTS);

        expect(res.cached).toBe(true);
        expect(res.data.results.name).toBe('Cached');
        expect(mocks.axiosGet).not.toHaveBeenCalled();
        expect(mocks.logApiUsage).not.toHaveBeenCalled();
    });

    it('a miss fetches, logs REAL usage with the coarse endpoint key, and caches the body', async () => {
        settings();
        mocks.cacheFindUnique.mockResolvedValue(null);

        const res = await cachedCvGet(URL_, OPTS);

        expect(res.cached).toBe(false);
        expect(mocks.axiosGet).toHaveBeenCalledWith(URL_, OPTS);
        expect(mocks.logApiUsage).toHaveBeenCalledWith('comicvine', '/volume');
        // Cached under the FULL effective url (config.params folded in, api_key stripped).
        const upsert = mocks.cacheUpsert.mock.calls[0][0];
        expect(upsert.create.url).toContain('field_list=name');
        expect(upsert.create.url).not.toContain('SECRET');
    });

    it('bypassCache skips the read but still refreshes the stored entry (admin Refresh Metadata)', async () => {
        settings();
        mocks.cacheFindUnique.mockResolvedValue({ key: 'k', kind: 'detail', value: '{"results":{"name":"Stale"}}', createdAt: new Date() });

        const res = await cachedCvGet(URL_, OPTS, true);

        expect(res.cached).toBe(false);
        expect(res.data.results.name).toBe('Spawn'); // live fetch, not the stored value
        expect(mocks.axiosGet).toHaveBeenCalled();
        expect(mocks.cacheUpsert).toHaveBeenCalled(); // fresh body replaces the entry
    });
});
