import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/reading-lists/import-cbl/route';

const mocks = vi.hoisted(() => ({
    seriesFindMany: vi.fn(),
    issueFindMany: vi.fn(),
    readingListCreate: vi.fn().mockResolvedValue({ id: 'list_cbl' }),
    readingListItemCreateMany: vi.fn(),
    log: vi.fn()
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findMany: mocks.seriesFindMany },
        issue: { findMany: mocks.issueFindMany },
        readingList: { create: mocks.readingListCreate },
        readingListItem: { createMany: mocks.readingListItemCreateMany }
    }
}));

vi.mock('next-auth/next', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { id: 'user_1', role: 'ADMIN' } })
}));

const cblRequest = (xml: string, name = 'Imported List') => ({
    // Mock the request to bypass Vitest FormData hangs
    formData: async () => ({
        get: (key: string) => {
            if (key === 'file') return { text: async () => xml };
            if (key === 'name') return name;
            if (key === 'isGlobal') return 'false';
            return null;
        }
    })
}) as any;

const savedItems = () => mocks.readingListItemCreateMany.mock.calls.at(-1)?.[0].data;

describe('API Route: CBL Import', () => {

    it('should parse XML and map ComicRack items to local issues', async () => {
        const mockXml = `<?xml version="1.0"?>
        <ReadingList>
            <Name>X-Men Event</Name>
            <Books>
                <Book Series="X-Men" Number="1" />
                <Book Series="Wolverine" Number="5" />
            </Books>
        </ReadingList>`;

        // Mock DB
        mocks.seriesFindMany.mockResolvedValue([
            { id: 's_xmen', name: 'X-Men' }
        ]);
        mocks.issueFindMany.mockResolvedValue([
            { id: 'iss_1', seriesId: 's_xmen', number: '1' }
        ]);

        const res = await POST(cblRequest(mockXml, 'X-Men Event'));
        const data = await res.json();

        expect(data.success).toBe(true);
        expect(mocks.readingListCreate).toHaveBeenCalled();

        // Assert it mapped X-Men #1 to iss_1, and left Wolverine #5 as null (missing)
        expect(mocks.readingListItemCreateMany).toHaveBeenCalledWith({
            data: [
                { listId: 'list_cbl', issueId: 'iss_1', title: 'X-Men #1', order: 0 },
                { listId: 'list_cbl', issueId: null, title: 'Wolverine #5', order: 1 }
            ]
        });
    });
});

// DieselTech's CBLs (and cbl-tools' format) give every book its volume's start year and the provider's
// ids: <Book Series="Batman" Number="651" Volume="1940" Year="2006"><Database Name="cv" Series="796"
// Issue="121997" /></Book>. The import links by those ids first, keeps the issue id on every entry so
// opening the list links it once the issue arrives (and Request finds the right volume), and only
// falls back to the name when no id answers.
describe('API Route: CBL Import - provider ids and start years (#252 follow-up)', () => {
    type S = { id: string; name: string; year: number; metadataSource: string; metadataId: string | null; coverUrl?: string | null; folderPath?: string };
    type I = { id: string; seriesId: string; number: string; metadataSource: string; metadataId: string | null; isAnnual?: boolean; attachedVolumeId?: string | null };
    let series: S[];
    let issues: I[];

    type ProviderClause = { metadataSource: string; metadataId: { in: (string | null)[] } };
    type Where = { OR?: ProviderClause[]; seriesId?: { in: string[] }; isAnnual?: boolean; attachedVolumeId?: null };
    const matchesProviderIds = (row: { metadataSource: string; metadataId: string | null }, or?: ProviderClause[]) =>
        !!or?.some(c => c.metadataSource === row.metadataSource && c.metadataId.in.includes(row.metadataId));

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readingListCreate.mockResolvedValue({ id: 'list_cbl' });
        series = [];
        issues = [];
        // Where-aware stand-ins: the route's queries are answered the way the database would.
        mocks.seriesFindMany.mockImplementation(async (args: { where?: Where } = {}) => {
            const where = args.where;
            return where?.OR ? series.filter(s => matchesProviderIds(s, where.OR)) : series;
        });
        mocks.issueFindMany.mockImplementation(async (args: { where?: Where } = {}) => {
            const where: Where = args.where ?? {};
            return issues.filter(i => {
                if (where.OR && !matchesProviderIds(i, where.OR)) return false;
                if (where.seriesId?.in && !where.seriesId.in.includes(i.seriesId)) return false;
                if (where.isAnnual === false && i.isAnnual) return false;
                if ('attachedVolumeId' in where && where.attachedVolumeId === null && i.attachedVolumeId) return false;
                return true;
            });
        });
    });

    const book = (s: string, n: string, volume: string | null, db: string) =>
        `<Book Series="${s}" Number="${n}"${volume ? ` Volume="${volume}"` : ''} Year="2006">${db}</Book>`;
    const cv = (vol: string, iss: string) => `<Database Name="cv" Series="${vol}" Issue="${iss}" />`;
    const cbl = (...books: string[]) => `<?xml version="1.0" encoding="utf-8"?><ReadingList><Name>Event</Name><Books>${books.join('')}</Books></ReadingList>`;

    it("links by the ComicVine issue id even when the library's series name differs, and keeps the id", async () => {
        series = [{ id: 's_thor', name: 'Thor', year: 1966, metadataSource: 'COMICVINE', metadataId: '61213' }];
        issues = [{ id: 'i_416', seriesId: 's_thor', number: '416', metadataSource: 'COMICVINE', metadataId: '32646' }];

        await POST(cblRequest(cbl(book('The Mighty Thor', '416', '1989', cv('61213', '32646')))));

        expect(savedItems()).toEqual([
            { listId: 'list_cbl', issueId: 'i_416', title: 'The Mighty Thor #416', order: 0, cvIssueId: 32646, metadataSource: 'COMICVINE' },
        ]);
    });

    it("keeps the issue id on an entry that isn't in the library yet, so it links once it arrives", async () => {
        await POST(cblRequest(cbl(book('Batman', '651', '1940', cv('796', '121997')))));

        expect(savedItems()).toEqual([
            { listId: 'list_cbl', issueId: null, title: 'Batman #651', order: 0, cvIssueId: 121997, metadataSource: 'COMICVINE' },
        ]);
    });

    it("links an annual kept in its parent series by its issue id, where no name or number could reach it", async () => {
        // "Batman Annual" isn't a series of its own here: its #1 is an attached annual row inside Batman.
        series = [{ id: 's_bat', name: 'Batman', year: 1940, metadataSource: 'COMICVINE', metadataId: '796' }];
        issues = [{ id: 'i_ann1', seriesId: 's_bat', number: '1', metadataSource: 'COMICVINE', metadataId: '5000', isAnnual: true, attachedVolumeId: 'att_ann' }];

        await POST(cblRequest(cbl(book('Batman Annual', '1', '1961', cv('2843', '5000')))));

        expect(savedItems()[0]).toMatchObject({ issueId: 'i_ann1', cvIssueId: 5000 });
    });

    it('finds the series by its ComicVine volume id, then the issue by number', async () => {
        // The issue row has no provider id yet (a file not matched issue-by-issue), but its series is volume
        // 796 - under a name the CBL's "Batman" can't reach by name.
        series = [{ id: 's_bat', name: 'The Batman', year: 1940, metadataSource: 'COMICVINE', metadataId: '796' }];
        issues = [{ id: 'i_651', seriesId: 's_bat', number: '651', metadataSource: 'COMICVINE', metadataId: null }];

        await POST(cblRequest(cbl(book('Batman', '651', '1940', cv('796', '121997')))));

        expect(savedItems()[0]).toMatchObject({ issueId: 'i_651', cvIssueId: 121997 });
    });

    it("picks the same-named series whose start year matches the book's volume", async () => {
        // Neither series carries a ComicVine id (Metron-matched), so only the name and year can decide.
        series = [
            { id: 's_2016', name: 'Batman', year: 2016, metadataSource: 'METRON', metadataId: '1001' },
            { id: 's_1940', name: 'Batman', year: 1940, metadataSource: 'METRON', metadataId: '1002' },
        ];
        issues = [
            { id: 'i_2016_1', seriesId: 's_2016', number: '1', metadataSource: 'METRON', metadataId: '9001' },
            { id: 'i_1940_1', seriesId: 's_1940', number: '1', metadataSource: 'METRON', metadataId: '9002' },
        ];

        await POST(cblRequest(cbl(book('Batman', '1', '1940', cv('796', '105264')))));

        expect(savedItems()[0]).toMatchObject({ issueId: 'i_1940_1' });
    });

    it("accepts a start year one off, the way ComicVine and folder years often disagree", async () => {
        series = [
            { id: 's_2016', name: 'Batman', year: 2016, metadataSource: 'METRON', metadataId: '1001' },
            { id: 's_1941', name: 'Batman', year: 1941, metadataSource: 'METRON', metadataId: '1002' },
        ];
        issues = [
            { id: 'i_2016_1', seriesId: 's_2016', number: '1', metadataSource: 'METRON', metadataId: '9001' },
            { id: 'i_1941_1', seriesId: 's_1941', number: '1', metadataSource: 'METRON', metadataId: '9002' },
        ];

        await POST(cblRequest(cbl(book('Batman', '1', '1940', cv('796', '105264')))));

        expect(savedItems()[0]).toMatchObject({ issueId: 'i_1941_1' });
    });

    it("never links by name to a ComicVine series whose volume id says it's a different volume", async () => {
        series = [{ id: 's_2011', name: 'Batman', year: 2011, metadataSource: 'COMICVINE', metadataId: '42721' }];
        issues = [{ id: 'i_2011_651', seriesId: 's_2011', number: '651', metadataSource: 'COMICVINE', metadataId: '555' }];

        await POST(cblRequest(cbl(book('Batman', '651', '1940', cv('796', '121997')))));

        expect(savedItems()[0]).toMatchObject({ issueId: null, cvIssueId: 121997 });
    });

    it("doesn't guess between same-named series when none has the book's start year", async () => {
        series = [
            { id: 's_2016', name: 'Batman', year: 2016, metadataSource: 'METRON', metadataId: '1001' },
            { id: 's_1990', name: 'Batman', year: 1990, metadataSource: 'METRON', metadataId: '1002' },
        ];
        issues = [
            { id: 'i_2016_1', seriesId: 's_2016', number: '1', metadataSource: 'METRON', metadataId: '9001' },
            { id: 'i_1990_1', seriesId: 's_1990', number: '1', metadataSource: 'METRON', metadataId: '9002' },
        ];

        await POST(cblRequest(cbl(book('Batman', '1', '1975', cv('796', '105264')))));
        expect(savedItems()[0]).toMatchObject({ issueId: null, cvIssueId: 105264 });

        // A book with no start year at all keeps the old rule: the first exact name.
        await POST(cblRequest(cbl(book('Batman', '1', null, ''))));
        expect(savedItems()[0]).toEqual({ listId: 'list_cbl', issueId: 'i_2016_1', title: 'Batman #1', order: 0 });
    });

    it('still takes the only same-named series when its year is off by more (a folder year can be anything)', async () => {
        series = [{ id: 's_only', name: 'Saga of the Original Human Torch', year: 0, metadataSource: 'COMICVINE', metadataId: null }];
        issues = [{ id: 'i_t1', seriesId: 's_only', number: '1', metadataSource: 'COMICVINE', metadataId: null }];

        await POST(cblRequest(cbl(book('Saga of the Original Human Torch', '1', '1990', cv('4420', '32642')))));

        expect(savedItems()[0]).toMatchObject({ issueId: 'i_t1', cvIssueId: 32642 });
    });

    it("reads several <Database> entries, preferring ComicVine's, and a Metron-only book links by its Metron id", async () => {
        series = [{ id: 's_m', name: 'Saga', year: 2012, metadataSource: 'METRON', metadataId: '77' }];
        issues = [{ id: 'i_m2', seriesId: 's_m', number: '2', metadataSource: 'METRON', metadataId: '7702' }];

        await POST(cblRequest(cbl(
            book('Saga', '1', '2012', `<Database Name="metron" Series="77" Issue="7701" />${cv('41939', '330551')}`),
            book('Saga', '2', '2012', `<Database Name="Metron" Series="77" Issue="7702" />`),
        )));

        expect(savedItems()).toEqual([
            { listId: 'list_cbl', issueId: null, title: 'Saga #1', order: 0, cvIssueId: 330551, metadataSource: 'COMICVINE' },
            { listId: 'list_cbl', issueId: 'i_m2', title: 'Saga #2', order: 1, cvIssueId: 7702, metadataSource: 'METRON' },
        ]);
    });

    it("ignores an id too big to store instead of failing the import", async () => {
        await POST(cblRequest(cbl(book('Batman', '651', '1940', cv('796', '99999999999')))));

        expect(savedItems()).toEqual([{ listId: 'list_cbl', issueId: null, title: 'Batman #651', order: 0 }]);
    });

    it("matches numbers in a series' own run, not its annuals or attached editions", async () => {
        series = [{ id: 's_bat', name: 'Batman', year: 1940, metadataSource: 'COMICVINE', metadataId: '796' }];
        issues = [
            { id: 'i_ann1', seriesId: 's_bat', number: '1', metadataSource: 'COMICVINE', metadataId: '5000', isAnnual: true, attachedVolumeId: 'att_ann' },
            { id: 'i_tpb1', seriesId: 's_bat', number: '1', metadataSource: 'COMICVINE', metadataId: '5001', attachedVolumeId: 'att_tpb' },
            { id: 'i_run1', seriesId: 's_bat', number: '1', metadataSource: 'COMICVINE', metadataId: null },
        ];

        await POST(cblRequest(cbl(book('Batman', '1', '1940', ''))));

        expect(savedItems()[0]).toMatchObject({ issueId: 'i_run1' });
    });

    it("never loads the whole issue table: every issue query is narrowed", async () => {
        series = [{ id: 's_bat', name: 'Batman', year: 1940, metadataSource: 'COMICVINE', metadataId: '796' }];
        issues = [{ id: 'i_651', seriesId: 's_bat', number: '651', metadataSource: 'COMICVINE', metadataId: '121997' }];

        await POST(cblRequest(cbl(book('Batman', '651', '1940', cv('796', '121997')), book('Robin', '1', '1993', ''))));

        expect(mocks.issueFindMany).toHaveBeenCalled();
        for (const [args] of mocks.issueFindMany.mock.calls) {
            expect(args?.where?.OR ?? args?.where?.seriesId).toBeTruthy();
        }
    });
});
