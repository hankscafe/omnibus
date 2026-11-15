// __tests__/api/calendar-route.test.ts
//
// The "Omnibus Tracked Series" calendar tab rendered a hardcoded "Unreleased" badge for every
// item, even weeks after release. These tests pin the API contract: each calendar entry must
// carry a libraryState that advances UNRELEASED -> RELEASED -> IN_LIBRARY as the release date
// passes and the file lands in the library.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/calendar/route';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    findManyIssues: vi.fn(),
    findManyRequests: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/db', () => ({
    prisma: { issue: { findMany: mocks.findManyIssues }, request: { findMany: mocks.findManyRequests } }
}));
vi.mock('@/lib/library-access', () => ({
    getAccessibleLibraryIds: vi.fn().mockResolvedValue('ALL'),
}));

const isoDaysFromNow = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
};

const baseIssue = (overrides: Record<string, any> = {}) => ({
    id: 'iss_1',
    seriesId: 'ser_1',
    number: '5',
    name: null,
    status: 'WANTED',
    filePath: null,
    releaseDate: isoDaysFromNow(3),
    coverUrl: null,
    series: { name: 'Batman', folderPath: '/comics/DC/Batman (2016)', coverUrl: null, publisher: 'DC Comics' },
    ...overrides,
});

const weekReq = () => new Request('http://localhost/api/calendar?weekOffset=0');

describe('API Route: GET /api/calendar (tracked-series week view)', () => {
    beforeEach(() => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
        mocks.findManyRequests.mockResolvedValue([]);
    });

    it('marks a future release with no file as UNRELEASED', async () => {
        mocks.findManyIssues.mockResolvedValue([baseIssue({ releaseDate: isoDaysFromNow(3) })]);

        const res = await GET(weekReq());
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.releases[0].libraryState).toBe('UNRELEASED');
    });

    it('marks a past release with no file as RELEASED', async () => {
        mocks.findManyIssues.mockResolvedValue([baseIssue({ releaseDate: isoDaysFromNow(-3) })]);

        const res = await GET(weekReq());
        const data = await res.json();

        expect(data.releases[0].libraryState).toBe('RELEASED');
    });

    it('marks an issue with a file on disk as IN_LIBRARY', async () => {
        mocks.findManyIssues.mockResolvedValue([baseIssue({
            releaseDate: isoDaysFromNow(-3),
            filePath: '/comics/DC/Batman (2016)/Batman 005.cbz',
            status: 'COMPLETED',
        })]);

        const res = await GET(weekReq());
        const data = await res.json();

        expect(data.releases[0].libraryState).toBe('IN_LIBRARY');
    });

    it('treats a COMPLETED/IMPORTED status as in-library even if filePath is missing', async () => {
        mocks.findManyIssues.mockResolvedValue([baseIssue({
            releaseDate: isoDaysFromNow(-3),
            filePath: null,
            status: 'IMPORTED',
        })]);

        const res = await GET(weekReq());
        const data = await res.json();

        expect(data.releases[0].libraryState).toBe('IN_LIBRARY');
    });

    it('never reports IN_LIBRARY for an unreleased issue without a file', async () => {
        mocks.findManyIssues.mockResolvedValue([baseIssue({ releaseDate: isoDaysFromNow(10), status: 'WANTED' })]);

        const res = await GET(weekReq());
        const data = await res.json();

        expect(data.releases[0].libraryState).toBe('UNRELEASED');
    });
});

// "My Pull List" (v1.4.3): scope=followed swaps the series filter from the GLOBAL monitored flag
// to the CURRENT USER's follows — the default stays byte-compatible for the tracked tab and every
// dashboard/widget consumer.
describe('API Route: GET /api/calendar scope contract', () => {
    beforeEach(() => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
        mocks.findManyIssues.mockResolvedValue([]);
    });

    it('defaults to the tracked view: monitored series, no follow filter', async () => {
        await GET(new Request('http://localhost/api/calendar?weekOffset=0'));

        const where = mocks.findManyIssues.mock.calls[0][0].where;
        expect(where.series.monitored).toBe(true);
        expect(where.series.follows).toBeUndefined();
    });

    it('scope=followed filters to the session user\'s follows and drops the monitored requirement', async () => {
        await GET(new Request('http://localhost/api/calendar?weekOffset=0&scope=followed'));

        const where = mocks.findManyIssues.mock.calls[0][0].where;
        expect(where.series.follows).toEqual({ some: { userId: 'u1' } });
        expect(where.series.monitored).toBeUndefined();
    });

    it('honors scope=followed in the no-weekOffset compat mode too', async () => {
        await GET(new Request('http://localhost/api/calendar?scope=followed'));

        const where = mocks.findManyIssues.mock.calls[0][0].where;
        expect(where.series.follows).toEqual({ some: { userId: 'u1' } });
    });
});

// Calendar fix C (beta.042): a "Released" card couldn't say whether anything was fetching the issue (field
// report: monitored issues showed RELEASED and never downloaded). Each week row now carries its request's
// status, found the way the monitor and the search worker find a request's issue.
describe('API Route: GET /api/calendar - the request behind each row', () => {
    const series = { name: 'Batman', folderPath: '/comics/DC/Batman (2016)', coverUrl: null, publisher: 'DC Comics', metadataId: '4000' };
    const row = (overrides: Record<string, unknown> = {}) => baseIssue({
        releaseDate: isoDaysFromNow(-3), attachedVolumeId: null, attachedVolume: null, series, ...overrides,
    });
    const request = (overrides: Record<string, unknown> = {}) => ({
        volumeId: '4000', issueNumber: '5', activeDownloadName: 'Batman #5', status: 'NOT_FOUND', updatedAt: new Date(), ...overrides,
    });
    const statuses = async () => {
        const data = await (await GET(weekReq())).json();
        return Object.fromEntries(data.releases.map((r: { id: string; requestStatus: unknown }) => [r.id, r.requestStatus]));
    };

    beforeEach(() => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
        mocks.findManyRequests.mockResolvedValue([]);
    });

    it("answers the status of the issue's request, asking only for this week's series and never a cancelled one", async () => {
        mocks.findManyIssues.mockResolvedValue([row()]);
        mocks.findManyRequests.mockResolvedValue([request()]);

        expect(await statuses()).toEqual({ iss_1: 'NOT_FOUND' });

        const args = mocks.findManyRequests.mock.calls[0][0];
        // A series' requests are filed under its provider id, or its own id when it has none.
        expect([...args.where.volumeId.in].sort()).toEqual(['4000', 'ser_1']);
        expect(args.where.status).toEqual({ not: 'CANCELLED' });
        expect(args.orderBy).toEqual({ updatedAt: 'desc' });
        // The rows' lane and the series' provider id feed the match.
        const include = mocks.findManyIssues.mock.calls[0][0].include;
        expect(include.series.select.metadataId).toBe(true);
        expect(include.attachedVolume).toEqual({ select: { name: true, kind: true } });
    });

    it('takes the most recently updated request when there are several', async () => {
        mocks.findManyIssues.mockResolvedValue([row()]);
        mocks.findManyRequests.mockResolvedValue([request({ status: 'DOWNLOADING' }), request({ status: 'NOT_FOUND' })]);

        expect(await statuses()).toEqual({ iss_1: 'DOWNLOADING' });
    });

    it('answers null for a row with no request, and for requests of another issue or another series', async () => {
        mocks.findManyIssues.mockResolvedValue([row()]);
        mocks.findManyRequests.mockResolvedValue([
            request({ issueNumber: '6', activeDownloadName: 'Batman #6' }),
            request({ volumeId: '9999' }),
        ]);

        expect(await statuses()).toEqual({ iss_1: null });
    });

    it("reads the request's stored issue number before its name (a pack title), and the name when none is stored", async () => {
        mocks.findManyIssues.mockResolvedValue([row(), row({ id: 'iss_2', number: '7' })]);
        mocks.findManyRequests.mockResolvedValue([
            request({ issueNumber: '5', activeDownloadName: 'Batman #3-6 (2016)', status: 'DOWNLOADING' }),
            request({ issueNumber: null, activeDownloadName: 'Batman #7', status: 'MANUAL_DDL' }),
        ]);

        expect(await statuses()).toEqual({ iss_1: 'DOWNLOADING', iss_2: 'MANUAL_DDL' });
    });

    it("puts a Special's request on the Special, never on the run's issue of the same number (#255)", async () => {
        const arkM = { name: 'Batman: Ark-M', kind: 'SPECIAL' };
        mocks.findManyIssues.mockResolvedValue([
            row({ id: 'run_1', number: '1' }),
            row({ id: 'ark_1', number: '1', attachedVolumeId: 'av_ark', attachedVolume: arkM }),
        ]);
        mocks.findManyRequests.mockResolvedValue([request({ issueNumber: '1', activeDownloadName: 'Batman: Ark-M #1', status: 'NOT_FOUND' })]);

        expect(await statuses()).toEqual({ run_1: null, ark_1: 'NOT_FOUND' });
    });

    it("leaves annual and collected-edition rows without one: their requests are filed under the lane's volume", async () => {
        mocks.findManyIssues.mockResolvedValue([
            row({ id: 'ann_1', number: '1', attachedVolumeId: 'av_ann', attachedVolume: { name: 'Batman Annual', kind: 'ANNUAL' } }),
        ]);
        mocks.findManyRequests.mockResolvedValue([request({ issueNumber: '1', activeDownloadName: 'Batman #1', status: 'DOWNLOADING' })]);

        expect(await statuses()).toEqual({ ann_1: null });
    });

    it("tells a non-admin too - it's the library's state, like In Library", async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'u2', role: 'USER' } });
        mocks.findManyIssues.mockResolvedValue([row()]);
        mocks.findManyRequests.mockResolvedValue([request({ status: 'PENDING' })]);

        expect(await statuses()).toEqual({ iss_1: 'PENDING' });
    });

    it('asks for no requests in an empty week', async () => {
        mocks.findManyIssues.mockResolvedValue([]);

        const data = await (await GET(weekReq())).json();

        expect(data.releases).toEqual([]);
        expect(mocks.findManyRequests).not.toHaveBeenCalled();
    });
});
