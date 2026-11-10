// GET /api/library/issue - the series page's issue details, whose description it renders as HTML
// (dangerouslySetInnerHTML). Descriptions are stored as the provider (ComicVine wiki HTML, Metron) or the
// file's ComicInfo Summary gave them, and sanitized when read. Until beta.034 only the reply built from
// the database was sanitized: the first view of a not-yet-deep-synced issue answers from the provider
// fetch, and those two replies sent the description raw - so a description (or a downloaded comic's
// Summary) carrying <img onerror=...> ran script on the series page. The real sanitizer runs here.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sanitizeDescription } from '@/lib/utils/sanitize';
import { auditLog } from '../helpers/setup-global';

const mocks = vi.hoisted(() => ({
    issueFindUnique: vi.fn(),
    issueUpdate: vi.fn(),
    settingFindUnique: vi.fn(),
    getServerSession: vi.fn(),
    cachedCvGet: vi.fn(),
    metronGetIssueDetails: vi.fn(),
    queueAdd: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        issue: { findUnique: mocks.issueFindUnique, update: mocks.issueUpdate },
        systemSetting: { findUnique: mocks.settingFindUnique },
    }
}));
vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/library-access', () => ({
    getAccessibleLibraryIds: async () => 'ALL',
    canAccessLibraryId: () => true,
}));
vi.mock('@/lib/metadata/metadata-cache', () => ({ cachedCvGet: mocks.cachedCvGet }));
vi.mock('@/lib/metadata/providers/metron', () => ({
    MetronProvider: class { getIssueDetails = mocks.metronGetIssueDetails; }
}));
vi.mock('@/lib/queue', () => ({ omnibusQueue: { add: mocks.queueAdd } }));
vi.mock('@/lib/utils', () => ({
    parseComicVineCredits: () => ({
        writers: ['Writer One'], artists: [], coverArtists: [], colorists: [], letterers: [],
        characters: [], genres: [], storyArcs: [], teams: [], locations: []
    })
}));

import { GET } from '@/app/api/library/issue/route';

const CV_BASE = 'https://comicvine.gamespot.com';
const METRON_BASE = 'https://metron.cloud';
// What a hostile wiki edit or a crafted ComicInfo <Summary> can hold: an event handler, a script, a
// javascript: link - next to the ordinary text and the provider-relative link a real description has.
const HOSTILE = '<p>Bruce returns to Gotham.</p>'
    + '<img src=x onerror="fetch(\'/api/admin/api-keys\')">'
    + '<script>alert(document.cookie)</script>'
    + '<a href="/wolverine/4005-1440/" onclick="steal()">Wolverine</a>'
    + '<a href="javascript:alert(1)">click</a>';

const cvRow = (over: Record<string, unknown> = {}) => ({
    id: 'i1', number: '1', name: 'Issue 1', releaseDate: null, universe: null,
    description: 'stored summary', metadataId: '900', metadataSource: 'COMICVINE',
    matchState: 'MATCHED', hasCustomMetadata: false,
    writers: null, artists: null, coverArtists: null, colorists: null, letterers: null,
    characters: null, genres: null, storyArcs: null, teams: null, locations: null,
    series: { libraryId: 'lib1', metadataId: '130175', metadataSource: 'COMICVINE' },
    attachedVolume: null,
    ...over,
});
const metronRow = (over: Record<string, unknown> = {}) => cvRow({
    metadataSource: 'METRON', series: { libraryId: 'lib1', metadataId: '777', metadataSource: 'METRON' }, ...over,
});

const cvDetail = (description: string | null, deck: string | null = null) => ({
    data: { results: {
        volume: { id: 130175 }, issue_number: '1', description, deck,
        person_credits: [], character_credits: [], concepts: [],
        story_arc_credits: [], team_credits: [], location_credits: [],
    } }
});
const metronDetail = (description: string | null) => ({
    sourceId: '900', seriesId: 777, issueNumber: '1', description, coverUrl: null,
    writers: [], artists: [], coverArtists: [], colorists: [], letterers: [],
    characters: [], teams: [], storyArcs: [], locations: [],
});

const settings = (extra: Record<string, string> = {}) => {
    const all: Record<string, string> = { cv_api_key: 'k', ...extra };
    mocks.settingFindUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
        where.key in all ? { value: all[where.key] } : null);
};

const load = async () => {
    const res = await GET(new Request('http://localhost/api/library/issue?id=i1'));
    return { status: res.status, body: await res.json() };
};

// Nothing that runs script survives; the text and the resolved provider link do.
const expectSafe = (description: string, base: string) => {
    expect(description).not.toMatch(/<img|<script|onerror|onclick|javascript:|alert\(/i);
    expect(description).toContain('<p>Bruce returns to Gotham.</p>');
    expect(description).toContain(`<a href="${base}/wolverine/4005-1440/" rel="noopener noreferrer" target="_blank">Wolverine</a>`);
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', role: 'USER' } });
    settings();
    mocks.issueUpdate.mockResolvedValue({});
    auditLog.mockResolvedValue(undefined);
});

describe('GET /api/library/issue - the description is sanitized on every reply', () => {
    it('ComicVine deep fetch: the provider description', async () => {
        mocks.issueFindUnique.mockResolvedValue(cvRow());
        mocks.cachedCvGet.mockResolvedValue(cvDetail(HOSTILE));

        const { status, body } = await load();

        expect(status).toBe(200);
        expect(mocks.issueUpdate).toHaveBeenCalled(); // the deep-fetch reply, not the DB one
        expectSafe(body.description, CV_BASE);
        expect(body.description).toBe(sanitizeDescription(HOSTILE, CV_BASE));
    });

    it("ComicVine deep fetch with no provider description: the stored (file) summary it falls back to", async () => {
        mocks.issueFindUnique.mockResolvedValue(cvRow({ description: HOSTILE }));
        mocks.cachedCvGet.mockResolvedValue(cvDetail(null, null));

        const { body } = await load();

        expect(mocks.issueUpdate).toHaveBeenCalled();
        expectSafe(body.description, CV_BASE);
    });

    it('ComicVine deep fetch with file metadata preferred: the stored summary that wins', async () => {
        settings({ file_metadata_priority: 'true' });
        mocks.issueFindUnique.mockResolvedValue(cvRow({ description: HOSTILE }));
        mocks.cachedCvGet.mockResolvedValue(cvDetail('<p>Provider text</p>'));

        const { body } = await load();

        expect(mocks.issueUpdate).toHaveBeenCalled();
        expectSafe(body.description, CV_BASE);
        expect(body.description).not.toContain('Provider text');
    });

    it('Metron deep fetch: the provider description, links resolved against Metron', async () => {
        mocks.issueFindUnique.mockResolvedValue(metronRow());
        mocks.metronGetIssueDetails.mockResolvedValue(metronDetail(HOSTILE));

        const { body } = await load();

        expect(mocks.issueUpdate).toHaveBeenCalled();
        expectSafe(body.description, METRON_BASE);
    });

    it('Metron deep fetch with no provider description: the stored summary', async () => {
        mocks.issueFindUnique.mockResolvedValue(metronRow({ description: HOSTILE }));
        mocks.metronGetIssueDetails.mockResolvedValue(metronDetail(null));

        const { body } = await load();

        expect(mocks.issueUpdate).toHaveBeenCalled();
        expectSafe(body.description, METRON_BASE);
    });

    it('stores the description as given - every read sanitizes it, so nothing is lost for later', async () => {
        mocks.issueFindUnique.mockResolvedValue(cvRow());
        mocks.cachedCvGet.mockResolvedValue(cvDetail(HOSTILE));

        await load();

        expect(mocks.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ description: HOSTILE, matchState: 'DEEP_SYNCED' }),
        }));
    });

    it('an issue already deep-synced answers from the database, sanitized as before', async () => {
        mocks.issueFindUnique.mockResolvedValue(cvRow({ description: HOSTILE, matchState: 'DEEP_SYNCED' }));

        const { body } = await load();

        expect(mocks.cachedCvGet).not.toHaveBeenCalled();
        expect(mocks.issueUpdate).not.toHaveBeenCalled();
        expectSafe(body.description, CV_BASE);
    });

    it('no description anywhere answers an empty one on the deep-fetch path, like the database path', async () => {
        mocks.issueFindUnique.mockResolvedValue(cvRow({ description: null }));
        mocks.cachedCvGet.mockResolvedValue(cvDetail(null, null));

        const { body } = await load();

        expect(mocks.issueUpdate).toHaveBeenCalled();
        expect(body.description).toBe('');
    });
});
