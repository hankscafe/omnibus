// src/lib/db-init.ts
import { prisma } from './db';
import { Logger } from './logger';
import { getErrorMessage } from './utils/error';
import { encryptSecret } from './encryption';
import { SECRET_SETTING_KEYS } from './secret-keys';
import crypto from 'crypto';

export async function initDatabase() {
  try {
    Logger.log("[DB Init] Checking for legacy configurations to migrate...", "info");

    // 0. Ensure Database Encryption Key Exists 
    const dbKeyCount = await prisma.systemSetting.count({ where: { key: 'DATABASE_ENCRYPTION_KEY' } });
    if (dbKeyCount === 0) {
        const newKey = crypto.randomBytes(32).toString('hex');
        await prisma.systemSetting.create({
            data: { key: 'DATABASE_ENCRYPTION_KEY', value: newKey }
        });
        Logger.log("[DB Init] Generated new persistent Database Encryption Key.", "success");
    }

    // 1. Migrate Libraries [cite: 118, 128]
    const libraryCount = await prisma.library.count();
    if (libraryCount === 0) {
        const libPath = await prisma.systemSetting.findUnique({ where: { key: 'library_path' } });
        const mangaPath = await prisma.systemSetting.findUnique({ where: { key: 'manga_library_path' } });

        let defaultLib = null;
        let defaultManga = null;

        if (libPath?.value) {
            defaultLib = await prisma.library.create({
                data: { name: "Standard Comics", path: libPath.value, isManga: false, isDefault: true }
            });
            await prisma.systemSetting.delete({ where: { key: 'library_path' } }).catch(()=>{});
        }

        if (mangaPath?.value) {
            defaultManga = await prisma.library.create({
                data: { name: "Manga", path: mangaPath.value, isManga: true, isDefault: true }
            });
            await prisma.systemSetting.delete({ where: { key: 'manga_library_path' } }).catch(()=>{});
        }

        if (defaultLib || defaultManga) {
            const series = await prisma.series.findMany();
            for (const s of series) {
                if (s.isManga && defaultManga) {
                    await prisma.series.update({ where: { id: s.id }, data: { libraryId: defaultManga.id } });
                } else if (!s.isManga && defaultLib) {
                    await prisma.series.update({ where: { id: s.id }, data: { libraryId: defaultLib.id } });
                }
            }
            Logger.log(`[DB Init] Migrated ${series.length} series to new Library structure.`, "success");
        }
    }

    // 2. Migrate Download Clients [cite: 118, 149]
    const clientCount = await prisma.downloadClient.count();
    if (clientCount === 0) {
        const clientSetting = await prisma.systemSetting.findUnique({ where: { key: 'download_clients_config' } });
        if (clientSetting?.value) {
            try {
                const clients = JSON.parse(clientSetting.value);
                for (const c of clients) {
                    Logger.log(`[DB Init Debug] Migrating legacy download client: ${c.name} (${c.type})`, 'debug');
                    await prisma.downloadClient.create({
                        data: {
                            name: c.name, type: c.type, protocol: c.protocol || 'Torrent',
                            url: c.url, user: c.user || null, pass: c.pass || null,
                            apiKey: c.apiKey || null, category: c.category || null,
                            remotePath: c.remotePath || null, localPath: c.localPath || null
                        }
                    });
                }
                await prisma.systemSetting.delete({ where: { key: 'download_clients_config' } }).catch(()=>{});
                Logger.log(`[DB Init] Migrated ${clients.length} Download Clients.`, "success");
            } catch(e) {}
        }
    }

    // 3. Migrate Discord Webhooks [cite: 118, 151]
    const webhookCount = await prisma.discordWebhook.count();
    if (webhookCount === 0) {
        const webhookSetting = await prisma.systemSetting.findUnique({ where: { key: 'discord_webhooks' } });
        if (webhookSetting?.value) {
            try {
                const hooks = JSON.parse(webhookSetting.value);
                for (const h of hooks) {
                    Logger.log(`[DB Init Debug] Migrating legacy Discord webhook: ${h.name}`, 'debug');
                    await prisma.discordWebhook.create({
                        data: {
                            name: h.name, url: h.url, isActive: h.isActive ?? true,
                            events: JSON.stringify(h.events || [])
                        }
                    });
                }
                await prisma.systemSetting.delete({ where: { key: 'discord_webhooks' } }).catch(()=>{});
                Logger.log(`[DB Init] Migrated ${hooks.length} Discord Webhooks.`, "success");
            } catch(e) {}
        }
    }

    // 4. Migrate Indexers [cite: 118, 152]
    const indexerCount = await prisma.indexer.count();
    if (indexerCount === 0) {
        const indexerSetting = await prisma.systemSetting.findUnique({ where: { key: 'prowlarr_indexers_config' } });
        if (indexerSetting?.value) {
            try {
                const indexers = JSON.parse(indexerSetting.value);
                for (const idx of indexers) {
                    Logger.log(`[DB Init Debug] Migrating legacy Prowlarr indexer: ${idx.name} (Priority: ${idx.priority ?? 25})`, 'debug');
                    await prisma.indexer.create({
                        data: {
                            id: idx.id, name: idx.name, protocol: idx.protocol || 'torrent',
                            priority: idx.priority ?? 25, seedTime: idx.seedTime ?? 0,
                            seedRatio: idx.seedRatio ?? 0, rss: idx.rss ?? true
                        }
                    });
                }
                await prisma.systemSetting.delete({ where: { key: 'prowlarr_indexers_config' } }).catch(()=>{});
                Logger.log(`[DB Init] Migrated ${indexers.length} Indexers.`, "success");
            } catch(e) {}
        }
    }

    // 5. Migrate Custom Headers [cite: 118, 152]
    const headerCount = await prisma.customHeader.count();
    if (headerCount === 0) {
        const headerSetting = await prisma.systemSetting.findUnique({ where: { key: 'custom_headers' } });
        if (headerSetting?.value) {
            try {
                const headers = JSON.parse(headerSetting.value);
                for (const h of headers) {
                    if (h.key && h.value) {
                        await prisma.customHeader.create({ data: { key: h.key, value: h.value } });
                    }
                }
                await prisma.systemSetting.delete({ where: { key: 'custom_headers' } }).catch(()=>{});
                Logger.log(`[DB Init] Migrated Custom Headers.`, "success");
            } catch(e) {}
        }
    }

    // 6. Migrate Acronyms [cite: 118, 152]
    const acronymCount = await prisma.searchAcronym.count();
    if (acronymCount === 0) {
        const acronymSetting = await prisma.systemSetting.findUnique({ where: { key: 'search_acronyms' } });
        if (acronymSetting?.value) {
            try {
                const acronyms = JSON.parse(acronymSetting.value);
                for (const a of acronyms) {
                    if (a.key && a.value) {
                        await prisma.searchAcronym.upsert({
                            where: { key: a.key },
                            update: { value: a.value },
                            create: { key: a.key, value: a.value }
                        });
                    }
                }
                await prisma.systemSetting.delete({ where: { key: 'search_acronyms' } }).catch(()=>{});
                Logger.log(`[DB Init] Migrated Search Acronyms.`, "success");
            } catch(e) {}
        }
    }

    // --- REFACTORED: 7. MIGRATION FOR METADATA SPLIT (cvId + matchState)  ---
    try {
        // Only target series that haven't been updated to the new structure yet
        const seriesToMigrate = await prisma.series.findMany({
            where: { matchState: { equals: 'UNMATCHED' } } 
        });

        if (seriesToMigrate.length > 0) {
            let migratedCount = 0;
            for (const s of seriesToMigrate) {
                Logger.log(`[DB Init Debug] Evaluating legacy metadata structure for Series ID: ${s.id} (Current MetadataID: ${s.metadataId})`, 'debug');
                // If old metadataId is purely numeric, it is a ComicVine ID
                if (s.metadataId && !isNaN(Number(s.metadataId))) {
                    await prisma.series.update({
                        where: { id: s.id },
                        data: {
                            cvId: parseInt(s.metadataId),
                            matchState: 'MATCHED'
                        }
                    });
                    migratedCount++;
                } 
                // If it starts with 'unmatched_', keep it as UNMATCHED state but clear numeric fields
                else if (s.metadataId && s.metadataId.startsWith('unmatched_')) {
                    await prisma.series.update({
                        where: { id: s.id },
                        data: { matchState: 'UNMATCHED', cvId: null }
                    });
                    migratedCount++;
                }
            }
            if (migratedCount > 0) {
                Logger.log(`[DB Init] Refactored metadata for ${migratedCount} Series.`, "success");
            }
        }

        // Apply same logic to Issues
        const issuesToMigrate = await prisma.issue.findMany({
            where: { matchState: { equals: 'UNMATCHED' } }
        });

        if (issuesToMigrate.length > 0) {
            let issueMigratedCount = 0;
            for (const i of issuesToMigrate) {
                Logger.log(`[DB Init Debug] Evaluating legacy metadata structure for Issue ID: ${i.id}`, 'debug');
                if (i.metadataId && !isNaN(Number(i.metadataId))) {
                    await prisma.issue.update({
                        where: { id: i.id },
                        data: {
                            cvId: parseInt(i.metadataId),
                            matchState: 'MATCHED'
                        }
                    });
                    issueMigratedCount++;
                }
            }
            if (issueMigratedCount > 0) {
                Logger.log(`[DB Init] Refactored metadata for ${issueMigratedCount} Issues.`, "success");
            }
        }
    } catch (e) {
        Logger.log(`[DB Init] Metadata ID Split Migration Failed: ${getErrorMessage(e)}`, "error");
    }

    // 8. Migrate Legacy Global Reading Lists
    try {
        const legacyLists = await prisma.readingList.findMany({
            where: { userId: null, isGlobal: false }
        });
        if (legacyLists.length > 0) {
            await prisma.readingList.updateMany({
                where: { userId: null },
                data: { isGlobal: true }
            });
            Logger.log(`[DB Init] Migrated ${legacyLists.length} legacy global reading lists.`, "success");
        }
    } catch (e) {
        Logger.log(`[DB Init] Legacy List Migration Failed: ${getErrorMessage(e)}`, "error");
    }

    // 9. Encrypt credential fields at rest (idempotent). Upgrades existing plaintext download-client
    //    and hoster-account credentials to AES-encrypted form; rows already carrying an enc:v1:/enc:v2:
    //    prefix are skipped, so this is a no-op on every subsequent boot.
    try {
        const needsEnc = (v: string | null) => !!v && !v.startsWith('enc:'); // already-encrypted (v1 or v2) → skip

        const clients = await prisma.downloadClient.findMany();
        let encClients = 0;
        for (const c of clients) {
            if (needsEnc(c.pass) || needsEnc(c.apiKey)) {
                await prisma.downloadClient.update({
                    where: { id: c.id },
                    data: {
                        ...(needsEnc(c.pass) ? { pass: await encryptSecret(c.pass) } : {}),
                        ...(needsEnc(c.apiKey) ? { apiKey: await encryptSecret(c.apiKey) } : {}),
                    }
                });
                encClients++;
            }
        }

        const hosters = await prisma.hosterAccount.findMany();
        let encHosters = 0;
        for (const h of hosters) {
            if (needsEnc(h.password) || needsEnc(h.apiKey)) {
                await prisma.hosterAccount.update({
                    where: { id: h.id },
                    data: {
                        ...(needsEnc(h.password) ? { password: await encryptSecret(h.password) } : {}),
                        ...(needsEnc(h.apiKey) ? { apiKey: await encryptSecret(h.apiKey) } : {}),
                    }
                });
                encHosters++;
            }
        }

        if (encClients > 0 || encHosters > 0) {
            Logger.log(`[DB Init] Encrypted credentials at rest for ${encClients} download client(s) and ${encHosters} hoster account(s).`, "success");
        }
    } catch (e) {
        Logger.log(`[DB Init] Credential encryption migration failed: ${getErrorMessage(e)}`, "error");
    }

    // 10. Encrypt SystemSetting credential values at rest (idempotent). Reads RAW values via
    //     $queryRaw to bypass the auto-decrypting Prisma extension; rows already carrying an
    //     enc:v1:/enc:v2: prefix are skipped, so this is a no-op on every subsequent boot.
    try {
        let encSettings = 0;
        for (const key of SECRET_SETTING_KEYS) {
            const rows = await prisma.$queryRaw<Array<{ value: string }>>`SELECT "value" FROM "SystemSetting" WHERE "key" = ${key}`;
            const raw = rows[0]?.value;
            if (raw && !raw.startsWith('enc:')) {
                const encrypted = await encryptSecret(raw);
                if (encrypted && encrypted !== raw) {
                    await prisma.systemSetting.update({ where: { key }, data: { value: encrypted } });
                    encSettings++;
                }
            }
        }
        if (encSettings > 0) {
            Logger.log(`[DB Init] Encrypted ${encSettings} SystemSetting credential value(s) at rest.`, "success");
        }
    } catch (e) {
        Logger.log(`[DB Init] SystemSetting credential encryption migration failed: ${getErrorMessage(e)}`, "error");
    }

    // 11. One-time backfill for the new `canRequest` gate. Pre-existing users could always make
    //     requests, so grant them canRequest=true to preserve that ability; users created AFTER this
    //     runs default to canRequest=false ("Civilian") via the schema default + the creation paths.
    //     A SystemSetting sentinel ensures this executes exactly once (so an admin who later demotes a
    //     user to Civilian isn't re-granted on the next boot).
    try {
        const CANREQUEST_SENTINEL = 'perm_canrequest_backfilled';
        const alreadyDone = await prisma.systemSetting.findUnique({ where: { key: CANREQUEST_SENTINEL } });
        if (!alreadyDone) {
            const res = await prisma.user.updateMany({ data: { canRequest: true } });
            await prisma.systemSetting.create({ data: { key: CANREQUEST_SENTINEL, value: new Date().toISOString() } });
            Logger.log(`[DB Init] Backfilled canRequest=true for ${res.count} existing user(s).`, "success");
        }
    } catch (e) {
        Logger.log(`[DB Init] canRequest backfill failed: ${getErrorMessage(e)}`, "error");
    }

    // 12. One-time backfill for per-library access. Before this feature every user saw every library, so
    //     grant all current users access to every library to preserve that. New users created afterward are
    //     seeded with the default Comics library at creation time. Sentinel-guarded to run exactly once, and
    //     only once libraries actually exist (fresh installs create libraries later via the setup wizard).
    try {
        const LIBRARY_SENTINEL = 'perm_library_backfilled';
        const libDone = await prisma.systemSetting.findUnique({ where: { key: LIBRARY_SENTINEL } });
        if (!libDone) {
            const allLibs = await prisma.library.findMany({ select: { id: true } });
            if (allLibs.length > 0) {
                const allUsers = await prisma.user.findMany({ select: { id: true } });
                const rows = allUsers.flatMap(u => allLibs.map(l => ({ userId: u.id, libraryId: l.id })));
                if (rows.length > 0) {
                    // No skipDuplicates (unsupported on SQLite): this sentinel-guarded backfill runs
                    // once, and access rows for these users don't exist yet — filter defensively so a
                    // stray pre-existing grant can't throw and wedge startup.
                    const existing = await prisma.userLibraryAccess.findMany({ select: { userId: true, libraryId: true } });
                    const have = new Set(existing.map(r => `${r.userId}:${r.libraryId}`));
                    const fresh = rows.filter(r => !have.has(`${r.userId}:${r.libraryId}`));
                    if (fresh.length > 0) await prisma.userLibraryAccess.createMany({ data: fresh });
                }
                await prisma.systemSetting.create({ data: { key: LIBRARY_SENTINEL, value: new Date().toISOString() } });
                Logger.log(`[DB Init] Backfilled library access for ${allUsers.length} user(s) across ${allLibs.length} library(ies).`, "success");
            }
        }
    } catch (e) {
        Logger.log(`[DB Init] Library access backfill failed: ${getErrorMessage(e)}`, "error");
    }

    // 13. Flag the primary Comics library as "default access" so new users keep getting it by default now
    //     that the default is admin-controlled (preserves the prior getDefaultLibraryIds behavior).
    //     Sentinel-guarded; runs once, only after libraries exist.
    try {
        const DEFAULT_ACCESS_SENTINEL = 'lib_default_access_backfilled';
        const daDone = await prisma.systemSetting.findUnique({ where: { key: DEFAULT_ACCESS_SENTINEL } });
        if (!daDone) {
            const libs = await prisma.library.findMany({ select: { id: true, isManga: true, isDefault: true } });
            if (libs.length > 0) {
                const comics = libs.filter(l => !l.isManga);
                const flagged = comics.filter(l => l.isDefault);
                const ids = (flagged.length ? flagged : comics).map(l => l.id);
                if (ids.length > 0) {
                    await prisma.library.updateMany({ where: { id: { in: ids } }, data: { defaultAccess: true } });
                }
                await prisma.systemSetting.create({ data: { key: DEFAULT_ACCESS_SENTINEL, value: new Date().toISOString() } });
                Logger.log(`[DB Init] Flagged ${ids.length} Comics library(ies) as default-access for new users.`, "success");
            }
        }
    } catch (e) {
        Logger.log(`[DB Init] Default-access flag backfill failed: ${getErrorMessage(e)}`, "error");
    }

    // Inside initDatabase(), right before Logger.log("[DB Init] Schema mapping complete.")
    const logLevelSetting = await prisma.systemSetting.findUnique({ where: { key: 'system_log_level' } });
    if (logLevelSetting?.value) {
        Logger.setLevel(logLevelSetting.value as 'info' | 'debug');
    }

    Logger.log("[DB Init] Schema mapping complete.", "success");

  } catch (error: unknown) {
      Logger.log(`[DB Init] Failed to migrate configs: ${getErrorMessage(error)}`, "error");
  }
}