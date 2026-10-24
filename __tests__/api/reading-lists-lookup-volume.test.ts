// /api/reading-lists/lookup-volume: a reading-list entry's provider issue id -> its volume and year, which
// the list's Request button sends so the request names the right volume instead of guessing it by name.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/reading-lists/lookup-volume/route';

const mocks = vi.hoisted(() => ({
    cachedCvGet: vi.fn(),
    settingFindUnique: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: { systemSetting: { findUnique: mocks.settingFindUnique } } }));
vi.mock('@/lib/metadata/metadata-cache', () => ({ cachedCvGet: mocks.cachedCvGet }));
vi.mock('@/lib/metron/client', () => ({ getMetronAuth: vi.fn(async () => null), metronGet: vi.fn() }));

const lookup = (issueId: string, provider = 'COMICVINE') =>
    GET(new Request(`http://localhost/api/reading-lists/lookup-volume?issueId=${issueId}&provider=${provider}`));

describe('API: reading-lists lookup-volume', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.settingFindUnique.mockResolvedValue({ key: 'cv_api_key', value: 'cv-key' });
    });

    it("asks ComicVine's issue resource (type 4000) and returns the volume id and cover year", async () => {
        mocks.cachedCvGet.mockResolvedValue({ data: { status_code: 1, results: { cover_date: '2024-12-01', volume: { id: 160186, name: 'DC All In Special' } } } });

        const data = await (await lookup('1072173')).json();

        // 4040 is ComicVine's PERSON type: /issue/4040-<id>/ answers "Error in URL Format" with no results.
        expect(mocks.cachedCvGet).toHaveBeenCalledWith('https://comicvine.gamespot.com/api/issue/4000-1072173/', expect.anything());
        expect(data).toEqual({ volumeId: 160186, year: '2024' });
    });

    it('answers no volume when ComicVine has no such issue', async () => {
        mocks.cachedCvGet.mockResolvedValue({ data: { status_code: 101, error: 'Object Not Found', results: [] } });

        expect(await (await lookup('1')).json()).toEqual({ volumeId: 0, year: null });
    });
});
