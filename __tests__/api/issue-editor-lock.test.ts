// Issue #194 (f): the per-issue metadata editor's PATCH used to stamp hasCustomMetadata +
// DEEP_SYNCED and queue a ComicInfo embed on EVERY save — including a zero-change (or fully
// blank) one. That is how a blank editor save permanently locked an already-blank row and
// overwrote the archive's original ComicInfo.xml with a minimal one. These tests pin the new
// contract: diff-only writes, no-op saves touch nothing, mass-blank saves are refused, the
// number anchor can't be blanked, and { clearCustomMetadata: true } removes the lock.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    issueFindUnique: vi.fn(),
    issueUpdate: vi.fn(),
    settingFindUnique: vi.fn(),
    getServerSession: vi.fn(),
    cachedCvGet: vi.fn(),
    metronGetIssueDetails: vi.fn(),
    log: vi.fn(),
    audit: vi.fn(),
    queueAdd: vi.fn(),
    fsExistsSync: vi.fn(),
    fsPromisesUnlink: vi.fn(),
    fsPromisesMkdir: vi.fn(),
    fsPromisesWriteFile: vi.fn(),
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
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeDescription: (s: unknown) => s, providerWikiBase: () => null }));
vi.mock('@/lib/utils/paths', () => ({ CONFIG_DIR: '/config' }));
vi.mock('fs', () => {
    const promises = {
        unlink: mocks.fsPromisesUnlink,
        mkdir: mocks.fsPromisesMkdir,
        writeFile: mocks.fsPromisesWriteFile,
    };
    return {
        existsSync: mocks.fsExistsSync,
        promises,
        default: { existsSync: mocks.fsExistsSync, promises },
    };
});

import { GET, PATCH } from '@/app/api/library/issue/route';
import { auditLog } from '../helpers/setup-global';

// A populated, unlocked row: three narrative fields hold data (name, description, writers).
const row = () => ({
    id: 'i1', number: '1', name: 'Issue 1', releaseDate: null, universe: null,
    description: 'db description', metadataId: '900', metadataSource: 'COMICVINE',
    matchState: 'DEEP_SYNCED', hasCustomMetadata: false, hasCustomCover: false,
    writers: '["Writer One"]', artists: null, coverArtists: null, colorists: null, letterers: null,
    characters: null, genres: null, storyArcs: null, teams: null, locations: null,
    series: { libraryId: 'lib1', metadataId: '130175', metadataSource: 'COMICVINE', name: 'Trauma Team' },
});

// The exact payload the editor posts back when the admin changes nothing: every field present,
// every value the round-trip of what GET returned.
const unchangedPayload = () => ({
    issueId: 'i1',
    number: '1', name: 'Issue 1', description: 'db description', releaseDate: '', universe: '',
    writers: ['Writer One'], artists: [], coverArtists: [], colorists: [], letterers: [],
    characters: [], genres: [], storyArcs: [], teams: [], locations: [],
    writeToFile: true,
});

const patchReq = (body: any) => new Request('http://localhost/api/library/issue', {
    method: 'PATCH', body: JSON.stringify(body),
});

beforeEach(() => {
    mocks.getServerSession.mockResolvedValue({ user: { id: 'admin1', role: 'ADMIN' } });
    mocks.settingFindUnique.mockResolvedValue(null);
    mocks.issueFindUnique.mockResolvedValue(row());
    mocks.issueUpdate.mockResolvedValue({});
});

describe('PATCH /api/library/issue — no-op saves touch nothing (issue #194 (f))', () => {
    it('a zero-change save writes nothing: no update, no lock, no embed', async () => {
        const res = await PATCH(patchReq(unchangedPayload()));
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.changed).toBe(false);
        expect(mocks.issueUpdate).not.toHaveBeenCalled();
        expect(mocks.queueAdd).not.toHaveBeenCalled();
        // The no-op is still audited (forensics), flagged as changed: false.
        expect(auditLog).toHaveBeenCalledWith('UPDATE_ISSUE_METADATA',
            expect.objectContaining({ changed: false, wroteToFile: false }), 'admin1');
    });

    it('a blank save over an already-blank row is a no-op, not a lock-in', async () => {
        const blankRow = { ...row(), name: null, description: null, writers: null };
        mocks.issueFindUnique.mockResolvedValue(blankRow);
        const res = await PATCH(patchReq({ ...unchangedPayload(), name: '', description: '', writers: [] }));
        const json = await res.json();

        expect(json.changed).toBe(false);
        expect(mocks.issueUpdate).not.toHaveBeenCalled();
        expect(mocks.queueAdd).not.toHaveBeenCalled();
    });
});

describe('PATCH /api/library/issue — dirty saves write only what changed', () => {
    it('writes the changed field + lock + DEEP_SYNCED, leaves untouched fields out, queues the embed', async () => {
        const res = await PATCH(patchReq({ ...unchangedPayload(), name: 'Renamed' }));
        const json = await res.json();

        expect(json.changed).toBe(true);
        expect(json.changedFields).toEqual(['name']);
        const data = mocks.issueUpdate.mock.calls[0][0].data;
        expect(data.name).toBe('Renamed');
        expect(data.hasCustomMetadata).toBe(true);
        expect(data.matchState).toBe('DEEP_SYNCED');
        expect('description' in data).toBe(false);
        expect('writers' in data).toBe(false);
        expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
        expect(auditLog).toHaveBeenCalledWith('UPDATE_ISSUE_METADATA',
            expect.objectContaining({ changedFields: ['name'] }), 'admin1');
    });

    it('respects writeToFile: false — change saved, no embed queued', async () => {
        const res = await PATCH(patchReq({ ...unchangedPayload(), name: 'Renamed', writeToFile: false }));
        const json = await res.json();

        expect(json.changed).toBe(true);
        expect(json.wroteToFile).toBe(false);
        expect(mocks.queueAdd).not.toHaveBeenCalled();
    });

    it('clearing a single field stays possible (description -> null)', async () => {
        const res = await PATCH(patchReq({ ...unchangedPayload(), description: '' }));
        const json = await res.json();

        expect(json.changed).toBe(true);
        const data = mocks.issueUpdate.mock.calls[0][0].data;
        expect(data.description).toBeNull();
        expect(data.hasCustomMetadata).toBe(true);
    });
});

describe('PATCH /api/library/issue — destructive-shape guards', () => {
    it('refuses to blank every populated field in one save (the unloaded-form shape)', async () => {
        const res = await PATCH(patchReq({ ...unchangedPayload(), name: '', description: '', writers: [] }));

        expect(res.status).toBe(400);
        expect(mocks.issueUpdate).not.toHaveBeenCalled();
        expect(mocks.queueAdd).not.toHaveBeenCalled();
    });

    it("refuses a blank issue number (identity anchor) with a clear 400, not an opaque 500", async () => {
        const res = await PATCH(patchReq({ ...unchangedPayload(), number: '' }));
        const json = await res.json();

        expect(res.status).toBe(400);
        expect(json.error).toMatch(/number/i);
        expect(mocks.issueUpdate).not.toHaveBeenCalled();
    });
});

describe('PATCH /api/library/issue — unlock (clearCustomMetadata)', () => {
    it('clears the lock, demotes DEEP_SYNCED to MATCHED, audits, and never embeds', async () => {
        mocks.issueFindUnique.mockResolvedValue({ ...row(), hasCustomMetadata: true });
        const res = await PATCH(patchReq({ issueId: 'i1', clearCustomMetadata: true }));
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.unlocked).toBe(true);
        expect(mocks.issueUpdate).toHaveBeenCalledWith({
            where: { id: 'i1' },
            data: { hasCustomMetadata: false, matchState: 'MATCHED' },
        });
        expect(mocks.queueAdd).not.toHaveBeenCalled();
        expect(auditLog).toHaveBeenCalledWith('RESTORE_ISSUE_DEFAULTS',
            expect.objectContaining({ issueId: 'i1', scope: 'single' }), 'admin1');
    });
});

describe('GET /api/library/issue — lock state exposure', () => {
    it('returns hasCustomMetadata so the editor can show the lock', async () => {
        mocks.issueFindUnique.mockResolvedValue({ ...row(), hasCustomMetadata: true });
        const res = await GET(new Request('http://localhost/api/library/issue?id=i1'));
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.hasCustomMetadata).toBe(true);
    });
});

describe('PATCH /api/library/issue - per-issue inker/editor/translator (#199 Call-3 Beta A)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({ user: { id: 'admin1', role: 'ADMIN' } });
        mocks.settingFindUnique.mockResolvedValue({ key: 'metadata_write_comicinfo', value: 'true' });
        mocks.issueFindUnique.mockResolvedValue({ ...row(), inker: null, editor: null, translator: null });
        mocks.issueUpdate.mockResolvedValue({});
    });

    it('accepts the three new credit arrays and stores them as JSON', async () => {
        const res = await PATCH(patchReq({
            issueId: 'i1',
            inker: ['Jonathan Glapion'],
            editor: ['Devin Lewis'],
            translator: ['Anna Rossi'],
        }));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.changedFields).toEqual(expect.arrayContaining(['inker', 'editor', 'translator']));
        expect(mocks.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                inker: '["Jonathan Glapion"]',
                editor: '["Devin Lewis"]',
                translator: '["Anna Rossi"]',
            }),
        }));
    });

    it('leaves the new fields untouched when absent from a partial payload (reader-tagging contract)', async () => {
        mocks.issueFindUnique.mockResolvedValue({ ...row(), inker: '["Kept Inker"]', editor: null, translator: null });
        const res = await PATCH(patchReq({ issueId: 'i1', characters: ['Dylan Dog'] }));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.changedFields).toEqual(['characters']);
        const written = mocks.issueUpdate.mock.calls[0][0].data;
        expect(written).not.toHaveProperty('inker');
        expect(written).not.toHaveProperty('editor');
        expect(written).not.toHaveProperty('translator');
    });
});

describe('PATCH /api/library/issue - per-issue ComicInfo remainder (#199 Call-3 Beta B)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({ user: { id: 'admin1', role: 'ADMIN' } });
        mocks.settingFindUnique.mockResolvedValue({ key: 'metadata_write_comicinfo', value: 'true' });
        mocks.issueFindUnique.mockResolvedValue({
            ...row(), tags: null, mainCharacterOrTeam: null, alternateSeries: null, alternateNumber: null,
            alternateCount: null, storyArcNumber: null, gtin: null, notes: null, scanInformation: null,
            review: null, blackAndWhite: null, communityRating: null,
        });
        mocks.issueUpdate.mockResolvedValue({});
    });

    it('accepts the tags array, the string scalars, and the typed trio with validation', async () => {
        const res = await PATCH(patchReq({
            issueId: 'i1',
            tags: ['noir', 'one-shot'],
            alternateSeries: 'Legends of the Dark Knight',
            alternateNumber: '19B',
            gtin: '9791234567897',
            communityRating: '9.9',   // clamped to 5
            alternateCount: '6',      // parsed to int
            blackAndWhite: false,     // an explicit per-issue "No" is a real stored claim
        }));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.changedFields).toEqual(expect.arrayContaining([
            'tags', 'alternateSeries', 'alternateNumber', 'gtin', 'communityRating', 'alternateCount', 'blackAndWhite',
        ]));
        expect(mocks.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                tags: '["noir","one-shot"]',
                alternateSeries: 'Legends of the Dark Knight',
                alternateNumber: '19B',
                gtin: '9791234567897',
                communityRating: 5,
                alternateCount: 6,
                blackAndWhite: false,
            }),
        }));
    });

    it('treats absent Beta B fields as untouched and clears with explicit null', async () => {
        mocks.issueFindUnique.mockResolvedValue({
            ...row(), tags: '["kept"]', gtin: '111', blackAndWhite: true, communityRating: 4,
            mainCharacterOrTeam: null, alternateSeries: null, alternateNumber: null,
            alternateCount: null, storyArcNumber: null, notes: null, scanInformation: null, review: null,
        });
        const res = await PATCH(patchReq({ issueId: 'i1', blackAndWhite: null, communityRating: '' }));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.changedFields).toEqual(expect.arrayContaining(['blackAndWhite', 'communityRating']));
        const written = mocks.issueUpdate.mock.calls[0][0].data;
        expect(written.blackAndWhite).toBeNull();
        expect(written.communityRating).toBeNull();
        expect(written).not.toHaveProperty('tags');
        expect(written).not.toHaveProperty('gtin');
    });
});
