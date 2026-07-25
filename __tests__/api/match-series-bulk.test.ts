// __tests__/api/match-series-bulk.test.ts
//
// Beta D (2026-07-25 worklist item 4): Accept All needs a server-side bulk accept so the browser
// stops looping single accepts with 1.5s sleeps. The bulk route is a thin ORCHESTRATOR: it loops
// the battle-tested single-series handler (all the #194/#196 hardening lives there and is not
// duplicated), collects per-item outcomes, and enforces a chunk cap so one HTTP call can't run
// past reverse-proxy/tunnel response limits.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/library/match-series/bulk/route';

const mocks = vi.hoisted(() => ({
    getToken: vi.fn(),
    singlePost: vi.fn(),
    log: vi.fn(),
}));

vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }));
vi.mock('@/app/api/library/match-series/route', () => ({ POST: mocks.singlePost }));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

const req = (body: any) => new NextRequest('http://localhost/api/library/match-series/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: 'next-auth.session-token=tok' },
    body: JSON.stringify(body),
});

const item = (folder: string) => ({ oldFolderPath: folder, metadataId: '42', metadataSource: 'METRON' });

describe('API Route: bulk match accept (/api/library/match-series/bulk)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getToken.mockResolvedValue({ role: 'ADMIN', id: 'admin_1' });
        mocks.singlePost.mockResolvedValue(new Response(JSON.stringify({ success: true, conflicts: 0 }), { status: 200 }));
    });

    it('rejects non-admins', async () => {
        mocks.getToken.mockResolvedValue({ role: 'USER' });
        const res = await POST(req({ items: [item('/unmatched/A')] }));
        expect(res.status).toBe(403);
        expect(mocks.singlePost).not.toHaveBeenCalled();
    });

    it('rejects empty and oversized batches (chunk cap keeps calls tunnel-safe)', async () => {
        expect((await POST(req({ items: [] }))).status).toBe(400);
        const many = Array.from({ length: 11 }, (_, i) => item(`/unmatched/${i}`));
        expect((await POST(req({ items: many }))).status).toBe(400);
        expect(mocks.singlePost).not.toHaveBeenCalled();
    });

    it('loops the single-series handler per item and maps outcomes in order', async () => {
        mocks.singlePost
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, conflicts: 2 }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'No libraries configured.' }), { status: 400 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));

        const res = await POST(req({ items: [item('/unmatched/A'), item('/unmatched/B'), item('/unmatched/C')] }));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.results).toEqual([
            { ok: true, conflicts: 2 },
            { ok: false, error: 'No libraries configured.' },
            { ok: true, conflicts: 0 },
        ]);
        expect(mocks.singlePost).toHaveBeenCalledTimes(3);
        // Each inner request carried the item as its JSON body.
        const firstInner = mocks.singlePost.mock.calls[0][0];
        expect(JSON.parse(await firstInner.text())).toMatchObject({ oldFolderPath: '/unmatched/A' });
    });

    it('captures a thrown inner error as a failed item and keeps processing the rest', async () => {
        mocks.singlePost
            .mockRejectedValueOnce(new Error('EXDEV: cross-device link'))
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));

        const res = await POST(req({ items: [item('/unmatched/A'), item('/unmatched/B')] }));
        const data = await res.json();

        expect(data.results[0].ok).toBe(false);
        expect(data.results[0].error).toContain('EXDEV');
        expect(data.results[1].ok).toBe(true);
    });
});
