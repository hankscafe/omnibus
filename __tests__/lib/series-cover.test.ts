// The comic's own first page as a cover (#257): extracted by the engine and downscaled here, and a
// series cover saved as the locked custom cover — shared by archive-cover, cover-upload and the
// collected-edition attach.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    seriesUpdate: vi.fn(), pathExists: vi.fn(), remove: vi.fn(), writeFile: vi.fn(), toBuffer: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: { series: { update: mocks.seriesUpdate } } }));
vi.mock('@/lib/engine', () => ({ ENGINE_URL: 'http://engine', engineHeaders: (e: any) => ({ ...e }) }));
vi.mock('fs-extra', () => ({ default: { pathExists: mocks.pathExists, remove: mocks.remove, writeFile: mocks.writeFile } }));
vi.mock('sharp', () => ({ default: vi.fn(() => ({ resize: () => ({ jpeg: () => ({ toBuffer: mocks.toBuffer }) }) })) }));

import { archiveCoverJpeg, saveCustomSeriesCover } from '@/lib/series-cover';

describe('archiveCoverJpeg', () => {
    let fetchMock: any;
    beforeEach(() => {
        vi.clearAllMocks();
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it("asks the engine for the archive's first page by absolute path and downscales it to a JPEG", async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, headers: new Headers() });
        mocks.toBuffer.mockResolvedValue(Buffer.from('small'));
        const r = await archiveCoverJpeg('/data/library/Comics/X/Vol. 001.cbr');
        expect(fetchMock).toHaveBeenCalledWith('http://engine/api/converter/extract-cover', expect.objectContaining({
            method: 'POST', body: JSON.stringify({ path: '/data/library/Comics/X/Vol. 001.cbr' }),
        }));
        expect(r).toEqual({ ok: true, body: Buffer.from('small'), contentType: 'image/jpeg' });
    });

    it('serves the raw page when it cannot be decoded, and tells "no page" from "engine failed"', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([9]).buffer, headers: new Headers({ 'content-type': 'image/webp' }) });
        mocks.toBuffer.mockRejectedValue(new Error('unsupported'));
        expect(await archiveCoverJpeg('/x.cbz')).toEqual({ ok: true, body: Buffer.from([9]), contentType: 'image/webp' });
        fetchMock.mockResolvedValue({ ok: false, status: 404 });
        expect(await archiveCoverJpeg('/x.cbz')).toEqual({ ok: false, status: 404 });
        fetchMock.mockResolvedValue({ ok: false, status: 500 });
        expect(await archiveCoverJpeg('/x.cbz')).toEqual({ ok: false, status: 502 });
        fetchMock.mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0), headers: new Headers() });
        expect(await archiveCoverJpeg('/x.cbz')).toEqual({ ok: false, status: 404 });
    });
});

describe('saveCustomSeriesCover', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('writes cover.jpg, removes the other cover files, and locks it on the series', async () => {
        mocks.pathExists.mockImplementation(async (p: string) => p.endsWith('cover.png'));
        const url = await saveCustomSeriesCover('s1', '/comics/Saga (2012)', Buffer.from('img'));
        expect(mocks.remove).toHaveBeenCalledWith('/comics/Saga (2012)/cover.png');
        expect(mocks.writeFile).toHaveBeenCalledWith('/comics/Saga (2012)/cover.jpg', Buffer.from('img'));
        expect(mocks.seriesUpdate).toHaveBeenCalledWith({ where: { id: 's1' }, data: { coverUrl: url, hasCustomCover: true } });
        expect(url).toMatch(/^\/api\/library\/cover\?path=%2Fcomics%2FSaga%20\(2012\)%2Fcover\.jpg&v=\d+$/);
    });
});
