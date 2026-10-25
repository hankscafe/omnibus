// GET /api/admin/requests hands Request Management each request's note (beta.008): why it is Not
// Found Yet, Stalled, Needs Review, or still sitting at 100%. My Requests' own route (/api/request)
// maps its fields one by one and does not, so the per-source detail stays with admins.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
    prisma: {
        request: {
            findMany: vi.fn(async () => [{
                id: 'r1', userId: 'u1', volumeId: '101', metadataSource: 'COMICVINE', activeDownloadName: 'Saga #61',
                status: 'NOT_FOUND', progress: 0, downloadLink: null, imageUrl: null, retryCount: 0,
                statusNote: 'GetComics: nothing found · Prowlarr: 12 results, none matched',
                createdAt: new Date('2026-10-20T12:00:00Z'), updatedAt: new Date('2026-10-21T12:00:00Z'),
                user: { username: 'reader' },
            }]),
        },
        series: { findMany: vi.fn(async () => []) },
    },
}));
vi.mock('next-auth/next', () => ({ getServerSession: vi.fn() }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn(async () => ({})) }));

import { GET } from '@/app/api/admin/requests/route';

describe('GET /api/admin/requests', () => {
    it("includes each request's note", async () => {
        const rows = await (await GET(new Request('http://localhost/api/admin/requests'))).json();
        expect(rows[0]).toMatchObject({ id: 'r1', status: 'NOT_FOUND', statusNote: 'GetComics: nothing found · Prowlarr: 12 results, none matched' });
    });
});
