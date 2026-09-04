// /api/issue-details/covers — cover thumbnails for a SET of issue ids, in one provider call.
//
// The Smart Matcher's bulk mapping binds many files to one volume at once; asking per row would
// cost one ComicVine call per file against a ~200/hour key just for thumbnails (field report by
// robotshavehearts2, who was checking covers on the provider's site instead). These tests pin the
// batching, the id hygiene, and the rule that a thumbnail failure never becomes the admin's problem.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    getToken: vi.fn(),
    cachedCvGet: vi.fn(),
    settingFindUnique: vi.fn(),
}));

vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }));
vi.mock('@/lib/metadata/metadata-cache', () => ({ cachedCvGet: mocks.cachedCvGet }));
vi.mock('@/lib/db', () => ({ prisma: { systemSetting: { findUnique: mocks.settingFindUnique } } }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));

import { POST } from '@/app/api/issue-details/covers/route';

const req = (body: any) => new Request('http://localhost/api/issue-details/covers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('API: /api/issue-details/covers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getToken.mockResolvedValue({ id: 'admin_1', role: 'ADMIN' });
        mocks.settingFindUnique.mockResolvedValue({ value: 'cv_key' });
        mocks.cachedCvGet.mockResolvedValue({
            data: { results: [
                { id: 1158158, image: { thumb_url: 'http://cv/thumb1.jpg', small_url: 'http://cv/small1.jpg' } },
                { id: 1158159, image: { small_url: 'http://cv/small2.jpg' } },
                { id: 1158160 }, // no image at all — simply absent from the map
            ] },
        });
    });

    it('asks ComicVine once for the whole set and maps id → thumbnail', async () => {
        const res = await POST(req({ ids: ['1158158', '1158159', '1158160'], provider: 'COMICVINE' }));
        const data = await res.json();

        expect(mocks.cachedCvGet).toHaveBeenCalledTimes(1);
        const params = mocks.cachedCvGet.mock.calls[0][1].params;
        expect(params.filter).toBe('id:1158158|1158159|1158160');
        // Two fields only — this is a thumbnail lookup, not a metadata fetch.
        expect(params.field_list).toBe('id,image');
        expect(data.covers).toEqual({
            '1158158': 'http://cv/thumb1.jpg',
            '1158159': 'http://cv/small2.jpg',
        });
    });

    it('never lets a non-numeric id reach the provider filter, and dedupes', async () => {
        await POST(req({ ids: ['12', '12', 'id:9|drop', '', '  34  '], provider: 'COMICVINE' }));
        expect(mocks.cachedCvGet.mock.calls[0][1].params.filter).toBe('id:12|34');
    });

    it('does no work for Metron — its covers arrive with the volume payload', async () => {
        const res = await POST(req({ ids: ['500'], provider: 'METRON' }));
        expect(await res.json()).toEqual({ covers: {} });
        expect(mocks.cachedCvGet).not.toHaveBeenCalled();
    });

    it('degrades to no covers instead of failing the request', async () => {
        // A missing key, an empty selection, and an upstream explosion are all "no thumbnails".
        mocks.settingFindUnique.mockResolvedValue({ value: '********' });
        expect((await (await POST(req({ ids: ['1'] }))).json()).covers).toEqual({});

        mocks.settingFindUnique.mockResolvedValue({ value: 'cv_key' });
        expect((await (await POST(req({ ids: [] }))).json()).covers).toEqual({});

        mocks.cachedCvGet.mockRejectedValue(new Error('ComicVine 429'));
        const res = await POST(req({ ids: ['1158158'] }));
        expect(res.status).toBe(200);
        expect((await res.json()).covers).toEqual({});
    });

    it('rejects an unauthenticated caller and a malformed body', async () => {
        mocks.getToken.mockResolvedValue(null);
        expect((await POST(req({ ids: ['1'] }))).status).toBe(401);

        mocks.getToken.mockResolvedValue({ id: 'admin_1' });
        expect((await POST(req({ }))).status).toBe(400);
    });
});
