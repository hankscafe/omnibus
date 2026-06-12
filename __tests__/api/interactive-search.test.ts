// __tests__/api/interactive-search.test.ts
// The interactive search route is a thin forwarder: it POSTs the query to the Rust
// engine (/api/search/interactive) and passes the engine's JSON through verbatim.
// The Prowlarr/GetComics querying + hoster gating now live (and are tested) engine-side.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET } from '@/app/api/search/interactive/route';
import { ENGINE_URL } from '@/lib/engine';

const mocks = vi.hoisted(() => ({
    log: vi.fn(),
    engineFetch: vi.fn()
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

const createReq = (query: string, extra: Record<string, string> = {}) => {
    const params = new URLSearchParams({ q: query, ...extra });
    return new Request(`http://localhost/api/search/interactive?${params}`);
};

describe('API Route: Interactive Search (/api/search/interactive)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.NEXTAUTH_SECRET = 'test-secret';
        vi.stubGlobal('fetch', mocks.engineFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should forward the query to the Rust engine and pass its results through verbatim', async () => {
        const engineResults = {
            prowlarr: [{ title: 'Batman (Prowlarr)', guid: '1' }],
            getcomics: [{ title: 'Batman (GetComics)', link: 'http://gc/2' }]
        };
        mocks.engineFetch.mockResolvedValueOnce({ ok: true, json: async () => engineResults });

        const res = await GET(createReq('Batman'));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(mocks.engineFetch).toHaveBeenCalledWith(
            `${ENGINE_URL}/api/search/interactive`,
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Content-Type': 'application/json',
                    'X-Internal-Secret': 'test-secret'
                }),
                body: JSON.stringify({ query: 'Batman', year: null, is_manga: false })
            })
        );
        expect(data).toEqual(engineResults);
    });

    it('should map the year and isManga query params into the engine payload', async () => {
        mocks.engineFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ prowlarr: [], getcomics: [] }) });

        const res = await GET(createReq('Akira', { year: '1988', isManga: 'true' }));

        expect(res.status).toBe(200);
        expect(mocks.engineFetch).toHaveBeenCalledWith(
            `${ENGINE_URL}/api/search/interactive`,
            expect.objectContaining({
                body: JSON.stringify({ query: 'Akira', year: '1988', is_manga: true })
            })
        );
    });

    it('should return a 500 error when the engine rejects the request', async () => {
        mocks.engineFetch.mockResolvedValueOnce({ ok: false, status: 503 });

        const res = await GET(createReq('Batman'));
        const data = await res.json();

        expect(res.status).toBe(500);
        expect(data.error).toContain('503');
    });

    it('should return a 500 error when the engine is unreachable', async () => {
        mocks.engineFetch.mockRejectedValueOnce(new Error('fetch failed'));

        const res = await GET(createReq('Batman'));
        const data = await res.json();

        expect(res.status).toBe(500);
        expect(data.error).toBe('fetch failed');
    });

    it('should return a 400 error if no query is provided', async () => {
        const req = new Request('http://localhost/api/search/interactive');
        const res = await GET(req);

        expect(res.status).toBe(400);
        expect(mocks.engineFetch).not.toHaveBeenCalled();
    });
});
