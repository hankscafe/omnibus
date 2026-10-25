// beta.011: a direct download still running never reopens a request a person closed meanwhile
// (cancelled in My Requests, marked completed in Request Management). downloadDirectFile writes the
// request's status as it goes - Downloading as it starts, Stalled when it fails - and used to write
// it whatever the request had become, then alerted "download failed" for a request nobody wanted.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import { discordSendAlert } from '../helpers/setup-global';

const mocks = vi.hoisted(() => ({
    updateMany: vi.fn(),
    engineFetchLong: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findUnique: vi.fn(async () => null) },
        request: { updateMany: mocks.updateMany, update: vi.fn(async () => ({})), findUnique: vi.fn(async () => ({ id: 'req_1', volumeId: '0', imageUrl: null, user: { username: 'reader' } })) },
        series: { findFirst: vi.fn(async () => null) },
        customHeader: { findMany: vi.fn(async () => []) },
    },
}));
vi.mock('@/lib/engine', () => ({
    ENGINE_URL: 'http://engine',
    engineHeaders: (extra: Record<string, string> = {}) => extra,
    engineFetchLong: mocks.engineFetchLong,
}));
vi.mock('@/lib/importer', () => ({ Importer: { importRequest: vi.fn() } }));
vi.mock('@/lib/hosters', () => ({ HosterEngine: { resolveLink: vi.fn() } }));

import { DownloadService } from '@/lib/download-clients';

// Not closed: the request is still the one the download is for.
const openRequest = (id: string) => ({ id, status: { notIn: ['CANCELLED', 'COMPLETED', 'IMPORTED', 'IMPORTING'] } });
const target = path.join(os.tmpdir(), 'omnibus-direct-dl-test');
const download = () => DownloadService.downloadDirectFile('https://getcomics.org/dlds/saga-061', 'Saga 061', target, 'req_1', 'getcomics_direct');
const engineAnswers = (body: Record<string, unknown>) =>
    mocks.engineFetchLong.mockResolvedValue({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
    mocks.updateMany.mockReset().mockResolvedValue({ count: 1 });
    mocks.engineFetchLong.mockReset();
});

describe('downloadDirectFile and a request closed meanwhile', () => {
    it('streams the file while its request is still open', async () => {
        engineAnswers({ success: true });

        expect(await download()).toBe(true);

        expect(mocks.updateMany).toHaveBeenCalledWith({
            where: openRequest('req_1'),
            data: expect.objectContaining({ status: 'DOWNLOADING', progress: 0, downloadLink: 'https://getcomics.org/dlds/saga-061' }),
        });
        expect(mocks.engineFetchLong).toHaveBeenCalledTimes(1);
    });

    it("doesn't start for a request closed before its download began", async () => {
        mocks.updateMany.mockResolvedValue({ count: 0 });
        engineAnswers({ success: true });

        expect(await download()).toBe(false);

        expect(mocks.engineFetchLong).not.toHaveBeenCalled();
    });

    it('neither stalls nor alerts for a request closed while it downloaded', async () => {
        mocks.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
        engineAnswers({ success: false, error: 'connection reset' });

        await expect(download()).rejects.toThrow('connection reset');

        expect(mocks.updateMany).toHaveBeenLastCalledWith({ where: openRequest('req_1'), data: { status: 'STALLED', progress: 0 } });
        expect(discordSendAlert).not.toHaveBeenCalled();
    });

    it('stalls an open request whose download failed, and alerts', async () => {
        engineAnswers({ success: false, error: 'connection reset' });

        await expect(download()).rejects.toThrow('connection reset');

        expect(mocks.updateMany).toHaveBeenLastCalledWith({ where: openRequest('req_1'), data: { status: 'STALLED', progress: 0 } });
        expect(discordSendAlert).toHaveBeenCalledWith('download_failed', expect.objectContaining({ title: 'Saga 061.cbz' }));
    });

    it('holds a Cloudflare-gated link for manual download only while the request is open', async () => {
        mocks.updateMany.mockResolvedValueOnce({ count: 1 });
        engineAnswers({ success: false, error: 'manual download required' });

        expect(await download()).toBe(false);

        expect(mocks.updateMany).toHaveBeenLastCalledWith({
            where: openRequest('req_1'),
            data: { status: 'MANUAL_DDL', downloadLink: 'https://getcomics.org/dlds/saga-061', activeDownloadName: 'Saga 061.cbz' },
        });
    });
});
