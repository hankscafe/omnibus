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
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const formData = await request.formData();
        const file = formData.get('file') as File;
        
        if (!file) {
            return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
        }

        const fileContent = await file.text();
        let backup = JSON.parse(fileContent);

        // --- SECURITY FIX: Decrypt incoming backup if encrypted flag is present ---
        if (backup.encrypted) {
            try {
                const algorithm = 'aes-256-cbc';
                const secret = process.env.NEXTAUTH_SECRET || 'omnibus_default_encryption_key_!@#';
                const key = crypto.createHash('sha256').update(String(secret)).digest();
                const iv = Buffer.from(backup.iv, 'hex');
                
                const decipher = crypto.createDecipheriv(algorithm, key, iv);
                let decrypted = decipher.update(backup.data, 'hex', 'utf8');
                decrypted += decipher.final('utf8');
                
                backup = JSON.parse(decrypted);
            } catch (err) {
                Logger.log(`[Restore] Decryption failed. Incorrect NEXTAUTH_SECRET.`, "error");
                return NextResponse.json({ error: "Failed to decrypt backup. Ensure your NEXTAUTH_SECRET matches the server that created this backup." }, { status: 400 });
            }
        }

        if (!backup.data || typeof backup.data !== 'object') {
            return NextResponse.json({ error: "Invalid backup file format" }, { status: 400 });
        }

        Logger.log("[Restore] Starting safe database restoration from backup file...", "info");

        // --- SECURITY FIX: Use a transaction and remove silent .catch() ---
        // This guarantees the database will roll back entirely if ANY error occurs (e.g. invalid schema fields)
        await prisma.$transaction(async (tx) => {
            
            // Helper function for safe, repetitive upserts inside the transaction
            const restoreTable = async (dataArray: any[], model: any, pk: string = 'id') => {
                if (!dataArray || !Array.isArray(dataArray)) return;
                for (const item of dataArray) {
                    // Prisma will automatically throw an error if `item` contains arbitrary/invalid fields,
                    // which will trigger the transaction rollback.
                    await model.upsert({
                        where: { [pk]: item[pk] },
                        update: item,
                        create: item
                    }); 
                }
            };

            // 1. Restore Base Entities
            await restoreTable(backup.data.users, tx.user);
            await restoreTable(backup.data.settings, tx.systemSetting, 'key');
            await restoreTable(backup.data.libraries, tx.library);
            await restoreTable(backup.data.downloadClients, tx.downloadClient);
            await restoreTable(backup.data.discordWebhooks, tx.discordWebhook);
            await restoreTable(backup.data.indexers, tx.indexer);
            await restoreTable(backup.data.customHeaders, tx.customHeader);
            await restoreTable(backup.data.searchAcronyms, tx.searchAcronym);
            await restoreTable(backup.data.trophies, tx.trophy);

            // 2. Restore Level 1 Dependencies (Require Libraries/Users)
            await restoreTable(backup.data.series, tx.series);
            await restoreTable(backup.data.collections, tx.collection);
            await restoreTable(backup.data.readingLists, tx.readingList);

            // 3. Restore Level 2 Dependencies (Require Series/Lists)
            await restoreTable(backup.data.issues, tx.issue);
            await restoreTable(backup.data.requests, tx.request);
            await restoreTable(backup.data.userTrophies, tx.userTrophy);

            // 4. Restore Level 3 Dependencies (Require Issues)
            await restoreTable(backup.data.readProgresses, tx.readProgress);
            await restoreTable(backup.data.collectionItems, tx.collectionItem);
            await restoreTable(backup.data.readingListItems, tx.readingListItem);
            await restoreTable(backup.data.issueReports, tx.issueReport);
            
        }, {
            // Set a generous timeout for the transaction since large backups can take a few seconds
            timeout: 30000 
        });

        // --- AUDIT LOG ---
        await AuditLogger.log('DATABASE_RESTORE', { 
            message: "Full database state was overwritten from a backup JSON file." 
        }, (session.user as any).id);

        Logger.log("[Restore] Database restoration completed successfully.", "success");
        return NextResponse.json({ success: true });

    } catch (error: unknown) {
        Logger.log(`[Restore] Failed: ${getErrorMessage(error)}`, "error");
        return NextResponse.json({ error: "Restore failed: " + getErrorMessage(error) }, { status: 500 });
    }
}