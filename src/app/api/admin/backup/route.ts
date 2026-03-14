import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // NATIVE DB FETCH: Grab absolutely everything, including all the new configuration tables!
        const [
            users, series, issues, readProgresses, settings, requests,
            libraries, downloadClients, discordWebhooks, indexers, customHeaders, searchAcronyms,
            collections, collectionItems, readingLists, readingListItems, trophies, userTrophies, issueReports
        ] = await Promise.all([
            prisma.user.findMany(), prisma.series.findMany(), prisma.issue.findMany(),
            prisma.readProgress.findMany(), prisma.systemSetting.findMany(), prisma.request.findMany(),
            prisma.library.findMany(), prisma.downloadClient.findMany(), prisma.discordWebhook.findMany(),
            prisma.indexer.findMany(), prisma.customHeader.findMany(), prisma.searchAcronym.findMany(),
            prisma.collection.findMany(), prisma.collectionItem.findMany(), prisma.readingList.findMany(),
            prisma.readingListItem.findMany(), prisma.trophy.findMany(), prisma.userTrophy.findMany(), prisma.issueReport.findMany()
        ]);

        const backupData = {
            timestamp: new Date().toISOString(),
            version: "2.0", // Bumped version to indicate the new relational schema
            data: {
                users, series, issues, readProgresses, settings, requests,
                libraries, downloadClients, discordWebhooks, indexers, customHeaders, searchAcronyms,
                collections, collectionItems, readingLists, readingListItems, trophies, userTrophies, issueReports
            }
        };

        const jsonString = JSON.stringify(backupData, null, 2);
        
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