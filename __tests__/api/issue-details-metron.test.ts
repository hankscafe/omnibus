// __tests__/api/issue-details-metron.test.ts
//
// #199 round 2 (found by CapitanoNemo78): the METRON volume branch of /api/issue-details read
// `details.issues` — a field getSeriesDetails never returns — so every volume-level issue lookup
// (most visibly the Smart Matcher's Issue Mapping cross-reference) got ZERO candidates on Metron.
// The route must fetch the real per-issue list via getSeriesIssues and map it to the SAME
// {id, issue_number, name} stub shape the ComicVine volume branch returns.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '../../src/app/api/issue-details/route';

const mocks = vi.hoisted(() => ({
    getToken: vi.fn(),
    settingFindUnique: vi.fn(),
    settingUpsert: vi.fn(),
    getSeriesDetails: vi.fn(),
    getSeriesIssues: vi.fn(),
    getIssueDetails: vi.fn(),
    cachedCvGet: vi.fn(),
    log: vi.fn(),
}));

vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }));
vi.mock('../../src/lib/db', () => ({
    prisma: { systemSetting: { findUnique: mocks.settingFindUnique, upsert: mocks.settingUpsert } },
}));
vi.mock('../../src/lib/metadata/providers/metron', () => ({
    MetronProvider: class {
        getSeriesDetails = mocks.getSeriesDetails;
        getSeriesIssues = mocks.getSeriesIssues;
        getIssueDetails = mocks.getIssueDetails;
    },
}));
vi.mock('../../src/lib/metadata/metadata-cache', () => ({ cachedCvGet: mocks.cachedCvGet }));
vi.mock('../../src/lib/utils', () => ({ parseComicVineCredits: vi.fn() }));
vi.mock('../../src/lib/utils/sanitize', () => ({
    sanitizeDescription: (html: string | null | undefined) => html || '',
    providerWikiBase: () => 'https://example.test/',
}));
vi.mock('../../src/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('../../src/lib/utils/system-flags', () => ({ logApiUsage: vi.fn() }));
vi.mock('../../src/lib/api-client', () => ({ apiClient: { get: vi.fn() } }));

const volumeRequest = (id = '123') =>
    new Request(`http://localhost/api/issue-details?id=${id}&type=volume&provider=METRON`);

const seriesDetails = {
    sourceId: '123', name: 'Dragonero', publisher: 'Sergio Bonelli Editore',
    year: 2013, description: 'Fantasy western.', coverUrl: 'http://img/c.jpg', issueCount: 78,
};

const metadataIssue = (sourceId: string, issueNumber: string, name: string) => ({
    sourceId, issueNumber, name, releaseDate: null, coverUrl: null, description: null,
    writers: [], artists: [], characters: [],
});

describe('GET /api/issue-details (METRON volume branch)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getToken.mockResolvedValue({ sub: 'admin' });
        mocks.settingFindUnique.mockResolvedValue(null); // cache miss
        mocks.settingUpsert.mockResolvedValue({});
        mocks.getSeriesDetails.mockResolvedValue(seriesDetails);
        mocks.getSeriesIssues.mockResolvedValue([
            metadataIssue('900', '154', 'Dragonero #154: La Signora Dei Lupi'),
            metadataIssue('901', '155', 'Dragonero #155'),
        ]);
    });

    it('returns the real per-issue list mapped to the ComicVine stub shape', async () => {
        const res = await GET(volumeRequest());
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(mocks.getSeriesIssues).toHaveBeenCalledWith('123');
        expect(data.issues).toEqual([
            { id: '900', issue_number: '154', name: 'Dragonero #154: La Signora Dei Lupi' },
            { id: '901', issue_number: '155', name: 'Dragonero #155' },
        ]);
        expect(data.count).toBe(78);
    });

    it('falls back to the fetched list length when the series carries no issue count', async () => {
        mocks.getSeriesDetails.mockResolvedValue({ ...seriesDetails, issueCount: 0 });
        const data = await (await GET(volumeRequest())).json();
        expect(data.count).toBe(2);
    });

    it('degrades to an empty issue list when getSeriesIssues fails (never kills the detail view)', async () => {
        mocks.getSeriesIssues.mockRejectedValue(new Error('metron 429'));
        const res = await GET(volumeRequest());
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.issues).toEqual([]);
        expect(data.name).toBe('Dragonero');
    });

    it('uses the v13 cache key so pre-fix empty-issues payloads cannot serve stale', async () => {
        await GET(volumeRequest());
        expect(mocks.settingFindUnique).toHaveBeenCalledWith({ where: { key: 'meta_details_v13_volume_METRON_123' } });
        expect(mocks.settingUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { key: 'meta_details_v13_volume_METRON_123' },
        }));
    });

    it('does not fetch the issue list for type=issue lookups', async () => {
        mocks.getIssueDetails.mockResolvedValue({
            sourceId: '900', name: 'La Signora Dei Lupi', seriesName: 'Dragonero', seriesId: 123,
            issueNumber: '154', publisher: 'SBE', releaseDate: '2026-03-01', coverUrl: null, description: 'd',
            writers: [], artists: [], characters: [],
        });
        const res = await GET(new Request('http://localhost/api/issue-details?id=900&type=issue&provider=METRON'));
        expect(res.status).toBe(200);
        expect(mocks.getSeriesIssues).not.toHaveBeenCalled();
    });
});
