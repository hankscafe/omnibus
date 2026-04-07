// src/lib/db-init.ts
import { prisma } from './db';
import { Logger } from './logger';
import { getErrorMessage } from './utils/error';
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

    Logger.log("[DB Init] Schema mapping complete.", "success");

  } catch (error: unknown) {
      Logger.log(`[DB Init] Failed to migrate configs: ${getErrorMessage(error)}`, "error");
  }
}