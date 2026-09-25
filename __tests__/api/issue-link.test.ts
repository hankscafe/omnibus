// __tests__/api/issue-link.test.ts
//
// POST /api/library/issue/link — an unmatched file row is linked to a series' official row: the
// official row takes the file and the unmatched row is deleted. Issue.fileAddedAt (#206 follow-up):
// linking is a RE-HOME, so the official row inherits the unmatched row's arrival time — the file
// was announced when the scan first saw it, and linking it must not announce it again.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/library/issue/link/route';
import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

vi.mock('next-auth/jwt', () => ({ getToken: vi.fn(async () => ({ role: 'ADMIN', id: 'admin_1' })) }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: vi.fn() } }));
vi.mock('@/lib/utils/safe-fs', () => ({ moveFileSafe: vi.fn(async () => undefined) }));
vi.mock('@/lib/utils/archive-pages', () => ({ countArchivePages: vi.fn(async () => 22) }));
vi.mock('fs', () => ({ default: { existsSync: vi.fn(() => false) } }));
vi.mock('@/lib/db', () => ({
    prisma: {
        issue: { findUnique: vi.fn(), update: vi.fn((a: any) => ({ op: 'update', ...a })), delete: vi.fn((a: any) => ({ op: 'delete', ...a })) },
        systemSetting: { findMany: vi.fn(async () => []) },
        $transaction: vi.fn(async (ops: any[]) => ops),
    },
}));

const OLD = new Date('2026-06-01T08:00:00.000Z');
const BORN = new Date('2026-05-01T08:00:00.000Z');
const req = (body: unknown) => new NextRequest('http://localhost/api/library/issue/link', { method: 'POST', body: JSON.stringify(body) });

describe('POST /api/library/issue/link — fileAddedAt', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (prisma.issue.findUnique as any).mockImplementation(async ({ where }: any) => {
            if (where.id === 'unm_1') return {
                id: 'unm_1', filePath: '/comics/Batman (2016)/batman 5.cbz', fileAddedAt: OLD, createdAt: BORN,
                series: { name: 'Batman', publisher: 'DC Comics', year: 2016 },
            };
            if (where.id === 'tgt_1') return { id: 'tgt_1', number: '5', name: 'I Am Suicide', filePath: null, releaseDate: '2016-10-05' };
            return null;
        });
    });

    it('gives the official row the unmatched row\'s arrival time, not now', async () => {
        const res = await POST(req({ unmatchedId: 'unm_1', targetId: 'tgt_1' }));
        expect(res.status).toBe(200);

        const update = (prisma.issue.update as any).mock.calls[0][0];
        expect(update.where).toEqual({ id: 'tgt_1' });
        expect(update.data.fileAddedAt).toEqual(OLD);
        expect((prisma.issue.delete as any).mock.calls[0][0]).toEqual({ where: { id: 'unm_1' } });
    });

    it('falls back to the unmatched row\'s birth when it predates the column', async () => {
        (prisma.issue.findUnique as any).mockImplementation(async ({ where }: any) =>
            where.id === 'unm_1'
                ? { id: 'unm_1', filePath: '/comics/Batman (2016)/batman 5.cbz', fileAddedAt: null, createdAt: BORN, series: { name: 'Batman', publisher: 'DC Comics', year: 2016 } }
                : { id: 'tgt_1', number: '5', name: null, filePath: null, releaseDate: null }
        );

        await POST(req({ unmatchedId: 'unm_1', targetId: 'tgt_1' }));

        expect((prisma.issue.update as any).mock.calls[0][0].data.fileAddedAt).toEqual(BORN);
    });
});
