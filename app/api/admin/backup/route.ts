import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

// NEW: Prevent Next.js from caching this backup file
export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // Fetch all critical data
        const [users, series, issues, readProgresses, settings, requests] = await Promise.all([
            prisma.user.findMany(),
            prisma.series.findMany(),
            prisma.issue.findMany(),
            prisma.readProgress.findMany(),
            prisma.systemSetting.findMany(),
            prisma.request.findMany()
        ]);

        const backupData = {
            timestamp: new Date().toISOString(),
            version: "1.0",
            data: {
                users,
                series,
                issues,
                readProgresses,
                settings,
                requests
            }
        };

        const jsonString = JSON.stringify(backupData, null, 2);
        
        // Return as a downloadable file
        return new NextResponse(jsonString, {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Content-Disposition': `attachment; filename="omnibus_backup_${new Date().toISOString().split('T')[0]}.json"`,
            },
        });

    } catch (error: any) {
        return NextResponse.json({ error: "Backup generation failed: " + error.message }, { status: 500 });
    }
}