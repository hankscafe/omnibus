// GET /api/library/issue - a matched issue's first view deep-fetches its provider, stores what came back and
// answers from it. The ComicVine reply carried every field the issue editor and the reader's tagging load;
// the Metron reply left out Inker, Editor, Translator, Tags and the rest of the per-issue ComicInfo fields
// (notes, GTIN, rating, B&W, ...). Both clients send what they loaded back through PATCH, so a save right
// after a Metron first view cleared those stored values: the editor's blank form fields went back as
// "cleared", and the reader merged a new name into an empty list instead of the stored one. The Metron
// fetch also dropped the Inker/Editor/Translator credits Metron itself returns, so they were never stored.
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
vi.mock('@/lib/comicinfo-writes', () => ({ resolveWriteToFile: async () => false }));
// The description round-trips through the editor as the reply sent it; sanitizing is its own test file.
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeDescription: (s: string | null) => s ?? '', providerWikiBase: () => null }));
vi.mock('@/lib/utils', () => ({
    parseComicVineCredits: () => ({
        writers: [], artists: [], coverArtists: [], colorists: [], letterers: [],
        inkers: [], editors: [], translators: [],
        characters: [], genres: [], storyArcs: [], teams: [], locations: []
    })
}));

import { GET, PATCH } from '@/app/api/library/issue/route';

// A file-backed issue whose ComicInfo (or an earlier edit) gave it the fields Metron doesn't supply.
const storedRow = (over: Record<string, unknown> = {}) => ({
    id: 'i1', number: '1', name: 'The Long Halloween', releaseDate: null, universe: null,
    description: 'stored summary', metadataId: '900', metadataSource: 'METRON',
    matchState: 'MATCHED', hasCustomMetadata: false,
    writers: '["Jeph Loeb"]', artists: '["Tim Sale"]', coverArtists: null, colorists: null, letterers: null,
    inker: '["Inker A"]', editor: '["Editor B"]', translator: '["Translator C"]',
    characters: null, genres: '["Crime"]', storyArcs: '["Halloween"]', teams: null, locations: '["Gotham"]',
    tags: '["noir"]', mainCharacterOrTeam: 'Batman', alternateSeries: null, alternateNumber: null, alternateCount: null,
    storyArcNumber: '1', gtin: '9781563894695', notes: 'from the file', scanInformation: null, review: null,
    blackAndWhite: false, communityRating: 4.5, coversIssues: null, attachedVolumeId: null,
    series: { libraryId: 'lib1', metadataId: '777', metadataSource: 'METRON', name: 'Batman: The Long Halloween' },
    attachedVolume: null,
    ...over,
});
const emptyRow = () => storedRow({
    writers: null, artists: null, inker: null, editor: null, translator: null, genres: null, storyArcs: null,
    locations: null, tags: null, mainCharacterOrTeam: null, storyArcNumber: null, gtin: null, notes: null,
    blackAndWhite: null, communityRating: null,
});

const metronDetail = (over: Record<string, unknown> = {}) => ({
    sourceId: '900', seriesId: 777, issueNumber: '1', description: null, coverUrl: null,
    writers: [], artists: [], coverArtists: [], colorists: [], letterers: [],
    inker: [], editor: [], translator: [],
    characters: [], teams: [], storyArcs: [], locations: [],
    ...over,
});

const getReq = () => new Request('http://localhost/api/library/issue?id=i1');
const patchReq = (body: Record<string, unknown>) => new Request('http://localhost/api/library/issue', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const settings = (over: Record<string, string> = {}) => mocks.settingFindUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    where.key in over ? { value: over[where.key] } : where.key === 'cv_api_key' ? { value: 'k' } : null);
/** The data the deep fetch wrote to the row. */
const written = () => mocks.issueUpdate.mock.calls[0][0].data as Record<string, unknown>;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerSession.mockResolvedValue({ user: { id: 'admin1', role: 'ADMIN' } });
    settings();
    mocks.issueFindUnique.mockResolvedValue(storedRow());
    mocks.issueUpdate.mockResolvedValue({});
    mocks.metronGetIssueDetails.mockResolvedValue(metronDetail());
    auditLog.mockResolvedValue(undefined);
});

describe('GET /api/library/issue - the Metron first view', () => {
    it('answers with the same fields as the ComicVine first view and the stored reply', async () => {
        const metronKeys = Object.keys(await (await GET(getReq())).json()).sort();
        expect(mocks.metronGetIssueDetails).toHaveBeenCalled();

        mocks.issueFindUnique.mockResolvedValue(storedRow({ metadataSource: 'COMICVINE', series: { libraryId: 'lib1', metadataId: '130175', metadataSource: 'COMICVINE' } }));
        mocks.cachedCvGet.mockResolvedValue({ data: { results: {
            volume: { id: 130175 }, issue_number: '1', description: null, deck: null,
            person_credits: [], character_credits: [], concepts: [], story_arc_credits: [], team_credits: [], location_credits: [],
        } } });
        const cvKeys = Object.keys(await (await GET(getReq())).json()).sort();
        expect(mocks.cachedCvGet).toHaveBeenCalled();

        mocks.issueFindUnique.mockResolvedValue(storedRow({ matchState: 'DEEP_SYNCED' }));
        const storedKeys = Object.keys(await (await GET(getReq())).json()).sort();

        expect(metronKeys).toEqual(storedKeys);
        expect(cvKeys).toEqual(storedKeys);
    });

    it("keeps the stored Inker, Editor, Translator, Tags and ComicInfo fields when Metron has none", async () => {
        const json = await (await GET(getReq())).json();

        expect(json.inker).toEqual(['Inker A']);
        expect(json.editor).toEqual(['Editor B']);
        expect(json.translator).toEqual(['Translator C']);
        expect(json.tags).toEqual(['noir']);
        expect(json).toMatchObject({
            mainCharacterOrTeam: 'Batman', storyArcNumber: '1', gtin: '9781563894695', notes: 'from the file',
            blackAndWhite: false, communityRating: 4.5, hasCustomMetadata: false,
        });
        // Nothing stored is replaced by Metron's empty lists.
        expect(written()).toMatchObject({ inker: '["Inker A"]', editor: '["Editor B"]', translator: '["Translator C"]', matchState: 'DEEP_SYNCED' });
    });

    it("stores and answers Metron's own Inker, Editor and Translator credits", async () => {
        mocks.issueFindUnique.mockResolvedValue(emptyRow());
        mocks.metronGetIssueDetails.mockResolvedValue(metronDetail({
            inker: ['Klaus Janson'], editor: ['Mark Doyle'], translator: ['Ana Silva'],
        }));

        const json = await (await GET(getReq())).json();

        expect(written()).toMatchObject({ inker: '["Klaus Janson"]', editor: '["Mark Doyle"]', translator: '["Ana Silva"]' });
        expect(json).toMatchObject({ inker: ['Klaus Janson'], editor: ['Mark Doyle'], translator: ['Ana Silva'] });
    });

    it('fills only the blank credits when file metadata has priority', async () => {
        settings({ file_metadata_priority: 'true' });
        mocks.issueFindUnique.mockResolvedValue(storedRow({ editor: null }));
        mocks.metronGetIssueDetails.mockResolvedValue(metronDetail({ inker: ['Metron Inker'], editor: ['Metron Editor'] }));

        const json = await (await GET(getReq())).json();

        expect(json.inker).toEqual(['Inker A']);
        expect(json.editor).toEqual(['Metron Editor']);
        expect(written()).toMatchObject({ inker: '["Inker A"]', editor: '["Metron Editor"]' });
    });
});

describe('a save right after a Metron first view', () => {
    // The row as the deep fetch left it, for the PATCH that follows.
    const afterFetch = () => mocks.issueFindUnique.mockResolvedValue({ ...storedRow(), ...written() });

    it("from the issue editor changes nothing when nothing was edited", async () => {
        const reply = await (await GET(getReq())).json();
        afterFetch();

        // The editor's form round trip (metadata-editor-modal.tsx): every list field, every scalar.
        const payload: Record<string, unknown> = {
            issueId: 'i1', number: reply.number ?? '', name: reply.name ?? '', description: reply.description || '',
            releaseDate: reply.releaseDate ?? '', universe: reply.universe ?? '', writeToFile: false,
        };
        for (const f of ['writers', 'artists', 'coverArtists', 'colorists', 'letterers', 'inker', 'editor', 'translator',
            'characters', 'teams', 'locations', 'genres', 'storyArcs', 'tags']) {
            payload[f] = Array.isArray(reply[f]) ? reply[f] : [];
        }
        for (const f of ['mainCharacterOrTeam', 'alternateSeries', 'alternateNumber', 'storyArcNumber', 'gtin', 'notes', 'scanInformation', 'review']) {
            payload[f] = reply[f] ?? '';
        }
        payload.communityRating = reply.communityRating != null ? String(reply.communityRating) : '';
        payload.alternateCount = reply.alternateCount != null ? String(reply.alternateCount) : '';
        payload.blackAndWhite = reply.blackAndWhite ?? null;
        mocks.issueUpdate.mockClear();

        const result = await (await PATCH(patchReq(payload))).json();

        expect(result).toMatchObject({ success: true, changed: false });
        expect(mocks.issueUpdate).not.toHaveBeenCalled();
    });

    it("from the reader's tagging adds to the stored Inker instead of replacing it", async () => {
        const reply = await (await GET(getReq())).json();
        afterFetch();
        mocks.issueUpdate.mockClear();

        // The reader (reader/page.tsx): the new name merged into the category's current list.
        const result = await (await PATCH(patchReq({ issueId: 'i1', inker: [...(Array.isArray(reply.inker) ? reply.inker : []), 'New Inker'] }))).json();

        expect(result).toMatchObject({ success: true, changed: true, changedFields: ['inker'] });
        expect(mocks.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ inker: '["Inker A","New Inker"]' }),
        }));
    });
});
