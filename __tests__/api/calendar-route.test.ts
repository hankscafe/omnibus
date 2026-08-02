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
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/db', () => ({
    prisma: { issue: { findMany: mocks.findManyIssues } }
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
