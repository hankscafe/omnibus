import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/search/cover/route';

// Metron beta 4: one Metron series' cover, for a result someone is about to look at - Smart Match's
// Auto-Scan searches without covers, then asks for the cover of the one suggestion it shows.

const mocks = vi.hoisted(() => ({ seriesCover: vi.fn() }));
vi.mock('@/lib/metadata/providers/metron', () => ({
    MetronProvider: class { seriesCover = mocks.seriesCover; },
}));

const get = (qs: string) => GET(new Request(`http://localhost/api/search/cover?${qs}`));

describe('GET /api/search/cover', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns the series\' first-issue cover through the cover proxy', async () => {
        mocks.seriesCover.mockResolvedValue('https://static.metron.cloud/16180.jpg');

        const res = await get('provider=METRON&id=16180');

        expect(res.status).toBe(200);
        expect(mocks.seriesCover).toHaveBeenCalledWith('16180');
        expect(await res.json()).toEqual({ image: `/api/library/cover?path=${encodeURIComponent('https://static.metron.cloud/16180.jpg')}` });
    });

    it('answers null when there is no cover (or Metron was too busy to ask)', async () => {
        mocks.seriesCover.mockResolvedValue(null);
        expect(await (await get('provider=METRON&id=16180')).json()).toEqual({ image: null });
    });

    it('takes a numeric Metron series id only', async () => {
        expect((await get('provider=METRON')).status).toBe(400);
        expect((await get('provider=METRON&id=abc')).status).toBe(400);
        expect((await get('provider=COMICVINE&id=16180')).status).toBe(400);
        expect(mocks.seriesCover).not.toHaveBeenCalled();
    });
});
