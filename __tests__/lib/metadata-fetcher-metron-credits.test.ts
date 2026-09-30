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
    getIssueDetails: vi.fn(),
    queueAdd: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findFirst: mocks.seriesFindFirst, update: mocks.seriesUpdate },
        issue: { findMany: mocks.issueFindMany, update: mocks.issueUpdate, findFirst: vi.fn(), create: vi.fn() },
        systemSetting: { findUnique: vi.fn(async ({ where }: any) => (mocks.settings.has(where.key) ? { key: where.key, value: mocks.settings.get(where.key) } : null)) },
    },
}));
vi.mock('@/lib/metadata/providers/metron', () => ({
    MetronProvider: class {
        getSeriesDetails = async () => ({ name: 'Saga', publisher: 'Image', year: 2012, status: 'Ongoing', coverUrl: null, description: null });
        getSeriesIssues = async () => [];
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
