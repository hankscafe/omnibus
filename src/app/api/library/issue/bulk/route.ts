// src/app/api/library/issue/bulk/route.ts

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { AuditLogger } from '@/lib/audit-logger';
import { omnibusQueue } from '@/lib/queue'; // <-- NEW

export async function PUT(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

    try {
        const { updates } = await request.json(); // Array of { id, number, name, releaseDate }
        
        const transactions = updates.map((update: any) => 
            prisma.issue.update({
                where: { id: update.id },
                data: { 
                    number: update.number, 
                    name: update.name, 
                    releaseDate: update.releaseDate 
                }
            })
        );

        await prisma.$transaction(transactions);

        await AuditLogger.log('UPDATE_ISSUE_BULK', {
            updatedCount: updates.length,
            updates: updates.map((u: any) => ({ id: u.id, name: u.name, number: u.number }))
        }, (session.user as any).id);

        // --- NEW: Immediately trigger the XML Writer for the exact issues modified ---
        if (updates.length > 0) {
            await omnibusQueue.add('EMBED_METADATA', { 
                type: 'EMBED_METADATA', 
                issueIds: updates.map((u: any) => u.id) 
            }, {
                jobId: `EMBED_META_BULK_${Date.now()}`
            }).catch(() => {});
        }

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}