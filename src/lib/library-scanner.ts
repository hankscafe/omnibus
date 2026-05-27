// src/lib/library-scanner.ts
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import { detectManga } from '@/lib/manga-detector';
import { parseComicInfo } from '@/lib/metadata-extractor';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export const LibraryScanner = {
    async scan(): Promise<boolean | null> {
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
            Logger.log("[Scan] Starting automated library disk scan...", "info");
            const libraries = await prisma.library.findMany();
            for (const lib of libraries) {
                if (!fs.existsSync(lib.path)) {
                    Logger.log(`[Scan] Drive disconnected: ${lib.path}`, "error");
                    throw new Error(`Drive disconnected: ${lib.path}`);
                }
            }

            // --- FIX: Smarter Ghost Series Detection ---
            const allSeries = await prisma.series.findMany({ 
                select: { id: true, folderPath: true, monitored: true, metadataId: true } 
            });
            
            const activeRequests = await prisma.request.findMany({
                where: { status: { notIn: ['COMPLETED', 'IMPORTED', 'CANCELLED'] } },
                select: { volumeId: true }
            });
            const activeReqVolumeIds = new Set(activeRequests.map(r => r.volumeId));

            const badIds: string[] = allSeries
                .filter(s => {
                    // If folder physically exists, it's good
                    if (s.folderPath && fs.existsSync(s.folderPath)) return false; 
                    // If the series is being monitored for new issues, keep it
                    if (s.monitored) return false;
                    // If the series has active/pending requests tied to it, keep it
                    if (s.metadataId && activeReqVolumeIds.has(s.metadataId)) return false;
                    
                    // Otherwise, the folder is gone and no one is looking for it -> Ghost
                    return true;
                })
                .map(s => s.id);

            if (badIds.length > 0) {
                await prisma.issue.deleteMany({ where: { seriesId: { in: badIds } } });
                await prisma.series.deleteMany({ where: { id: { in: badIds } } });
                Logger.log(`[Scan] Purged ${badIds.length} ghost series records.`, 'info');
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

            const existingFolders = new Set(allSeries.map(s => path.normalize(s.folderPath || "").toLowerCase()));

            // --- HELPER: Fast Issue Extraction ---
            function extractIssueNumber(filename: string): string {
                let clean = filename.replace(/\.\w+$/, ''); 
                clean = clean.replace(/\[\d{4}(?:-\d{4})?\]/g, '').replace(/\(\d{4}(?:-\d{4})?\)/g, ''); 
                const issueMatch = clean.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?[a-zA-Z]?)/i);
                if (issueMatch) return issueMatch[1].replace(/^0+(?=\d)/, '');
                const volMatch = clean.match(/(?:vol(?:ume)?\s*\.?|v\s*\.?)\s*0*(\d{1,3}(?:\.\d+)?[a-zA-Z]?)(?!\d)/i);
                if (volMatch) return volMatch[1].replace(/^0+(?=\d)/, '');
                const matches = [...clean.matchAll(/(?<=^|[^a-zA-Z0-9])0*(\d+(?:\.\d+)?[a-zA-Z]?)(?=[^a-zA-Z0-9]|$)/g)];
                if (matches.length > 0) {
                    for (let i = matches.length - 1; i >= 0; i--) {
                        const matchVal = matches[i][1].replace(/^0+(?=\d)/, '');
                        const numVal = parseFloat(matchVal);
                        if (numVal >= 1900 && numVal <= 2099 && !matchVal.match(/[a-zA-Z]/)) continue; 
                        return matchVal;
                    }
                }
                return "1"; 
            }

            const findSeriesFolders = async (dir: string, baseRoot: string, libId: string, libIsManga: boolean) => {
                const folderName = path.basename(dir);
                if (folderName.startsWith('.')) return;

                Logger.log(`[Scanner Debug] Traversing directory: ${dir}`, 'debug');

                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                const files = entries.filter(e => !e.isDirectory()).map(e => e.name);
                const bookFiles = files.filter(f => f.toLowerCase().match(/\.(cbz|cbr|zip)$/));

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

                            // --- NEW: Add fallbacks for older cache/mock objects ---
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

            for (const lib of libraries) {
                await findSeriesFolders(lib.path, lib.path, lib.id, lib.isManga);
            }
            
            Logger.log("[Scan] Library disk scan complete.", "success");
            return true;
        } finally {
            if (prisma.jobLock && typeof prisma.jobLock.delete === 'function') {
                await prisma.jobLock.delete({ where: { id: lockId } }).catch(() => {});
            }
        }
    }
};