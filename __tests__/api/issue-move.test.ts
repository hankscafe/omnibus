import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    issueFindMany: vi.fn(),
    issueUpdate: vi.fn(),
    seriesFindUnique: vi.fn(),
    seriesCreate: vi.fn(),
    libraryFindUnique: vi.fn(),
    libraryFindFirst: vi.fn(),
    auditLog: vi.fn(),
    log: vi.fn(),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    pathExists: vi.fn().mockResolvedValue(false),
    move: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/db', () => ({
    prisma: {
        issue: { findMany: mocks.issueFindMany, update: mocks.issueUpdate },
        series: { findUnique: mocks.seriesFindUnique, create: mocks.seriesCreate },
        library: { findUnique: mocks.libraryFindUnique, findFirst: mocks.libraryFindFirst },
    },
}));
vi.mock('fs-extra', () => ({ default: { ensureDir: mocks.ensureDir, pathExists: mocks.pathExists, move: mocks.move } }));

import { POST } from '@/app/api/library/issue/move/route';
import { makePostJson } from '../helpers/request';

const req = makePostJson('http://x/api/library/issue/move');

describe('POST /api/library/issue/move', () => {
    beforeEach(() => {
        mocks.getServerSession.mockResolvedValue({ user: { role: 'ADMIN', id: 'admin1' } });
        mocks.pathExists.mockResolvedValue(false);
    });

    it('rejects a non-admin', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { role: 'USER' } });
        const res = await POST(req({ issueIds: ['i1'], targetSeriesId: 's2' }));
        expect(res.status).toBe(403);
    });

    it('rejects an empty selection', async () => {
        const res = await POST(req({ targetSeriesId: 's2' }));
        expect(res.status).toBe(400);
    });

    it('moves an issue to an existing series — re-points seriesId and relocates the file', async () => {
        mocks.issueFindMany.mockResolvedValue([
            { id: 'i1', seriesId: 's1', filePath: '/lib/A/i1.cbz', series: { id: 's1', libraryId: 'lib1', isManga: false } },
        ]);
        mocks.seriesFindUnique.mockResolvedValue({ id: 's2', name: 'Correct Series', folderPath: '/lib/B' });
        // Source file exists; the destination does not (no collision).
        mocks.pathExists.mockImplementation(async (p: string) => p === '/lib/A/i1.cbz');

        const res = await POST(req({ issueIds: ['i1'], targetSeriesId: 's2' }));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.moved).toBe(1);
        expect(mocks.move).toHaveBeenCalledWith('/lib/A/i1.cbz', expect.stringContaining('i1.cbz'), { overwrite: false });
        expect(mocks.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'i1' },
            data: expect.objectContaining({ seriesId: 's2' }),
        }));
    });

    it('creates a new UNMATCHED series when given newSeriesName, and re-points issues to it', async () => {
        mocks.issueFindMany.mockResolvedValue([
            { id: 'i1', seriesId: 's1', filePath: null, series: { id: 's1', libraryId: 'lib1', isManga: false } },
        ]);
        mocks.libraryFindUnique.mockResolvedValue({ id: 'lib1', path: '/lib', isManga: false });
        mocks.seriesCreate.mockResolvedValue({ id: 'sNew', name: 'Brand New', folderPath: '/lib/Brand New' });

        const res = await POST(req({ issueIds: ['i1'], newSeriesName: 'Brand New' }));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(mocks.seriesCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ name: 'Brand New', matchState: 'UNMATCHED', libraryId: 'lib1' }),
        }));
        expect(mocks.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ seriesId: 'sNew' }),
        }));
        // A metadata-only issue (no filePath) doesn't trigger a file move.
        expect(mocks.move).not.toHaveBeenCalled();
    });

    // An attached volume's rows (annuals, collected editions) belong to the attachment's series. Moved into
    // another series, a row that kept the link was still that lane's row there: the parent's next attach
    // sync had to unbind it (#239's prepare_lane), and until then the lane counted a book it no longer held.
    describe('attachment links', () => {
        beforeEach(() => {
            mocks.issueUpdate.mockClear();
            mocks.seriesFindUnique.mockResolvedValue({ id: 's2', name: 'Other Series', folderPath: '/lib/B' });
        });

        it('asks for each issue\'s attachment and which series it belongs to', async () => {
            mocks.issueFindMany.mockResolvedValue([{ id: 'i1', seriesId: 's1', filePath: null, series: { id: 's1', libraryId: 'lib1', isManga: false } }]);

            await POST(req({ issueIds: ['i1'], targetSeriesId: 's2' }));

            expect(mocks.issueFindMany).toHaveBeenCalledWith(expect.objectContaining({
                include: expect.objectContaining({ attachedVolume: { select: { seriesId: true } } }),
            }));
        });

        it("drops the link when an attached annual moves to another series", async () => {
            mocks.issueFindMany.mockResolvedValue([{
                id: 'ann1', seriesId: 's1', filePath: null, attachedVolumeId: 'att1', attachedVolume: { seriesId: 's1' },
                series: { id: 's1', libraryId: 'lib1', isManga: false },
            }]);

            await POST(req({ issueIds: ['ann1'], targetSeriesId: 's2' }));

            expect(mocks.issueUpdate).toHaveBeenCalledWith({ where: { id: 'ann1' }, data: { seriesId: 's2', filePath: null, attachedVolumeId: null } });
        });

        it("keeps the link when a lane row that strayed moves back into its attachment's own series", async () => {
            // The row sits in the kept child (the old adoption bug) carrying s2's attachment id; s2 is its home.
            mocks.issueFindMany.mockResolvedValue([{
                id: 'stray', seriesId: 's_child', filePath: null, attachedVolumeId: 'att2', attachedVolume: { seriesId: 's2' },
                series: { id: 's_child', libraryId: 'lib1', isManga: false },
            }]);

            await POST(req({ issueIds: ['stray'], targetSeriesId: 's2' }));

            expect(mocks.issueUpdate).toHaveBeenCalledWith({ where: { id: 'stray' }, data: { seriesId: 's2', filePath: null } });
        });

        it("leaves an ordinary issue's update as it was", async () => {
            mocks.issueFindMany.mockResolvedValue([{
                id: 'i1', seriesId: 's1', filePath: null, attachedVolumeId: null, attachedVolume: null,
                series: { id: 's1', libraryId: 'lib1', isManga: false },
            }]);

            await POST(req({ issueIds: ['i1'], targetSeriesId: 's2' }));

            expect(mocks.issueUpdate).toHaveBeenCalledWith({ where: { id: 'i1' }, data: { seriesId: 's2', filePath: null } });
        });
    });

    it('requires a destination (target series or new name)', async () => {
        mocks.issueFindMany.mockResolvedValue([
            { id: 'i1', seriesId: 's1', filePath: null, series: { id: 's1', libraryId: 'lib1', isManga: false } },
        ]);
        const res = await POST(req({ issueIds: ['i1'] }));
        expect(res.status).toBe(400);
    });
});
