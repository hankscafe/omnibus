import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { AuditLogger } from '@/lib/audit-logger';
import { omnibusQueue } from '@/lib/queue';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function PUT(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

    try {
        const { updates, action } = await request.json(); 
        
        if (action === 'restore') {
            // Restore defaults: Unset the flag
            await prisma.issue.updateMany({
                where: { id: { in: updates } },
                data: { hasCustomMetadata: false }
            });

            await AuditLogger.log('RESTORE_ISSUE_DEFAULTS', { count: updates.length }, (session.user as any).id);
            return NextResponse.json({ success: true, message: "Defaults restored. Please refresh metadata." });
        }

        // Standard bulk edit: Set the flag to true
        const transactions = updates.map((update: any) => 
            prisma.issue.update({
                where: { id: update.id },
                data: { 
                    number: update.number, 
                    name: update.name, 
                    releaseDate: update.releaseDate,
                    hasCustomMetadata: true // <-- NEW: Lock the metadata
                }
            })
        );

        await prisma.$transaction(transactions);

        await AuditLogger.log('UPDATE_ISSUE_BULK', {
            updatedCount: updates.length,
            updates: updates.map((u: any) => ({ id: u.id, name: u.name, number: u.number }))
        }, (session.user as any).id);

        if (updates.length > 0) {
            await omnibusQueue.add('EMBED_METADATA', { 
                type: 'EMBED_METADATA', 
                issueIds: updates.map((u: any) => u.id) 
            }, {
                jobId: `EMBED_META_BULK_${Date.now()}`
            }).catch(() => {});
        }

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        Logger.log(`[Bulk Issue Edit] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}