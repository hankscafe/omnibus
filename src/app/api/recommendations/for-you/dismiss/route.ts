// src/app/api/recommendations/for-you/dismiss/route.ts
//
// "Not interested" on a library-aware recommendation (Beta B). Per user: the shelf is built for
// the library, the dismissal is personal. POST hides a volume for the caller; DELETE undoes it.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

async function parseBody(request: Request): Promise<{ volumeId: string; source: string } | null> {
    const body = await request.json().catch(() => null);
    const volumeId = body?.volumeId != null ? String(body.volumeId).trim() : '';
    if (!volumeId || !/^\d+$/.test(volumeId)) return null;
    const source = typeof body?.source === 'string' && body.source.trim() ? body.source.trim().toUpperCase() : 'COMICVINE';
    return { volumeId, source };
}

export async function POST(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id as string | undefined;
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const parsed = await parseBody(request);
    if (!parsed) return NextResponse.json({ error: 'volumeId (numeric) is required' }, { status: 400 });

    try {
        await prisma.recommendationDismissal.upsert({
            where: { userId_source_volumeId: { userId, source: parsed.source, volumeId: parsed.volumeId } },
            update: {},
            create: { userId, source: parsed.source, volumeId: parsed.volumeId },
        });
        return NextResponse.json({ success: true, dismissed: true, volumeId: parsed.volumeId });
    } catch (error: unknown) {
        Logger.log(`[For You API] Dismiss failed: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: 'Failed to dismiss' }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id as string | undefined;
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const parsed = await parseBody(request);
    if (!parsed) return NextResponse.json({ error: 'volumeId (numeric) is required' }, { status: 400 });

    try {
        await prisma.recommendationDismissal.deleteMany({ where: { userId, source: parsed.source, volumeId: parsed.volumeId } });
        return NextResponse.json({ success: true, dismissed: false, volumeId: parsed.volumeId });
    } catch (error: unknown) {
        Logger.log(`[For You API] Undo dismiss failed: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: 'Failed to undo' }, { status: 500 });
    }
}
