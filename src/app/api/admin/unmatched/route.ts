// src/app/api/admin/unmatched/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        // 1. Get Unmatched DB Records
        const unmatched = await prisma.series.findMany({
            where: { matchState: 'UNMATCHED' },
            orderBy: { name: 'asc' }
        });

        // 2. Append loose files from the unmatched drop directory
        const unmatchedDir = process.env.OMNIBUS_AWAITING_MATCH_DIR || '/unmatched';
        const rawFiles: any[] = [];
        
        try {
            const fs = await import('fs-extra');
            const path = await import('path');
            if (fs.existsSync(unmatchedDir)) {
                const files = await fs.promises.readdir(unmatchedDir);
                for (const file of files) {
                    if (file.match(/\.(cbz|cbr|zip|rar|epub)$/i)) {
                        rawFiles.push({
                            id: `raw_${Buffer.from(file).toString('base64')}`, // Safe Mock ID
                            name: file.replace(/\.[^/.]+$/, ""), // Strip extension for search guessing
                            folderPath: path.join(unmatchedDir, file),
                            isRawFile: true
                        });
                    }
                }
            }
        } catch (e) {}

        return NextResponse.json([...unmatched, ...rawFiles]);
    } catch (error: unknown) {
        Logger.log(`[Unmatched API] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}