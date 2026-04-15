import { NextResponse } from 'next/server';
import { omnibusQueue } from '@/lib/queue';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';

export async function POST(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { seriesIds } = await request.json();
        
        if (!seriesIds || !Array.isArray(seriesIds) || seriesIds.length === 0) {
            return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
        }

        await omnibusQueue.add('REPACK_ARCHIVES', { type: 'REPACK_ARCHIVES', seriesIds }, {
            jobId: `REPACK_${Date.now()}`
        });

        await AuditLogger.log('REPACK_ARCHIVES_QUEUED', { seriesIds }, (session.user as any).id);

        return NextResponse.json({ success: true, message: "Repacking job queued." });
    } catch (error: unknown) {
        Logger.log(`[Repack API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}