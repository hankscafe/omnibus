// src/app/api/library/match-series/bulk/route.ts
//
// Bulk accept for the Smart Matcher's Accept All (2026-07-25 worklist item 4). This route is a
// thin ORCHESTRATOR: it loops the single-series handler rather than re-implementing it — all the
// incident-hardened behavior (#194 cover precedence and name policy, #196 id-collision guards,
// never-demote manga, editor locks) lives in that ~500-line handler and must not be duplicated.
// The single handler authenticates via the ambient request context, so the caller's admin session
// applies to every inner call; the cookie header is forwarded anyway as belt-and-braces.
//
// The per-call item cap keeps one HTTP request comfortably inside reverse-proxy/tunnel response
// limits (Adam's prod sits behind a Cloudflare tunnel with a ~100s ceiling; each accept can cost
// seconds of provider fetch + folder move). The client sends chunks and shows progress.
export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { POST as applySingleMatch } from '../route';

const MAX_ITEMS_PER_CALL = 10;

export async function POST(request: NextRequest) {
    const token = await getToken({ req: request });
    if (token?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

    let items: unknown;
    try {
        ({ items } = await request.json());
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!Array.isArray(items) || items.length === 0) {
        return NextResponse.json({ error: 'No items to accept' }, { status: 400 });
    }
    if (items.length > MAX_ITEMS_PER_CALL) {
        return NextResponse.json({ error: `Too many items (max ${MAX_ITEMS_PER_CALL} per call — send chunks)` }, { status: 400 });
    }

    const cookie = request.headers.get('cookie') || '';
    const results: Array<{ ok: boolean; conflicts?: number; error?: string }> = [];

    // Sequential on purpose: each accept moves folders and writes the same tables; parallel accepts
    // would race folder relocation and library-level conflict checks for no real wall-clock win
    // (provider + disk I/O dominate).
    for (const item of items as unknown[]) {
        try {
            const inner = new Request('http://internal/api/library/match-series', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', cookie },
                body: JSON.stringify(item),
            });
            const res = await applySingleMatch(inner as any);
            const body = await res.json().catch(() => ({} as any));
            if (res.ok) {
                results.push({ ok: true, conflicts: body.conflicts || 0 });
            } else {
                results.push({ ok: false, error: body.error || `HTTP ${res.status}` });
            }
        } catch (e: unknown) {
            Logger.log(`[Bulk Match] Item failed: ${getErrorMessage(e)}`, 'warn');
            results.push({ ok: false, error: getErrorMessage(e) });
        }
    }

    return NextResponse.json({ results });
}
