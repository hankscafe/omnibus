import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Metron beta 4 (#216 follow-up): requesting a Metron series ran the per-issue detail pass (one
// /issue/{id}/ request per issue) for every issue of the series - even with the "per-issue credits"
// setting off, and even for the dozens of issues with no file. It now follows the setting and fetches
// only issues on disk (the same filter the engine and the Refresh button's count use).

const mocks = vi.hoisted(() => ({
    settings: new Map<string, string>(),
    seriesFindFirst: vi.fn(),
    seriesUpdate: vi.fn(),
    issueFindMany: vi.fn(),
    issueUpdate: vi.fn(),
    issueFindFirst: vi.fn(),
    getIssueDetails: vi.fn(),
    getSeriesIssues: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
    queueAdd: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findFirst: mocks.seriesFindFirst, update: mocks.seriesUpdate },
        issue: { findMany: mocks.issueFindMany, update: mocks.issueUpdate, findFirst: mocks.issueFindFirst, create: vi.fn(async () => ({ id: 'new' })) },
        systemSetting: { findUnique: vi.fn(async ({ where }: any) => (mocks.settings.has(where.key) ? { key: where.key, value: mocks.settings.get(where.key) } : null)) },
    },
}));
vi.mock('@/lib/metadata/providers/metron', () => ({
    MetronProvider: class {
        getSeriesDetails = async () => ({ name: 'Saga', publisher: 'Image', year: 2012, status: 'Ongoing', coverUrl: null, description: null });
        getSeriesIssues = mocks.getSeriesIssues;
        getIssueDetails = mocks.getIssueDetails;
    },
}));
vi.mock('@/lib/metron/client', () => ({ metronOptionalBudgetExhausted: vi.fn(async () => false) }));
vi.mock('@/lib/queue', () => ({ omnibusQueue: { add: mocks.queueAdd } }));
vi.mock('@/lib/utils/system-flags', () => ({ markSystemFlag: vi.fn(), countApiUsage: vi.fn(async () => 0), logApiUsage: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: vi.fn() } }));
vi.mock('fs-extra', () => ({ default: { existsSync: vi.fn(() => false), mkdirSync: vi.fn(), writeFile: vi.fn() } }));
vi.mock('fs', () => ({ default: { existsSync: vi.fn(() => false) } }));

import { syncSeriesMetadata } from '@/lib/metadata-fetcher';
import { metronCreditCandidatesWhere } from '@/lib/metron/credit-candidates';

const CANDIDATE = { id: 'i1', metadataId: '9001', number: '1', name: null, writers: null, artists: null, coverArtists: null, colorists: null, letterers: null, characters: null, teams: null, storyArcs: null };
const candidateQueries = () => mocks.issueFindMany.mock.calls.filter(([arg]: any[]) => arg?.where?.matchState);

describe('Metron request-path detail pass (metadata-fetcher)', () => {
    let originalSetTimeout: typeof setTimeout;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.settings.clear();
        originalSetTimeout = global.setTimeout;
        vi.stubGlobal('setTimeout', (cb: (...args: unknown[]) => void) => originalSetTimeout(cb, 0));
        mocks.seriesFindFirst.mockResolvedValue({ id: 's1', name: 'Saga', metadataId: '4000', metadataSource: 'METRON', folderPath: '', year: 2012, coverUrl: null });
        mocks.issueFindMany.mockImplementation(async ({ where }: any) => (where?.matchState ? [CANDIDATE] : []));
        mocks.getIssueDetails.mockResolvedValue({ writers: ['Brian K. Vaughan'], artists: ['Fiona Staples'], storyTitle: 'Chapter One' });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('fetches no per-issue details while the setting is off', async () => {
        await syncSeriesMetadata('4000', '', 'METRON');

        expect(mocks.getIssueDetails).not.toHaveBeenCalled();
        expect(candidateQueries()).toHaveLength(0);
    });

    it('with the setting on, fetches details for the issues on disk that are missing them', async () => {
        mocks.settings.set('metron_detail_credits', 'true');

        await syncSeriesMetadata('4000', '', 'METRON');

        expect(candidateQueries().map(([arg]: any[]) => arg.where)).toEqual([metronCreditCandidatesWhere('s1')]);
        expect(mocks.getIssueDetails).toHaveBeenCalledWith('9001');
        expect(mocks.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'i1' }, data: expect.objectContaining({ matchState: 'DEEP_SYNCED', writers: JSON.stringify(['Brian K. Vaughan']) }),
        }));
    });

    // Review of #232 (#251 beta): the Metron list sync's release-date guard, through the real loop.
    it("with file priority on, keeps a filed issue's own release date and moves a placeholder's", async () => {
        mocks.settings.set('file_metadata_priority', 'true');
        mocks.issueFindMany.mockImplementation(async ({ where }: { where?: { isAnnual?: boolean } }) => (where?.isAnnual === false ? [
            { id: 'r1', number: '1', metadataId: '9001', matchState: 'MATCHED', hasCustomMetadata: false,
              filePath: '/comics/Saga/Saga #001.cbz', releaseDate: '2012-03-21' },
            { id: 'r2', number: '2', metadataId: '9002', matchState: 'MATCHED', hasCustomMetadata: false,
              filePath: null, releaseDate: '2012-04-04' },
        ] : []));
        mocks.getSeriesIssues.mockResolvedValueOnce([
            { issueNumber: '1', sourceId: '9001', name: 'Saga (2012) #1', releaseDate: '2012-03-14' },
            { issueNumber: '2', sourceId: '9002', name: 'Saga (2012) #2', releaseDate: '2012-04-25' },
        ]);

        await syncSeriesMetadata('4000', '', 'METRON');

        const updates = mocks.issueUpdate.mock.calls.map(c => c[0]);
        expect(updates.find(u => u.where.id === 'r1').data.releaseDate).toBe('2012-03-21');
        expect(updates.find(u => u.where.id === 'r2').data.releaseDate).toBe('2012-04-25');
    });

    // #239: the cross-series adoption probe never reaches for an attached lane's skeleton (ComicVine twin
    // asserted in metadata-fetcher.test.ts).
    it("never adopts another series' attached-lane row", async () => {
        mocks.getSeriesIssues.mockResolvedValueOnce([{ issueNumber: '2', sourceId: '9002', name: 'Saga (2012) #2', releaseDate: '2012-04-25' }]);

        await syncSeriesMetadata('4000', '', 'METRON');

        const probe = mocks.issueFindFirst.mock.calls.map(c => c[0]).find((a: any) => a?.where?.metadataId === '9002');
        expect(probe?.where).toMatchObject({ metadataSource: 'METRON', seriesId: { not: 's1' }, isAnnual: false });
        expect(probe?.where?.attachedVolumeId).toBeNull();
    });

    // #251: the Metron branch queued its embed unconditionally too.
    it('with ComicInfo writing off, queues the series.json export instead of an embed', async () => {
        mocks.settings.set('metadata_write_comicinfo', 'false');

        await syncSeriesMetadata('4000', '', 'METRON');

        expect(mocks.queueAdd).not.toHaveBeenCalledWith('EMBED_METADATA', expect.anything(), expect.anything());
        expect(mocks.queueAdd).toHaveBeenCalledWith('EXPORT_SERIES_JSON',
            { type: 'EXPORT_SERIES_JSON', seriesId: 's1' }, expect.objectContaining({ delay: 300000 }));
    });

    it('the candidates are Metron issues with a file, not yet detailed, not hand-edited', () => {
        expect(metronCreditCandidatesWhere('s1')).toEqual({
            seriesId: 's1',
            metadataSource: 'METRON',
            metadataId: { not: null },
            matchState: { not: 'DEEP_SYNCED' },
            hasCustomMetadata: false,
            AND: [{ filePath: { not: null } }, { filePath: { not: '' } }],
        });
    });
});
