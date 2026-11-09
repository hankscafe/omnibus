// src/app/api/admin/restore/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import crypto from 'crypto';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { storedFolderProblem } from '@/lib/utils/stored-folder';

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

        // The folders Settings trims are trimmed here too, before anything is written (beta.018
        // follow-up): a backup made before Settings trimmed them can carry " /data/comics", which is
        // a relative path.
        const trimmed = (v: unknown) => (typeof v === 'string' ? v.trim() : v);
        const isRow = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
        const data = backup.data;
        if (Array.isArray(data.libraries)) {
            data.libraries = data.libraries.map((lib: unknown) => (isRow(lib) ? { ...lib, path: trimmed(lib.path) } : lib));
        }
        if (Array.isArray(data.downloadClients)) {
            data.downloadClients = data.downloadClients.map((c: unknown) => (isRow(c) && 'localPath' in c ? { ...c, localPath: trimmed(c.localPath) } : c));
        }
        if (Array.isArray(data.settings)) {
            data.settings = data.settings.map((s: unknown) => (isRow(s) && s.key === 'download_path' ? { ...s, value: trimmed(s.value) } : s));
        }

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

            // Previously-omitted user data + config. FK targets (users/series/issues) are all
            // restored above; older backups simply lack these keys and restoreTable no-ops on them.
            await restoreTable(backup.data.hosterAccounts, tx.hosterAccount);
            await restoreTable(backup.data.apiKeys, tx.apiKey);
            await restoreTable(backup.data.opdsKeys, tx.opdsKey);
            await restoreTable(backup.data.koreaderSyncs, tx.koreaderSync);
            await restoreTable(backup.data.favorites, tx.favorite);
            await restoreTable(backup.data.reviews, tx.review);
            await restoreTable(backup.data.bookmarks, tx.bookmark);
            await restoreTable(backup.data.dailyReadingStats, tx.dailyReadingStat);
            await restoreTable(backup.data.dailyIssueReads, tx.dailyIssueRead);
            await restoreTable(backup.data.auditLogs, tx.auditLog);

            // Permissions + per-user reader settings. FK targets (users/libraries/series) are all
            // restored above; older backups lack these keys and restoreTable no-ops on them.
            await restoreTable(backup.data.userLibraryAccess, tx.userLibraryAccess);
            await restoreTable(backup.data.readerPreferences, tx.readerPreference);
            // Generous limit: restore is a one-time op on an idle DB and large libraries are slow.
        }, { maxWait: 15000, timeout: 600000 });

        // --- UPDATED: Safely check if session exists for the audit log ---
        await AuditLogger.log(
            'DATABASE_RESTORE', 
            { message: "State overwritten from backup." }, 
            session?.user ? session.user.id : 'System'
        );

        // A folder the server can't use doesn't block the restore: a backup moved from a native
        // Windows install to Docker has C:\ paths everywhere (libraries, series folders, issue files)
        // and has to come in before they can be fixed. Say which ones, the way Settings would.
        const warnings: string[] = [];
        for (const lib of Array.isArray(data.libraries) ? data.libraries : []) {
            const problem = storedFolderProblem(lib?.path, { example: '/data/comics' });
            if (problem) warnings.push(`Root Path of library "${lib?.name || 'Unnamed'}": ${problem}`);
        }
        const downloadPath = (Array.isArray(data.settings) ? data.settings : []).find((s: unknown) => isRow(s) && s.key === 'download_path')?.value;
        if (typeof downloadPath === 'string' && downloadPath.trim()) {
            const problem = storedFolderProblem(downloadPath, { example: '/data/downloads' });
            if (problem) warnings.push(`Download Scan Root: ${problem}`);
        }
        for (const client of Array.isArray(data.downloadClients) ? data.downloadClients : []) {
            if (typeof client?.localPath !== 'string' || !client.localPath.trim()) continue;
            const problem = storedFolderProblem(client.localPath, { example: '/data/downloads' });
            if (problem) warnings.push(`Local Path of download client "${client.name || 'Unnamed'}": ${problem}`);
        }
        if (warnings.length > 0) {
            Logger.log(`[Database Restore] Restored, but these folders need fixing in Settings → Library & Files: ${warnings.join(' ')}`, 'warn');
        }

        return NextResponse.json({ success: true, warnings });

    } catch (error: unknown) {
        Logger.log(`[Database Restore] Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: "Restore failed: " + getErrorMessage(error) }, { status: 500 });
    }
}