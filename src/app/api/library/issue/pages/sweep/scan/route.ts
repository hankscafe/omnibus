// src/app/api/library/issue/pages/sweep/scan/route.ts
//
// Series page sweep, scan step (issue #189 Phase 3): fingerprints the source page and reports
// byte-identical copies across ONE BATCH of the series' issues. The client walks the series in
// batches (~25) so a 400-chapter scan shows real progress and no request ever runs long. Paths
// are resolved server-side from ids; the engine judges candidates by real container signature
// (a zip-in-disguise .cbr scans fine, a real RAR is skipped with a convert-first reason).
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';

const MAX_BATCH = 50;

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        const body = await request.json();
        const sourceIssueId: string | undefined = body.sourceIssueId;
        const sourceEntry: string | undefined = body.sourceEntry;
        const candidateIssueIds: string[] = Array.isArray(body.candidateIssueIds)
            ? [...new Set(body.candidateIssueIds.map((x: any) => String(x)).filter(Boolean))] as string[]
            : [];
        if (!sourceIssueId || !sourceEntry) return NextResponse.json({ error: "Missing sweep source." }, { status: 400 });
        if (candidateIssueIds.length === 0) return NextResponse.json({ error: "No candidates in this batch." }, { status: 400 });
        if (candidateIssueIds.length > MAX_BATCH) return NextResponse.json({ error: `Batch too large (max ${MAX_BATCH}).` }, { status: 400 });

        const source = await prisma.issue.findUnique({ where: { id: sourceIssueId }, include: { series: true } });
        if (!source?.filePath) return NextResponse.json({ error: "Source issue has no file." }, { status: 404 });

        // Candidates are constrained to the source's series — a sweep never crosses series.
        const candidates = await prisma.issue.findMany({
            where: { id: { in: candidateIssueIds }, seriesId: source.seriesId, filePath: { not: null } },
            select: { id: true, number: true, filePath: true },
        });
        if (candidates.length === 0) return NextResponse.json({ matches: [], skipped: [], errors: [] });
        const byPath = new Map(candidates.map(c => [c.filePath as string, c]));

        let data: any;
        try {
            const res = await fetch(ENGINE_URL + '/api/archive/find-page', {
                method: 'POST',
                headers: engineHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    source_path: source.filePath,
                    source_entry: sourceEntry,
                    candidate_paths: candidates.map(c => c.filePath),
                }),
            });
            data = await res.json().catch(() => ({}));
            if (!res.ok) {
                return NextResponse.json({ error: data?.error || `Engine scan failed (${res.status}).` }, { status: res.status === 422 ? 422 : 502 });
            }
        } catch (e) {
            return NextResponse.json({ error: "The Rust engine is unreachable — the page scan needs it." }, { status: 502 });
        }

        const label = (c: { number: string }) => `${source.series?.name || ''} #${c.number}`;
        const matches = (Array.isArray(data.matches) ? data.matches : []).flatMap((m: any) => {
            const c = byPath.get(m.path);
            return c ? [{ issueId: c.id, label: label(c), filePath: c.filePath, entryName: m.entry_name, index: m.index }] : [];
        });
        const skipped = (Array.isArray(data.skipped) ? data.skipped : []).flatMap((s: any) => {
            const c = byPath.get(s.path);
            return c ? [{ issueId: c.id, label: label(c), reason: s.reason }] : [];
        });
        const errors = (Array.isArray(data.errors) ? data.errors : []).flatMap((e: any) => {
            const c = byPath.get(e.path);
            return c ? [{ issueId: c.id, label: label(c), error: e.error }] : [];
        });

        return NextResponse.json({ matches, skipped, errors, sourceHash: data.source_hash });
    } catch (error: unknown) {
        Logger.log(`[Page Sweep] Scan failed: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
