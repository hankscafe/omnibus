// __tests__/api/page-sweep-routes.test.ts
//
// Issue #189 Phase 3: the sweep's HTTP surface. Enqueue validates + labels server-side, refuses
// a second sweep while one is genuinely running, and publishes the RUNNING state BEFORE the job
// is queued; scan resolves paths server-side, constrains candidates to the source's series, and
// maps engine results back to issues; cancel only flags the currently running run.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    issueFindUnique: vi.fn(),
    issueFindMany: vi.fn(),
    settingFindUnique: vi.fn(),
    settingUpsert: vi.fn(),
    queueAdd: vi.fn(),
    getServerSession: vi.fn(),
    audit: vi.fn(),
    log: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        issue: { findUnique: mocks.issueFindUnique, findMany: mocks.issueFindMany },
        systemSetting: { findUnique: mocks.settingFindUnique, upsert: mocks.settingUpsert },
    }
}));
vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: async () => ({}) }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: mocks.audit } }));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('@/lib/queue', () => ({ omnibusQueue: { add: mocks.queueAdd } }));
vi.mock('@/lib/engine', () => ({ ENGINE_URL: 'http://engine:8000', engineHeaders: (h: any = {}) => h }));

import { POST as enqueuePOST, GET as statusGET } from '@/app/api/library/issue/pages/sweep/route';
import { POST as scanPOST } from '@/app/api/library/issue/pages/sweep/scan/route';
import { POST as cancelPOST } from '@/app/api/library/issue/pages/sweep/cancel/route';

const fetchMock = vi.fn();
global.fetch = fetchMock as any;

const req = (url: string, body: any) => new Request(url, { method: 'POST', body: JSON.stringify(body) });

const sourceIssue = () => ({
    id: 'src', number: '1', seriesId: 's1', filePath: '/comics/S/S 001.cbz',
    series: { name: 'Series' },
});

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerSession.mockResolvedValue({ user: { id: 'admin1', role: 'ADMIN' } });
    mocks.settingFindUnique.mockResolvedValue(null);
    mocks.settingUpsert.mockResolvedValue({});
    mocks.queueAdd.mockResolvedValue({});
    mocks.issueFindUnique.mockResolvedValue(sourceIssue());
});

describe('POST /pages/sweep (enqueue)', () => {
    it('labels items from the DB, publishes RUNNING before enqueueing, and queues chunk 0', async () => {
        mocks.issueFindMany.mockResolvedValue([
            { id: 'i2', number: '2' },
            { id: 'i3', number: '3' },
        ]);

        const res = await enqueuePOST(req('http://x/api/library/issue/pages/sweep', {
            sourceIssueId: 'src', sourceEntry: 'credits.jpg',
            items: [
                { issueId: 'i2', entryName: 'zz.jpg' },
                { issueId: 'i3', entryName: 'yy.jpg' },
                { issueId: 'other-series', entryName: 'nope.jpg' }, // filtered by the series-scoped lookup
            ],
        }));
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.total).toBe(2);
        // RUNNING result written before the queue add.
        const resultWrite = mocks.settingUpsert.mock.calls.find(c => c[0].where.key === 'last_page_sweep_result');
        expect(resultWrite).toBeTruthy();
        expect(JSON.parse(resultWrite![0].update.value)).toMatchObject({ status: 'RUNNING', total: 2, processed: 0 });
        const [name, data, opts] = mocks.queueAdd.mock.calls[0];
        expect(name).toBe('PAGE_SWEEP');
        expect(data.items).toEqual([
            { issueId: 'i2', entryName: 'zz.jpg', label: 'Series #2' },
            { issueId: 'i3', entryName: 'yy.jpg', label: 'Series #3' },
        ]);
        expect(opts.jobId).toMatch(/^PAGE_SWEEP_.+_0$/);
        expect(mocks.audit).toHaveBeenCalledWith('PAGE_SWEEP_STARTED', expect.objectContaining({ matchedFiles: 2 }), 'admin1');
    });

    it('refuses a second sweep while one is running with a fresh heartbeat', async () => {
        mocks.settingFindUnique.mockResolvedValue({
            value: JSON.stringify({ runId: 'r1', status: 'RUNNING', heartbeatAt: Date.now(), sourceLabel: 'x', total: 5, processed: 1, removed: 1, failedCount: 0, failed: [], startedAt: 1 }),
        });
        const res = await enqueuePOST(req('http://x/sweep', {
            sourceIssueId: 'src', sourceEntry: 'e.jpg', items: [{ issueId: 'i2', entryName: 'z.jpg' }],
        }));
        expect(res.status).toBe(409);
        expect(mocks.queueAdd).not.toHaveBeenCalled();
    });

    it('allows a new sweep over a STALE RUNNING result (crashed run)', async () => {
        mocks.settingFindUnique.mockResolvedValue({
            value: JSON.stringify({ runId: 'r1', status: 'RUNNING', heartbeatAt: Date.now() - 10 * 60 * 1000, sourceLabel: 'x', total: 5, processed: 1, removed: 1, failedCount: 0, failed: [], startedAt: 1 }),
        });
        mocks.issueFindMany.mockResolvedValue([{ id: 'i2', number: '2' }]);
        const res = await enqueuePOST(req('http://x/sweep', {
            sourceIssueId: 'src', sourceEntry: 'e.jpg', items: [{ issueId: 'i2', entryName: 'z.jpg' }],
        }));
        expect(res.status).toBe(200);
        expect(mocks.queueAdd).toHaveBeenCalled();
    });

    it('is admin-only', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'u', role: 'USER' } });
        const res = await enqueuePOST(req('http://x/sweep', { sourceIssueId: 'src', sourceEntry: 'e', items: [{ issueId: 'i2', entryName: 'z' }] }));
        expect(res.status).toBe(403);
    });
});

describe('GET /pages/sweep (status)', () => {
    it('returns the parsed result and activity flag', async () => {
        mocks.settingFindUnique.mockResolvedValue({
            value: JSON.stringify({ runId: 'r1', status: 'RUNNING', heartbeatAt: Date.now(), sourceLabel: 'x', total: 5, processed: 2, removed: 2, failedCount: 0, failed: [], startedAt: 1 }),
        });
        const res = await statusGET();
        const json = await res.json();
        expect(json.active).toBe(true);
        expect(json.result.processed).toBe(2);
    });
});

describe('POST /pages/sweep/scan', () => {
    it('maps engine matches/skips back to issues, series-scoped', async () => {
        mocks.issueFindMany.mockResolvedValue([
            { id: 'i2', number: '2', filePath: '/c/ch2.cbz' },
            { id: 'i3', number: '3', filePath: '/c/ch3.cbr' },
        ]);
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({
                source_hash: 'abc',
                matches: [{ path: '/c/ch2.cbz', entry_name: 'zz.jpg', index: 4 }],
                skipped: [{ path: '/c/ch3.cbr', reason: 'not_cbz' }],
                errors: [],
            }),
        });

        const res = await scanPOST(req('http://x/scan', {
            sourceIssueId: 'src', sourceEntry: 'credits.jpg', candidateIssueIds: ['i2', 'i3'],
        }));
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.matches).toEqual([{ issueId: 'i2', label: 'Series #2', filePath: '/c/ch2.cbz', entryName: 'zz.jpg', index: 4 }]);
        expect(json.skipped).toEqual([{ issueId: 'i3', label: 'Series #3', reason: 'not_cbz' }]);
        // Engine got server-resolved paths, never client ones.
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.source_path).toBe('/comics/S/S 001.cbz');
        expect(body.candidate_paths).toEqual(['/c/ch2.cbz', '/c/ch3.cbr']);
    });

    it('502s cleanly when the engine is down', async () => {
        mocks.issueFindMany.mockResolvedValue([{ id: 'i2', number: '2', filePath: '/c/ch2.cbz' }]);
        fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
        const res = await scanPOST(req('http://x/scan', { sourceIssueId: 'src', sourceEntry: 'e.jpg', candidateIssueIds: ['i2'] }));
        expect(res.status).toBe(502);
    });
});

describe('POST /pages/sweep/cancel', () => {
    it('flags the running run for cooperative cancel', async () => {
        mocks.settingFindUnique.mockResolvedValue({
            value: JSON.stringify({ runId: 'r1', status: 'RUNNING', heartbeatAt: Date.now(), sourceLabel: 'x', total: 5, processed: 1, removed: 1, failedCount: 0, failed: [], startedAt: 1 }),
        });
        const res = await cancelPOST(req('http://x/cancel', { runId: 'r1' }));
        expect(res.status).toBe(200);
        const flagWrite = mocks.settingUpsert.mock.calls.find(c => c[0].where.key === 'page_sweep_cancel');
        expect(flagWrite![0].update.value).toBe('r1');
    });

    it('409s when no matching run is active', async () => {
        mocks.settingFindUnique.mockResolvedValue(null);
        const res = await cancelPOST(req('http://x/cancel', { runId: 'ghost' }));
        expect(res.status).toBe(409);
        expect(mocks.settingUpsert).not.toHaveBeenCalled();
    });
});
