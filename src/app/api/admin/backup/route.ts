import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import crypto from 'crypto';
import { Logger } from '@/lib/logger';

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
            version: "2.1", // Bumped version to indicate encrypted schema
            data: {
                users, series, issues, readProgresses, settings, requests,
                libraries, downloadClients, discordWebhooks, indexers, customHeaders, searchAcronyms,
                collections, collectionItems, readingLists, readingListItems, trophies, userTrophies, issueReports
            }
        };

        // --- SECURITY FIX: Encrypt the backup payload using AES-256-CBC ---
        const algorithm = 'aes-256-cbc';
        const secret = process.env.NEXTAUTH_SECRET || 'omnibus_default_encryption_key_!@#';
        const key = crypto.createHash('sha256').update(String(secret)).digest();
        const iv = crypto.randomBytes(16);
        
        const cipher = crypto.createCipheriv(algorithm, key, iv);
        let encrypted = cipher.update(JSON.stringify(backupData), 'utf8', 'hex');
        encrypted += cipher.final('hex');

        const finalPayload = {
            encrypted: true,
            iv: iv.toString('hex'),
            data: encrypted
        };

        const jsonString = JSON.stringify(finalPayload, null, 2);
        
        return new NextResponse(jsonString, {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Content-Disposition': `attachment; filename="omnibus_backup_${new Date().toISOString().split('T')[0]}.json"`,
            },
        });

    } catch (error: any) {
        // --- SECURITY FIX: Log the real error internally, return a generic message ---
        Logger.log("[Backup API] Generation Failed:", error.message, 'error');
        return NextResponse.json({ error: "Backup generation failed. Please check the server logs." }, { status: 500 });
    }
}