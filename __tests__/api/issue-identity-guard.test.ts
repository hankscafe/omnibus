// Issue #194: a metadata-sync race can leave an Issue row holding ANOTHER issue's metadataId.
// The two paths that fetch provider data BY that stored id — view-time enrichment
// (GET /api/library/issue) and cover reset (DELETE /api/library/issue/cover-upload) — must prove
// the fetched payload's identity (parent volume/series + issue number) before writing. A
// mismatched payload previously overwrote the row (then DEEP_SYNCED locked it in) or "restored"
// the wrong cover.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { issueIdentityMismatch } from '@/lib/metadata/issue-identity';

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
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: async () => ({}) }));
vi.mock('@/lib/library-access', () => ({
    getAccessibleLibraryIds: async () => 'ALL',
    canAccessLibraryId: () => true,
}));
vi.mock('@/lib/metadata/metadata-cache', () => ({ cachedCvGet: mocks.cachedCvGet }));
vi.mock('@/lib/metadata/providers/metron', () => ({
    MetronProvider: class { getIssueDetails = mocks.metronGetIssueDetails; }
}));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: mocks.audit } }));
vi.mock('@/lib/queue', () => ({ omnibusQueue: { add: mocks.queueAdd } }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeDescription: (s: unknown) => s }));
vi.mock('@/lib/utils', () => ({
    parseComicVineCredits: () => ({
        writers: ['Writer One'], artists: [], coverArtists: [], colorists: [], letterers: [],
        characters: [], genres: [], storyArcs: [], teams: [], locations: []
    })
}));
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

import { GET } from '@/app/api/library/issue/route';
import { DELETE } from '@/app/api/library/issue/cover-upload/route';

// The anacronismo shape: a file-backed row numbered "1" in a CV-matched series (volume 130175).
const row = () => ({
    id: 'i1', number: '1', name: 'Issue 1', releaseDate: null, universe: null,
    description: 'db description', metadataId: '900', metadataSource: 'COMICVINE',
    matchState: 'MATCHED', hasCustomMetadata: false, hasCustomCover: false,
    writers: null, artists: null, coverArtists: null, colorists: null, letterers: null,
    characters: null, genres: null, storyArcs: null, teams: null, locations: null,
    series: { libraryId: 'lib1', metadataId: '130175', metadataSource: 'COMICVINE', name: 'Trauma Team' },
});

const cvDetail = (volumeId: number, issueNumber: string) => ({
    data: { results: {
        volume: { id: volumeId }, issue_number: issueNumber,
        description: 'provider description', deck: null,
        person_credits: [], character_credits: [], concepts: [],
        story_arc_credits: [], team_credits: [], location_credits: [],
        image: { medium_url: 'http://cv/img.jpg' },
    } }
});

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerSession.mockResolvedValue({ user: { id: 'admin1', role: 'ADMIN' } });
    mocks.settingFindUnique.mockImplementation(async ({ where }: any) =>
        where.key === 'cv_api_key' ? { value: 'k' } : null);
    mocks.issueFindUnique.mockResolvedValue(row());
    mocks.issueUpdate.mockResolvedValue({});
    mocks.audit.mockResolvedValue(undefined);
    mocks.fsExistsSync.mockReturnValue(false);
});

describe('issueIdentityMismatch (unit)', () => {
    const base = {
        rowNumber: '1', seriesMetadataId: '130175', seriesMetadataSource: 'COMICVINE',
        expectedSource: 'COMICVINE',
    };

    it('accepts a payload matching volume and number (padding-insensitive)', () => {
        expect(issueIdentityMismatch({ ...base, fetchedParentId: '130175', fetchedIssueNumber: '001' })).toBeNull();
    });

    it('rejects a payload from another volume', () => {
        expect(issueIdentityMismatch({ ...base, fetchedParentId: '131313', fetchedIssueNumber: '1' })).toMatch(/volume 131313/);
    });

    it('rejects a payload for another issue number', () => {
        expect(issueIdentityMismatch({ ...base, fetchedParentId: '130175', fetchedIssueNumber: '4' })).toMatch(/issue #4/);
    });

    it('only enforces dimensions both sides know', () => {
        // Provider payload carries no parent id → number alone decides.
        expect(issueIdentityMismatch({ ...base, fetchedParentId: null, fetchedIssueNumber: '1' })).toBeNull();
        // Series matched to a DIFFERENT provider → its id is not comparable; number alone decides.
        expect(issueIdentityMismatch({
            ...base, seriesMetadataSource: 'METRON', fetchedParentId: '999', fetchedIssueNumber: '1'
        })).toBeNull();
        // Number missing/blank on the payload → parent alone decides.
        expect(issueIdentityMismatch({ ...base, fetchedParentId: '130175', fetchedIssueNumber: '' })).toBeNull();
    });

    it('fails safe when the provider defaults an unknown number to "0"', () => {
        // Metron's mapper substitutes '0' — blocking the write (keep DB data) is the safe direction.
        expect(issueIdentityMismatch({ ...base, fetchedParentId: '130175', fetchedIssueNumber: '0' })).toMatch(/issue #0/);
    });
});

describe('GET /api/library/issue — view-time enrichment guard', () => {
    const req = () => new Request('http://localhost/api/library/issue?id=i1');

    it('discards a CV payload from the wrong volume: no write, no DEEP_SYNCED, DB data served', async () => {
        mocks.cachedCvGet.mockResolvedValue(cvDetail(131313, '1'));

        const res = await GET(req());
        const json = await res.json();

        expect(mocks.issueUpdate).not.toHaveBeenCalled();
        expect(json.description).toBe('db description');
        expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining('Skipping CV deep-fetch'), 'warn');
    });

    it('discards a CV payload for the wrong issue number', async () => {
        mocks.cachedCvGet.mockResolvedValue(cvDetail(130175, '4'));

        const res = await GET(req());
        const json = await res.json();

        expect(mocks.issueUpdate).not.toHaveBeenCalled();
        expect(json.description).toBe('db description');
    });

    it('writes and DEEP_SYNCs a payload that proves its identity (padded number)', async () => {
        mocks.cachedCvGet.mockResolvedValue(cvDetail(130175, '001'));

        const res = await GET(req());
        const json = await res.json();

        expect(mocks.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'i1' },
            data: expect.objectContaining({ matchState: 'DEEP_SYNCED', description: 'provider description' }),
        }));
        expect(json.description).toBe('provider description');
    });

    it('requests the identity fields from ComicVine', async () => {
        mocks.cachedCvGet.mockResolvedValue(cvDetail(130175, '1'));

        await GET(req());

        const fieldList = mocks.cachedCvGet.mock.calls[0][1].params.field_list;
        expect(fieldList).toContain('volume');
        expect(fieldList).toContain('issue_number');
    });

    it('discards a Metron payload from the wrong series', async () => {
        mocks.issueFindUnique.mockResolvedValue({
            ...row(), metadataSource: 'METRON',
            series: { libraryId: 'lib1', metadataId: '777', metadataSource: 'METRON', name: 'Trauma Team' },
        });
        mocks.metronGetIssueDetails.mockResolvedValue({
            sourceId: '900', seriesId: 555, issueNumber: '1', description: 'metron imposter', coverUrl: null,
            writers: [], artists: [], coverArtists: [], colorists: [], letterers: [],
            characters: [], teams: [], storyArcs: [], locations: [],
        });

        const res = await GET(req());
        const json = await res.json();

        expect(mocks.issueUpdate).not.toHaveBeenCalled();
        expect(json.description).toBe('db description');
        expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining('Skipping Metron deep-fetch'), 'warn');
    });
});

describe('DELETE /api/library/issue/cover-upload — cover-reset guard', () => {
    const req = () => new Request('http://localhost/api/library/issue/cover-upload', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueId: 'i1' }),
    });

    it('refuses to "restore" a cover resolved from the wrong volume (null → series fallback)', async () => {
        mocks.cachedCvGet.mockResolvedValue(cvDetail(131313, '1'));

        const res = await DELETE(req());
        const json = await res.json();

        expect(json.coverUrl).toBeNull();
        expect(mocks.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: { coverUrl: null, hasCustomCover: false },
        }));
        expect(mocks.audit).toHaveBeenCalledWith('RESET_ISSUE_COVER',
            expect.objectContaining({ restored: false }), 'admin1');
        expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining('Not restoring provider cover'), 'warn');
    });

    it('restores the provider cover when the payload proves its identity', async () => {
        mocks.cachedCvGet.mockResolvedValue(cvDetail(130175, '1'));

        const res = await DELETE(req());
        const json = await res.json();

        expect(json.coverUrl).toBe('http://cv/img.jpg');
        expect(mocks.issueUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: { coverUrl: 'http://cv/img.jpg', hasCustomCover: false },
        }));
        expect(mocks.audit).toHaveBeenCalledWith('RESET_ISSUE_COVER',
            expect.objectContaining({ restored: true }), 'admin1');
    });
});
