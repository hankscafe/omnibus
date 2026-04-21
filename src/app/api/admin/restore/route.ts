// src/app/api/admin/restore/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import crypto from 'crypto';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';

export async function POST(request: Request) {
    try {
        // 1. Fetch the session unconditionally so it is available globally in this function
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);

        // 2. Check if the initial setup is complete
        const setupStatus = await prisma.systemSetting.findUnique({ where: { key: 'setup_complete' } });
        
        // 3. Enforce security ONLY if setup is complete
        if (setupStatus?.value === 'true') {
            if (session?.user?.role !== 'ADMIN') {
                return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
            }
        }

        const formData = await request.formData();
        const file = formData.get('file') as File;
        if (!file) return NextResponse.json({ error: "No file uploaded" }, { status: 400 });

        const fileContent = await file.text();
        let backup = JSON.parse(fileContent);

        if (backup.encrypted) {
            try {
                const secret = process.env.NEXTAUTH_SECRET;
                if (!secret || secret === 'change_this_to_a_random_secure_string_123!') {
                    throw new Error("NEXTAUTH_SECRET is missing.");
                }

                const algorithm = 'aes-256-cbc';
                const iv = Buffer.from(backup.iv, 'hex');
                let key: Buffer;

                // VERSION CHECK: Determine which KDF to use
                if (backup.version === "3.0") {
                    const salt = Buffer.from(backup.salt, 'hex');
                    key = crypto.pbkdf2Sync(secret, salt, 100000, 32, 'sha256');
                } else {
                    // Legacy Fallback for older backups (SHA-256)
                    key = crypto.createHash('sha256').update(String(secret)).digest();
                }
                
                const decipher = crypto.createDecipheriv(algorithm, key, iv);
                let decrypted = decipher.update(backup.data, 'hex', 'utf8');
                decrypted += decipher.final('utf8');
                backup = JSON.parse(decrypted);
            } catch (err) {
                return NextResponse.json({ error: "Decryption failed. Check NEXTAUTH_SECRET." }, { status: 400 });
            }
        }

        if (!backup.data) return NextResponse.json({ error: "Invalid backup format" }, { status: 400 });

        await prisma.$transaction(async (tx) => {
            const restoreTable = async (dataArray: any[], model: any, pk: string = 'id') => {
                if (!dataArray || !Array.isArray(dataArray)) return;
                for (const item of dataArray) {
                    await model.upsert({ where: { [pk]: item[pk] }, update: item, create: item }); 
                }
            };

            await restoreTable(backup.data.users, tx.user);
            await restoreTable(backup.data.settings, tx.systemSetting, 'key');
            await restoreTable(backup.data.libraries, tx.library);
            await restoreTable(backup.data.downloadClients, tx.downloadClient);
            await restoreTable(backup.data.discordWebhooks, tx.discordWebhook);
            await restoreTable(backup.data.indexers, tx.indexer);
            await restoreTable(backup.data.customHeaders, tx.customHeader);
            await restoreTable(backup.data.searchAcronyms, tx.searchAcronym);
            await restoreTable(backup.data.trophies, tx.trophy);
            await restoreTable(backup.data.series, tx.series);
            await restoreTable(backup.data.collections, tx.collection);
            await restoreTable(backup.data.readingLists, tx.readingList);
            await restoreTable(backup.data.issues, tx.issue);
            await restoreTable(backup.data.requests, tx.request);
            await restoreTable(backup.data.userTrophies, tx.userTrophy);
            await restoreTable(backup.data.readProgresses, tx.readProgress);
            await restoreTable(backup.data.collectionItems, tx.collectionItem);
            await restoreTable(backup.data.readingListItems, tx.readingListItem);
            await restoreTable(backup.data.issueReports, tx.issueReport);
            await restoreTable(backup.data.digestHistory, tx.digestHistory);
        }, { timeout: 30000 });

        // --- UPDATED: Safely check if session exists for the audit log ---
        await AuditLogger.log(
            'DATABASE_RESTORE', 
            { message: "State overwritten from backup." }, 
            session?.user ? (session.user as any).id : 'System'
        );
        
        return NextResponse.json({ success: true });

    } catch (error: unknown) {
        Logger.log(`[Database Restore] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: "Restore failed: " + getErrorMessage(error) }, { status: 500 });
    }
}