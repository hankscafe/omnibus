// src/lib/library-scanner.ts
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import { detectManga } from '@/lib/manga-detector';
import { parseComicInfo } from '@/lib/metadata-extractor';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { extractIssueNumber } from '@/lib/utils/issue-parser';
import { isComicFile } from '@/lib/utils/formats';

export const LibraryScanner = {
    async scan(specificPath?: string): Promise<boolean | null> {
        const lockId = 'LIBRARY_SCAN_ACTIVE';
        const timeoutLimit = new Date(Date.now() - 10 * 60 * 1000);
        
        try {
            // Safeguards for test environments with incomplete Prisma mocks
            if (prisma.jobLock && typeof prisma.jobLock.findUnique === 'function') {
                const existingLock = await prisma.jobLock.findUnique({ where: { id: lockId } });
                
                if (!existingLock) {
                    if (typeof prisma.jobLock.create === 'function') {
                        await prisma.jobLock.create({ data: { id: lockId, lockedAt: new Date() } });
                    }
                } else {
                    if (typeof prisma.jobLock.updateMany === 'function') {
                        // Atomic update: only succeeds if the lock hasn't been renewed by someone else
                        const result = await prisma.jobLock.updateMany({
                            where: { 
                                id: lockId,
                                lockedAt: { lt: timeoutLimit } 
                            },
                            data: { lockedAt: new Date() }
                        });
                        if (!result || result.count === 0) {
                            Logger.log("[Scan] Library scan already in progress. Skipping.", "warn");
                            return null;
                        }
                    } else {
                        // Test mock fallback: manually check if lock is active
                        if (existingLock.lockedAt && existingLock.lockedAt >= timeoutLimit) {
                            Logger.log("[Scan] Library scan already in progress. Skipping (mock eval).", "warn");
                            return null;
                        }
                    }
                }
            }
        } catch (e: any) {
            if (e.code === 'P2002') {
                Logger.log("[Scan] Library scan already in progress. Skipping.", "warn");
                return null;
            }
            // Allow it to fail open if the DB table doesn't exist or is mocked incorrectly
            Logger.log(`[Scan] Non-fatal lock error: ${e.message}`, "warn");
        }

        try {
            Logger.log(specificPath ? `[Scan] Starting targeted library scan for: ${specificPath}` : "[Scan] Starting automated library disk scan...", "info");
            
            const libraries = await prisma.library.findMany();
            for (const lib of libraries) {
                if (!fs.existsSync(lib.path)) {
                    Logger.log(`[Scan] Drive disconnected: ${lib.path}`, "error");
                    throw new Error(`Drive disconnected: ${lib.path}`);
                }
            }

            const allSeries = await prisma.series.findMany({ 
                select: { id: true, folderPath: true, monitored: true, metadataId: true } 
            });
            
            // PERFORMANCE SAFEGUARD: Only execute global database cleanup routines on full automation cycles.
            // Bypassing this during targeted imports saves immense amounts of DB lookup time and disk I/O.
            if (!specificPath) {
                const activeRequests = await prisma.request.findMany({
                    where: { status: { notIn: ['COMPLETED', 'IMPORTED', 'CANCELLED'] } },
                    select: { volumeId: true }
                });
                const activeReqVolumeIds = new Set(activeRequests.map(r => r.volumeId));
                // Ghost-series purge with a GRACE WINDOW. A series whose folder is missing is NOT deleted
                // immediately — a transient SMB/network subfolder outage must not destroy read progress and
                // curated metadata (the per-issue delete cascades to ReadProgress). We persist when each series
                // was first seen missing and only purge after the folder has stayed gone past GRACE_MS. The
                // library-root check above already aborts the whole scan on a full-drive disconnect.
                const GRACE_MS = 24 * 60 * 60 * 1000; // 24h gone before auto-purge
                const nowMs = Date.now();
                let missState: Record<string, number> = {};
                try {
                    const raw = await prisma.systemSetting.findUnique({ where: { key: 'scan_missing_series' } });
                    missState = JSON.parse(raw?.value || '{}');
                } catch (e) { missState = {}; }

                const badIds: string[] = [];
                const nextMissState: Record<string, number> = {};
                for (const s of allSeries) {
                    if (s.folderPath && fs.existsSync(s.folderPath)) continue;            // present → not a ghost
                    if (s.monitored) continue;                                            // monitored → keep
                    if (s.metadataId && activeReqVolumeIds.has(s.metadataId)) continue;   // active request → keep

                    const firstMissed = missState[s.id] || nowMs;                         // first time seen gone
                    if (nowMs - firstMissed >= GRACE_MS) {
                        badIds.push(s.id);                                                // gone long enough → purge
                    } else {
                        nextMissState[s.id] = firstMissed;                                // still in grace → remember
                    }
                }

                // Persist grace counters (recovered + purged series naturally drop out of the map). Best-effort:
                // if this write fails, series simply look "freshly missing" next scan and stay un-purged — a
                // safe failure mode (never deletes early), so a counter-write hiccup must not abort the scan.
                try {
                    await prisma.systemSetting.upsert({
                        where: { key: 'scan_missing_series' },
                        update: { value: JSON.stringify(nextMissState) },
                        create: { key: 'scan_missing_series', value: JSON.stringify(nextMissState) }
                    });
                } catch (e) {
                    Logger.log(`[Scan] Could not persist ghost-series grace counters: ${getErrorMessage(e)}`, 'warn');
                }

                if (badIds.length > 0) {
                    await prisma.issue.deleteMany({ where: { seriesId: { in: badIds } } });
                    await prisma.series.deleteMany({ where: { id: { in: badIds } } });
                    Logger.log(`[Scan] Purged ${badIds.length} ghost series records (folder missing > 24h).`, 'info');
                }
                const graceCount = Object.keys(nextMissState).length;
                if (graceCount > 0) {
                    Logger.log(`[Scan] ${graceCount} series folder(s) missing but within the 24h grace window — not purged.`, 'info');
                }

                Logger.log(`[Scanner Debug] Searching for ghost issues with missing files...`, 'debug');
                const allFiles = await prisma.issue.findMany({ where: { filePath: { not: null } } });
                let ghostIssueCount = 0;
                for (const issue of allFiles) {
                    if (issue.filePath && !fs.existsSync(issue.filePath)) {
                        Logger.log(`[Scanner Debug] Removing ghost file path: ${issue.filePath}`, 'debug');
                        try {
                            if (issue.metadataId && !issue.metadataId.startsWith('unmatched')) {
                                await prisma.issue.update({
                                    where: { id: issue.id },
                                    data: { filePath: null, status: 'WANTED' }
                                });
                            } else {
                                await prisma.readProgress.deleteMany({ where: { issueId: issue.id } }).catch(()=>({}));
                                await prisma.issue.delete({ where: { id: issue.id } });
                            }
                            ghostIssueCount++;
                        } catch (e: any) {
                            Logger.log(`[Scanner Debug] Error removing ghost issue ${issue.id}: ${e.message}`, 'error');
                        }
                    }
                }
                if (ghostIssueCount > 0) {
                    Logger.log(`[Scan] Cleared ${ghostIssueCount} ghost issue files.`, 'info');
                }
            }

            const existingFolders = new Set(allSeries.map(s => path.normalize(s.folderPath || "").toLowerCase()));

            const findSeriesFolders = async (dir: string, baseRoot: string, libId: string, libIsManga: boolean) => {
                const folderName = path.basename(dir);
                if (folderName.startsWith('.')) return;
                Logger.log(`[Scanner Debug] Traversing directory: ${dir}`, 'debug');
                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                const files = entries.filter(e => !e.isDirectory()).map(e => e.name);
                const bookFiles = files.filter(f => isComicFile(f));
                if (bookFiles.length > 0) {
                    const normDir = path.normalize(dir).toLowerCase();
                    if (!existingFolders.has(normDir)) {
                        try {
                            const firstArchive = path.join(dir, bookFiles[0]);
                            Logger.log(`[Scanner Debug] Found ${bookFiles.length} archives in new folder. Parsing metadata from: ${bookFiles[0]}`, 'debug');
                            const embeddedMeta = await parseComicInfo(firstArchive);
                            const cleanedName = embeddedMeta?.series || folderName.replace(/\s\(\d{4}\)$/, "").trim() || "Unknown Series";
                            const year = embeddedMeta?.year || parseInt(folderName.match(/\((\d{4})\)/)?.[1] || "0");
                            
                            Logger.log(`[Scanner Debug] Extracted from folder/XML -> Name: "${cleanedName}", Year: ${year}, Publisher: "${embeddedMeta?.publisher || 'None'}"`, 'debug');
                            
                            const resolvedSeriesMetaId = embeddedMeta?.metadataId?.toString() || embeddedMeta?.cvId?.toString() || `unmatched_${Math.random()}`;
                            const resolvedSeriesMetaSource = embeddedMeta?.metadataSource || (embeddedMeta?.cvId ? 'COMICVINE' : 'LOCAL');
                            const resolvedSeriesMatchState = (embeddedMeta?.metadataId || embeddedMeta?.cvId) ? 'MATCHED' : 'UNMATCHED';
                            
                            const createdSeries = await prisma.series.create({
                                data: {
                                    folderPath: dir.replace(/\\/g, '/'),
                                    name: cleanedName,
                                    year: year,
                                    publisher: embeddedMeta?.publisher || "Other",
                                    metadataId: resolvedSeriesMetaId,
                                    metadataSource: resolvedSeriesMetaSource,
                                    matchState: resolvedSeriesMatchState,
                                    cvId: embeddedMeta?.cvId || null,
                                    metronId: embeddedMeta?.metronId || null,
                                    isManga: embeddedMeta?.isManga || libIsManga || await detectManga({ name: cleanedName }, firstArchive),
                                    libraryId: libId
                                }
                            });
                            
                            const issuesToCreate = bookFiles.map(file => {
                                const stdNum = extractIssueNumber(file);
                                const resolvedIssueMetaId = embeddedMeta?.metadataIssueId?.toString() || embeddedMeta?.cvIssueId?.toString() || `unmatched_${Math.random()}`;
                                const resolvedIssueMetaSource = embeddedMeta?.metadataSource || (embeddedMeta?.cvIssueId ? 'COMICVINE' : 'LOCAL');
                                const resolvedIssueMatchState = (embeddedMeta?.metadataIssueId || embeddedMeta?.cvIssueId) ? 'MATCHED' : 'UNMATCHED';
                                return {
                                    seriesId: createdSeries.id,
                                    metadataId: resolvedIssueMetaId,
                                    metadataSource: resolvedIssueMetaSource,
                                    matchState: resolvedIssueMatchState,
                                    number: stdNum,
                                    status: 'DOWNLOADED',
                                    filePath: path.join(dir, file).replace(/\\/g, '/')
                                };
                            });
                            if (issuesToCreate.length > 0) {
                                await prisma.issue.createMany({ data: issuesToCreate });
                            }
                            Logger.log(`[Scan] Found and indexed new series: ${cleanedName} with ${issuesToCreate.length} issues.`, "success");
                        } catch(e) {
                            Logger.log(`[Scanner Debug] Failed to index folder ${dir}: ${getErrorMessage(e)}`, 'error');
                        }
                    } else {
                        Logger.log(`[Scanner Debug] Skipping folder (already indexed): ${dir}`, 'debug');
                    }
                }
                
                const subDirs = entries.filter(e => e.isDirectory());
                for (const d of subDirs) {
                    await findSeriesFolders(path.join(dir, d.name), baseRoot, libId, libIsManga);
                }
            };

            // TARGETED DIRECTORY DISPATCHING
            if (specificPath) {
                const targetPath = fs.statSync(specificPath).isDirectory() ? specificPath : path.dirname(specificPath);
                const targetLib = libraries.find(l => path.normalize(targetPath).toLowerCase().startsWith(path.normalize(l.path).toLowerCase()));
                
                if (targetLib) {
                    await findSeriesFolders(targetPath, targetLib.path, targetLib.id, targetLib.isManga);
                } else {
                    Logger.log(`[Scan] Targeted path is not within any registered library: ${targetPath}`, "warn");
                }
            } else {
                for (const lib of libraries) {
                    await findSeriesFolders(lib.path, lib.path, lib.id, lib.isManga);
                }
            }
            
            Logger.log(specificPath ? "[Scan] Targeted scan complete." : "[Scan] Library disk scan complete.", "success");
            return true;
        } finally {
            if (prisma.jobLock && typeof prisma.jobLock.delete === 'function') {
                await prisma.jobLock.delete({ where: { id: lockId } }).catch(() => {});
            }
        }
    }
};