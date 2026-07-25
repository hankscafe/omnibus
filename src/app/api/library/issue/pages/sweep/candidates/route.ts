// src/app/api/library/issue/pages/sweep/candidates/route.ts
//
// Sweep candidate list (issue #189 Phase 3): every file-backed issue in the source issue's
// series, in reading order — the id list the client walks in scan batches. The source issue is
// included on purpose: the sweep REPLACES local deletion for that page (hash first, then it's
// just another match), which is what makes "remove it here and everywhere" one operation.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';

export async function GET(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        const { searchParams } = new URL(request.url);
        const issueId = searchParams.get('issueId');
        if (!issueId) return NextResponse.json({ error: "Missing issue ID" }, { status: 400 });

        const source = await prisma.issue.findUnique({ where: { id: issueId }, include: { series: true } });
        if (!source) return NextResponse.json({ error: "Issue not found" }, { status: 404 });

        const issues = await prisma.issue.findMany({
            where: { seriesId: source.seriesId, filePath: { not: null } },
            select: { id: true, number: true },
        });
        const parsed = issues.map(i => ({ ...i, sort: parseFloat(i.number) }));
        parsed.sort((a, b) => (isNaN(a.sort) ? 0 : a.sort) - (isNaN(b.sort) ? 0 : b.sort));

        return NextResponse.json({
            seriesName: source.series?.name || '',
            candidates: parsed.map(i => ({ issueId: i.id, label: `${source.series?.name || ''} #${i.number}` })),
        });
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
