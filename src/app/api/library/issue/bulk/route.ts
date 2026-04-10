// src/app/api/library/issue/bulk/route.ts

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { AuditLogger } from '@/lib/audit-logger';

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

        // --- NEW: LOG BULK METADATA UPDATES ---
        await AuditLogger.log('UPDATE_ISSUE_BULK', {
            updatedCount: updates.length,
            updates: updates.map((u: any) => ({ id: u.id, name: u.name, number: u.number }))
        }, (session.user as any).id);

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}