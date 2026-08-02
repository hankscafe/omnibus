// __tests__/api/series-update-lock.test.ts
//
// Issue #194 (f), series side: the metadata editor always sends lockMetadata, and the update
// route used to stamp hasCustomMetadata AND queue a WHOLE-SERIES ComicInfo embed on every save —
// including a zero-change one. These tests pin the new contract: a no-op save writes nothing
// (no lock, no embed, changed:false), the lock engages only when a narrative field genuinely
// changed, identity-only edits never lock, and { clearCustomMetadata: true } removes the lock.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    seriesFindFirst: vi.fn(),
    seriesUpdate: vi.fn(),
    seriesUpsert: vi.fn(),
    libraryFindMany: vi.fn(),
    settingFindMany: vi.fn(),
    settingFindUnique: vi.fn(),
    issueFindMany: vi.fn(),
    transaction: vi.fn(),
    queueAdd: vi.fn(),
    getServerSession: vi.fn(),
    audit: vi.fn(),
    log: vi.fn(),
    fsExistsSync: vi.fn(),
    safeRelocateFolder: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findFirst: mocks.seriesFindFirst, update: mocks.seriesUpdate, upsert: mocks.seriesUpsert },
        library: { findMany: mocks.libraryFindMany },
        systemSetting: { findMany: mocks.settingFindMany, findUnique: mocks.settingFindUnique },
        issue: { findMany: mocks.issueFindMany },
        $transaction: mocks.transaction,
    }
}));
vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: async () => ({}) }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: mocks.audit } }));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('@/lib/queue', () => ({ omnibusQueue: { add: mocks.queueAdd } }));
vi.mock('@/lib/utils/safe-fs', () => ({ safeRelocateFolder: mocks.safeRelocateFolder }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('fs-extra', () => ({
    existsSync: mocks.fsExistsSync,
    default: { existsSync: mocks.fsExistsSync },
}));

import { POST } from '@/app/api/library/update/route';
import { COMIC_INFO_DEFAULT_KEYS } from '@/lib/utils/comicinfo-fields';

const PATH = '/lib/DC/Batman (2020)';

// A series whose stored state exactly matches what the editor round-trips for a no-op save.
const record = () => ({
    id: 'S1', name: 'Batman', year: 2020, publisher: 'DC', folderPath: PATH,
    monitored: true, isManga: false, metadataId: '111', cvId: 111, metronId: null,
    metadataSource: 'COMICVINE', libraryId: 'L1', status: 'Ongoing', bookType: null,
    seriesGroup: null, description: 'stored description', universe: null, hasCustomMetadata: false,
});

// The editor's series payload: identity echoed verbatim + the narrative trio + the always-on lock.
const editorBody = (overrides: Record<string, any> = {}) => ({
    currentPath: PATH, name: 'Batman', year: 2020, publisher: 'DC',
    status: 'Ongoing', bookType: null, monitored: true, isManga: false,
    description: 'stored description', universe: '', seriesGroup: '',
    lockMetadata: true, writeToFile: true,
    ...overrides,
});

const req = (body: any) => new Request('http://localhost/api/library/update', {
    method: 'POST', body: JSON.stringify(body),
});

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerSession.mockResolvedValue({ user: { id: 'admin1', role: 'ADMIN' } });
    mocks.libraryFindMany.mockResolvedValue([{ id: 'L1', path: '/lib', isDefault: true, isManga: false }]);
    mocks.settingFindMany.mockResolvedValue([]); // default folder pattern
    mocks.settingFindUnique.mockResolvedValue(null);
    mocks.seriesFindFirst.mockResolvedValue(record());
    mocks.seriesUpdate.mockResolvedValue({});
    mocks.issueFindMany.mockResolvedValue([]);
    mocks.fsExistsSync.mockReturnValue(true);
    mocks.safeRelocateFolder.mockResolvedValue({ conflicts: 0 });
    mocks.transaction.mockResolvedValue([]);
});

describe('POST /api/library/update — no-op saves are inert (issue #194 (f), series)', () => {
    it('a zero-change editor save writes nothing: no update, no lock, no whole-series embed', async () => {
        const res = await POST(req(editorBody()));
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.changed).toBe(false);
        expect(mocks.seriesUpdate).not.toHaveBeenCalled();
        expect(mocks.queueAdd).not.toHaveBeenCalled();
        expect(mocks.audit).toHaveBeenCalledWith('UPDATE_SERIES_METADATA',
            expect.objectContaining({ changed: false }), 'admin1');
    });

    it('a narrative change with lockMetadata engages the lock and queues the embed', async () => {
        const res = await POST(req(editorBody({ description: 'my curated synopsis' })));
        const json = await res.json();

        expect(json.changed).toBe(true);
        const data = mocks.seriesUpdate.mock.calls[0][0].data;
        expect(data.description).toBe('my curated synopsis');
        expect(data.hasCustomMetadata).toBe(true);
        expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
    });

    it('#199: a ComicInfo-default change engages the lock and persists converted values', async () => {
        const res = await POST(req(editorBody({
            writer: 'A. Writer, B. Writer', imprint: 'Vertigo', blackAndWhite: true, communityRating: '7',
        })));
        const json = await res.json();

        expect(json.changed).toBe(true);
        const data = mocks.seriesUpdate.mock.calls[0][0].data;
        expect(data.writers).toBe(JSON.stringify(['A. Writer', 'B. Writer']));
        expect(data.imprint).toBe('Vertigo');
        expect(data.blackAndWhite).toBe(true);
        expect(data.communityRating).toBe(5); // clamped
        expect(data.hasCustomMetadata).toBe(true);
        expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
    });

    it('#199: the editor sending every field EMPTY over an unset record is still a no-op', async () => {
        // The series editor sends all ~28 keys unconditionally ("" = clear) plus blackAndWhite:false.
        // Over a record that never had them set, that must not count as a change — or every plain
        // description-only save would lock the series and rewrite every archive.
        const empties = Object.fromEntries(COMIC_INFO_DEFAULT_KEYS.map(k => [k, '']));
        const res = await POST(req(editorBody({ ...empties, blackAndWhite: false })));
        const json = await res.json();

        expect(json.changed).toBe(false);
        expect(mocks.seriesUpdate).not.toHaveBeenCalled();
        expect(mocks.queueAdd).not.toHaveBeenCalled();
    });

    it('#199: clearing a stored ComicInfo default counts as a change and stores null', async () => {
        mocks.seriesFindFirst.mockResolvedValue({ ...record(), imprint: 'Vertigo' });
        const res = await POST(req(editorBody({ imprint: '' })));
        const json = await res.json();

        expect(json.changed).toBe(true);
        expect(mocks.seriesUpdate.mock.calls[0][0].data.imprint).toBeNull();
    });

    it('an identity-only change never locks (year corrected, narrative untouched)', async () => {
        const res = await POST(req(editorBody({ year: 2021 })));
        const json = await res.json();

        expect(json.changed).toBe(true);
        const data = mocks.seriesUpdate.mock.calls[0][0].data;
        expect(data.year).toBe(2021);
        expect('hasCustomMetadata' in data).toBe(false);
    });

    it('a narrative change WITHOUT lockMetadata (other callers) never locks', async () => {
        const res = await POST(req(editorBody({ description: 'changed', lockMetadata: undefined })));
        expect((await res.json()).changed).toBe(true);
        const data = mocks.seriesUpdate.mock.calls[0][0].data;
        expect('hasCustomMetadata' in data).toBe(false);
    });

    it('clearCustomMetadata unlocks the series, audits, and touches nothing else', async () => {
        mocks.seriesFindFirst.mockResolvedValue({ ...record(), hasCustomMetadata: true });
        const res = await POST(req({ currentPath: PATH, clearCustomMetadata: true }));
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.unlocked).toBe(true);
        expect(mocks.seriesUpdate).toHaveBeenCalledWith({
            where: { id: 'S1' },
            data: { hasCustomMetadata: false },
        });
        expect(mocks.queueAdd).not.toHaveBeenCalled();
        expect(mocks.audit).toHaveBeenCalledWith('RESTORE_SERIES_DEFAULTS',
            expect.objectContaining({ seriesName: 'Batman' }), 'admin1');
    });

    it('is admin-only', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'u', role: 'USER' } });
        const res = await POST(req(editorBody()));
        expect(res.status).toBe(403);
    });
});
