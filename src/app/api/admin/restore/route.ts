import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const formData = await request.formData();
        const file = formData.get('file') as File;
        
        if (!file) {
            return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
        }

        const fileContent = await file.text();
        const backup = JSON.parse(fileContent);

        if (!backup.data) {
            return NextResponse.json({ error: "Invalid backup file format" }, { status: 400 });
        }

        Logger.log("[Restore] Starting safe database restoration from backup file...", "info");

        // Helper function for safe, repetitive upserts
        const restoreTable = async (dataArray: any[], model: any, pk: string = 'id') => {
            if (!dataArray || !Array.isArray(dataArray)) return;
            for (const item of dataArray) {
                await model.upsert({
                    where: { [pk]: item[pk] },
                    update: item,
                    create: item
                }).catch(() => {});
            }
        };

        // 1. Restore Base Entities
        await restoreTable(backup.data.users, prisma.user);
        await restoreTable(backup.data.settings, prisma.systemSetting, 'key');
        await restoreTable(backup.data.libraries, prisma.library);
        await restoreTable(backup.data.downloadClients, prisma.downloadClient);
        await restoreTable(backup.data.discordWebhooks, prisma.discordWebhook);
        await restoreTable(backup.data.indexers, prisma.indexer);
        await restoreTable(backup.data.customHeaders, prisma.customHeader);
        await restoreTable(backup.data.searchAcronyms, prisma.searchAcronym);
        await restoreTable(backup.data.trophies, prisma.trophy);

        // 2. Restore Level 1 Dependencies (Require Libraries/Users)
        await restoreTable(backup.data.series, prisma.series);
        await restoreTable(backup.data.collections, prisma.collection);
        await restoreTable(backup.data.readingLists, prisma.readingList);

        // 3. Restore Level 2 Dependencies (Require Series/Lists)
        await restoreTable(backup.data.issues, prisma.issue);
        await restoreTable(backup.data.requests, prisma.request);
        await restoreTable(backup.data.userTrophies, prisma.userTrophy);

        // 4. Restore Level 3 Dependencies (Require Issues)
        await restoreTable(backup.data.readProgresses, prisma.readProgress);
        await restoreTable(backup.data.collectionItems, prisma.collectionItem);
        await restoreTable(backup.data.readingListItems, prisma.readingListItem);
        await restoreTable(backup.data.issueReports, prisma.issueReport);

        Logger.log("[Restore] Database restoration completed successfully.", "success");
        return NextResponse.json({ success: true });

    } catch (error: any) {
        Logger.log(`[Restore] Failed: ${error.message}`, "error");
        return NextResponse.json({ error: "Restore failed: " + error.message }, { status: 500 });
    }
}