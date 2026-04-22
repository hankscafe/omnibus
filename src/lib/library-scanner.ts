// src/lib/library-scanner.ts
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import { detectManga } from '@/lib/manga-detector';
import { parseComicInfo } from '@/lib/metadata-extractor';
import { Logger } from '@/lib/logger';

export const LibraryScanner = {
    async scan(): Promise<boolean | null> {
        const lockId = 'LIBRARY_SCAN_ACTIVE';
        const timeoutLimit = new Date(Date.now() - 10 * 60 * 1000); 
        
        const existingLock = await prisma.jobLock.findUnique({ where: { id: lockId } });
        if (existingLock && existingLock.lockedAt > timeoutLimit) {
            Logger.log("[Scan] Library scan already in progress. Skipping.", "warn");
            return null; 
        }

        await prisma.jobLock.upsert({
            where: { id: lockId },
            update: { lockedAt: new Date() },
            create: { id: lockId, lockedAt: new Date() }
        });

        try {
            Logger.log("[Scan] Starting automated library disk scan...", "info");
            const libraries = await prisma.library.findMany();
            for (const lib of libraries) {
                if (!fs.existsSync(lib.path)) {
                    Logger.log(`[Scan] Drive disconnected: ${lib.path}`, "error");
                    throw new Error(`Drive disconnected: ${lib.path}`);
                }
            }

            const allSeries = await prisma.series.findMany({ select: { id: true, folderPath: true } });
            const badIds: string[] = allSeries
                .filter(s => !s.folderPath || !fs.existsSync(s.folderPath))
                .map(s => s.id);

            if (badIds.length > 0) {
                await prisma.issue.deleteMany({ where: { seriesId: { in: badIds } } });
                await prisma.series.deleteMany({ where: { id: { in: badIds } } });
                Logger.log(`[Scan] Purged ${badIds.length} ghost series records.`, 'info');
            }

            const existingFolders = new Set(allSeries.map(s => path.normalize(s.folderPath || "").toLowerCase()));

            const findSeriesFolders = async (dir: string, baseRoot: string, libId: string, libIsManga: boolean) => {
                const folderName = path.basename(dir);
                if (folderName.startsWith('.')) return;

                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                const files = entries.filter(e => !e.isDirectory()).map(e => e.name);
                const bookFiles = files.filter(f => f.toLowerCase().match(/\.(cbz|cbr|zip)$/));

                if (bookFiles.length > 0) {
                    const normDir = path.normalize(dir).toLowerCase();
                    if (!existingFolders.has(normDir)) {
                        try {
                            const firstArchive = path.join(dir, bookFiles[0]);
                            const embeddedMeta = await parseComicInfo(firstArchive);

                            const cleanedName = embeddedMeta?.series || folderName.replace(/\s\(\d{4}\)$/, "").trim() || "Unknown Series";
                            const year = embeddedMeta?.year || parseInt(folderName.match(/\((\d{4})\)/)?.[1] || "0");
                            
                            await prisma.series.create({
                                data: {
                                    folderPath: dir.replace(/\\/g, '/'),
                                    name: cleanedName,
                                    year: year,
                                    publisher: embeddedMeta?.publisher || "Other",
                                    metadataId: embeddedMeta?.cvId?.toString() || `unmatched_${Math.random()}`,
                                    metadataSource: embeddedMeta?.cvId ? 'COMICVINE' : 'LOCAL',
                                    matchState: embeddedMeta?.cvId ? 'MATCHED' : 'UNMATCHED',
                                    cvId: embeddedMeta?.cvId || null,
                                    isManga: embeddedMeta?.isManga || libIsManga || await detectManga({ name: cleanedName }, firstArchive),
                                    libraryId: libId
                                }
                            });
                            Logger.log(`[Scan] Found and indexed new series: ${cleanedName}`, "success");
                        } catch(e) {}
                    }
                }
                
                const subDirs = entries.filter(e => e.isDirectory());
                for (const d of subDirs) {
                    await findSeriesFolders(path.join(dir, d.name), baseRoot, libId, libIsManga);
                }
            };

            for (const lib of libraries) {
                await findSeriesFolders(lib.path, lib.path, lib.id, lib.isManga);
            }
            
            Logger.log("[Scan] Library disk scan complete.", "success");
            return true;
        } finally {
            await prisma.jobLock.delete({ where: { id: lockId } }).catch(() => {});
        }
    }
};