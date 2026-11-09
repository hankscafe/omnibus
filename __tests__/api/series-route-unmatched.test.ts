// /api/library/series - each row says whether it is matched to a provider issue. A file the scan (or
// an import) couldn't identify sits in the run under a placeholder `unmatched_…` id, or no id at all;
// the series page lists those for an admin to link to the right missing issue. The rows never said
// so (the page looked for fields the reply doesn't have), so that list was always empty.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/library/series/route';
import { prisma } from '@/lib/db';
import { getReq } from '../helpers/request';

vi.mock('next-auth/next', () => ({ getServerSession: vi.fn().mockResolvedValue(null) }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn(async () => ({})) }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: vi.fn() } }));
vi.mock('@/lib/library-access', () => ({
    getAccessibleLibraryPaths: vi.fn(async () => []),
    canAccessPath: vi.fn(() => true),
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        library: { findMany: vi.fn() },
        series: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(async () => []) },
        issue: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), update: vi.fn() },
        attachedVolume: { findMany: vi.fn(async () => []) },
        favorite: { findUnique: vi.fn() },
        seriesFollow: { findUnique: vi.fn() },
        readProgress: { findMany: vi.fn(async () => []) },
    }
}));
// Every stored path exists; the folder itself is absent (no file sync).
vi.mock('fs-extra', () => ({
    default: {
        existsSync: vi.fn(() => false),
        promises: { readdir: vi.fn(async () => []), access: vi.fn(async () => undefined) },
    }
}));

const FOLDER = '/comics/Image/Saga (2012)';
const row = (id: string, n: string, metadataId: string | null, filePath: string | null) => ({
    id, number: n, isAnnual: false, metadataId, filePath, name: null, attachedVolumeId: null, attachedVolume: null,
});
const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

describe('/api/library/series: matched and unmatched rows', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mock(prisma.library.findMany).mockResolvedValue([{ id: 'lib1', path: '/comics' }]);
        mock(prisma.series.findFirst).mockResolvedValue({ id: 's1', name: 'Saga', year: 2012, folderPath: FOLDER, metadataId: '4242', metadataSource: 'COMICVINE' });
        mock(prisma.issue.deleteMany).mockResolvedValue({ count: 0 });
    });

    const load = async () => (await GET(getReq(`http://localhost/api/library/series?path=${encodeURIComponent(FOLDER)}`))).json();

    it('marks a file under a placeholder id, or no id, as unmatched - and a provider-matched one as matched', async () => {
        mock(prisma.issue.findMany).mockResolvedValue([
            row('matched', '1', '9100001', `${FOLDER}/Saga #001.cbz`),
            row('placeholder', '2', 'unmatched_6f2c', `${FOLDER}/saga scan 2.cbz`),
            row('no_id', '3', null, `${FOLDER}/saga-3.cbz`),
            row('skeleton', '4', '9100004', null),
        ]);
        const body = await load();

        const byId = Object.fromEntries(body.downloadedIssues.map((i: { id: string; isUnmatched: boolean }) => [i.id, i.isUnmatched]));
        expect(byId).toEqual({ matched: false, placeholder: true, no_id: true });
        // The provider skeleton is a missing issue - something an unmatched file can be linked to.
        expect(body.missingIssues.map((i: { id: string; isUnmatched: boolean }) => [i.id, i.isUnmatched])).toEqual([['skeleton', false]]);
    });
});
