// src/app/api/library/issue/pages/route.ts
//
// Page removal (issue #189): thin HTTP wrapper over lib/pages/remove-pages-core, which owns the
// whole operation (engine rewrite + index fixups + audit). The Phase 3 series sweep runs the same
// core from its BullMQ job, so the two paths can never drift.
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { removePagesFromIssue } from '@/lib/pages/remove-pages-core';

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        const body = await request.json();
        const result = await removePagesFromIssue(
            body.issueId,
            Array.isArray(body.entryNames) ? body.entryNames : [],
            (session.user as any).id,
        );
        if (!result.ok) {
            return NextResponse.json({ error: result.error }, { status: result.status });
        }
        return NextResponse.json({
            success: true,
            newPageCount: result.newPageCount,
            removed: result.removed,
            convertedToCbz: result.convertedToCbz,
        });
    } catch (error: unknown) {
        Logger.log(`[Pages] Removal failed: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}
