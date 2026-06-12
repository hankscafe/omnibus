import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';

export async function POST(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { seriesIds } = await request.json();
        
        if (!seriesIds || !Array.isArray(seriesIds) || seriesIds.length === 0) {
            return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
        }

        Logger.log(`[Repack API] Forwarding job for ${seriesIds.length} series to Rust Engine...`, 'info');

        // --- FORWARD TO RUST ENGINE (Now with AWAIT!) ---
        try {
            const rustResponse = await fetch(ENGINE_URL + '/api/repack', {
                method: 'POST',
                headers: engineHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ series_ids: seriesIds })
            });

            if (!rustResponse.ok) {
                Logger.log(`[Repack API] Rust Engine returned error status: ${rustResponse.status}`, 'error');
            } else {
                Logger.log(`[Repack API] Rust Engine accepted the job!`, 'info');
            }
        } catch (e) {
            Logger.log(`[Repack API] Failed to contact Rust Engine: ${getErrorMessage(e)}`, 'error');
        }

        await AuditLogger.log('REPACK_ARCHIVES_QUEUED_IN_RUST', { seriesIds }, (session.user as any).id);

        return NextResponse.json({ success: true, message: "Repacking job queued in Rust Engine." });
    } catch (error: unknown) {
        Logger.log(`[Repack API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}