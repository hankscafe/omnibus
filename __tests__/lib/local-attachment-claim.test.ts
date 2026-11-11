// #257: the LOCAL editions' name claim before a provider sync pairs the run (Node twin of the
// engine's claim_local_attachments).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ attachedVolumeFindMany: vi.fn(), issueFindMany: vi.fn(), issueUpdate: vi.fn() }));
vi.mock('@/lib/db', () => ({
    prisma: {
        attachedVolume: { findMany: mocks.attachedVolumeFindMany },
        issue: { findMany: mocks.issueFindMany, update: mocks.issueUpdate },
    },
}));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));

import { claimLocalAttachments } from '@/lib/local-attachment-claim';

const lanes = [
    { id: 'attTpb', name: 'Saga TPB', kind: 'COLLECTED', metadataSource: 'LOCAL' },
    { id: 'attAnn', name: 'Saga Annuals', kind: 'ANNUAL', metadataSource: 'LOCAL' },
    { id: 'attCv', name: 'Saga Deluxe Edition', kind: 'COLLECTED', metadataSource: 'COMICVINE' },
];

describe('claimLocalAttachments', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.attachedVolumeFindMany.mockResolvedValue(lanes);
        mocks.issueUpdate.mockResolvedValue({});
    });

    it("binds a book named for a LOCAL edition to it, and leaves the run's issues and provider lanes' files alone", async () => {
        mocks.issueFindMany.mockResolvedValue([
            { id: 'tpb2', filePath: '/comics/Saga (2012)/Saga TPB Vol. 002 (2013).cbz', name: null },
            { id: 'run1', filePath: '/comics/Saga (2012)/Saga 001 (2012).cbz', name: 'Chapter One' },
            { id: 'dlx1', filePath: '/comics/Saga (2012)/Saga Deluxe Edition Vol. 001 (2014).cbz', name: null },
            // A Windows path: the filename is still what the rule reads.
            { id: 'ann1', filePath: 'C:\\comics\\Saga (2012)\\Saga Annuals 001 (2015).cbz', name: 'The Blue Lake' },
        ]);

        expect(await claimLocalAttachments('s1', 'Saga')).toBe(2);

        expect(mocks.issueFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { seriesId: 's1', attachedVolumeId: null, filePath: { not: null }, NOT: { filePath: '' } },
        }));
        expect(mocks.issueUpdate).toHaveBeenCalledTimes(2);
        expect(mocks.issueUpdate).toHaveBeenCalledWith({
            where: { id: 'tpb2' },
            data: {
                attachedVolumeId: 'attTpb', isAnnual: false, matchState: 'MATCHED',
                metadataId: 'local_attTpb_2', metadataSource: 'LOCAL', number: '2', name: 'Vol. 2',
            },
        });
        // An annual edition's book is an annual, and a real title is kept.
        expect(mocks.issueUpdate).toHaveBeenCalledWith({
            where: { id: 'ann1' },
            data: {
                attachedVolumeId: 'attAnn', isAnnual: true, matchState: 'MATCHED',
                metadataId: 'local_attAnn_1', metadataSource: 'LOCAL', number: '1',
            },
        });
    });

    it('reads no issues for a series without a LOCAL edition', async () => {
        mocks.attachedVolumeFindMany.mockResolvedValue([lanes[2]]);
        expect(await claimLocalAttachments('s1', 'Saga')).toBe(0);
        expect(mocks.issueFindMany).not.toHaveBeenCalled();
    });

    it('counts only the books it could bind', async () => {
        mocks.issueFindMany.mockResolvedValue([
            { id: 'tpb1', filePath: '/comics/Saga (2012)/Saga TPB Vol. 001 (2012).cbz', name: null },
            { id: 'tpb2', filePath: '/comics/Saga (2012)/Saga TPB Vol. 002 (2013).cbz', name: 'Issue #2' },
        ]);
        mocks.issueUpdate.mockRejectedValueOnce(new Error('locked'));
        expect(await claimLocalAttachments('s1', 'Saga')).toBe(1);
        expect(mocks.issueUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: 'tpb2' }, data: expect.objectContaining({ name: 'Vol. 2' }) }));
    });
});
