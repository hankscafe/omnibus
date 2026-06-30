// src/lib/metadata-fetcher.ts
import { apiClient as axios } from '@/lib/api-client';
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import { Logger } from './logger';
import { parseComicVineCredits } from '@/lib/utils';
import { getErrorMessage } from './utils/error';
import { MetronProvider } from './metadata/providers/metron';
import { omnibusQueue } from './queue';
import { markSystemFlag, logApiUsage } from './utils/system-flags';
import { isSameIssue } from '@/lib/utils/issue-parser';

// Providers rarely report when a series ends, so Omnibus guesses: no new issue
// within the admin-configured window (months) = Ended. Returns null when the
// guess is disabled (window of 0 / "Never").
async function getSeriesEndedCutoff(): Promise<{ cutoffMs: number, months: number } | null> {
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'series_ended_months' } });
    const parsed = parseInt(setting?.value || '18', 10);
    const months = isNaN(parsed) ? 18 : parsed;
    if (months <= 0) return null;
    return { cutoffMs: Date.now() - Math.round(months * 30.44 * 24 * 60 * 60 * 1000), months };
}

export async function syncSeriesMetadata(metadataId: string, folderPath: string, metadataSource: string = 'COMICVINE') {
    const series = await prisma.series.findFirst({ 
        where: { metadataId, metadataSource } 
    });
    if (!series) throw new Error("Series not found in database.");

    // Update this line:
    Logger.log(`[Metadata] Fetching data for: "${series.name}" (ID: ${metadataId} via ${metadataSource})`, 'info');

    if (metadataSource === 'METRON') {
        try {
            const metron = new MetronProvider();
            const details = await metron.getSeriesDetails(metadataId);
            
            if (!details) {
                Logger.log(`[Metadata] Details could not be fetched for ${series.name}. Skipping issue sync.`, 'warn');
                return { success: false, count: 0, skipped: true };
            }

            let metronFallbackCover = details.coverUrl || series.coverUrl;
            
            // --- FIX: Ensure folder exists so we can save the series cover locally ---
            if (folderPath && folderPath.trim() !== '') {
                if (!fs.existsSync(folderPath)) {
                    fs.mkdirSync(folderPath, { recursive: true });
                }
                const possibleCovers = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'Cover.jpg', 'Cover.png', 'folder.png'];
                for (const pc of possibleCovers) {
                    if (fs.existsSync(path.join(folderPath, pc))) {
                        metronFallbackCover = `/api/library/cover?path=${encodeURIComponent(path.join(folderPath, pc))}`;
                        break;
                    }
                }
            }

            let metronFinalCover = metronFallbackCover;

            if (details.coverUrl && folderPath && fs.existsSync(folderPath)) {
                try {
                    const imgRes = await axios.get<ArrayBuffer>(details.coverUrl, { responseType: 'arraybuffer' });
                    const contentType = String(imgRes.headers['content-type'] || '').toLowerCase();
                    const byteLength = imgRes.data.byteLength;
                    
                    if (contentType.includes('text/html') || byteLength < 1000) {
                        throw new Error(`Invalid image payload. Type: ${contentType}, Size: ${byteLength} bytes.`);
                    }

                    let ext = '.jpg';
                    if (contentType.includes('image/png')) ext = '.png';
                    if (contentType.includes('image/webp')) ext = '.webp';

                    const coverFileName = `cover${ext}`;
                    await fs.writeFile(path.join(folderPath, coverFileName), Buffer.from(imgRes.data));
                    metronFinalCover = `/api/library/cover?path=${encodeURIComponent(path.join(folderPath, coverFileName))}`;
                    
                } catch (e: unknown) {
                    Logger.log(`[Metadata] Failed to save new cover, keeping existing fallback: ${getErrorMessage(e)}`, 'warn');
                }
            }
            
            await prisma.series.update({
                where: { id: series.id },
                data: {
                    name: details.name,
                    publisher: details.publisher,
                    year: details.year || series.year,
                    universe: details.universe,
                    description: details.description,
                    coverUrl: metronFinalCover,
                    // Keep the remote URL for external consumers (series.json) — coverUrl is a local path
                    ...(details.coverUrl ? { remoteCoverUrl: details.coverUrl } : {}),
                    // Metron's series_type is authoritative, but never clobber a manual categorization
                    ...(details.bookType && !series.bookType ? { bookType: details.bookType } : {}),
                    status: details.status
                }
            });

            const issues = await metron.getSeriesIssues(metadataId);
            let syncedCount = 0;
            
            const allSeriesIssues = await prisma.issue.findMany({
                where: { seriesId: series.id }
            });

            let latestDateMs = 0;
            
            for (const issue of issues) {
                const issueNumStr = issue.issueNumber;

                const issueDate = issue.releaseDate;
                if (issueDate) {
                    const ts = new Date(issueDate).getTime();
                    if (!isNaN(ts) && ts > latestDateMs) latestDateMs = ts;
                }
                
                const existingByMetaId = await prisma.issue.findFirst({ 
                    where: { metadataId: issue.sourceId, metadataSource: 'METRON' } 
                });

                const existingByNum = allSeriesIssues.find(i => isSameIssue(i.number, issueNumStr));

                const targetRecord = existingByMetaId || existingByNum;
                const isLocked = (targetRecord as any)?.hasCustomMetadata || false;

                const issueDataPayload = {
                    name: isLocked ? targetRecord!.name : issue.name,
                    releaseDate: isLocked ? targetRecord!.releaseDate : issue.releaseDate,
                    description: issue.description,
                    coverUrl: issue.coverUrl,
                    writers: JSON.stringify(issue.writers),
                    artists: JSON.stringify(issue.artists),
                    characters: JSON.stringify(issue.characters),
                    matchState: 'MATCHED' 
                };

                if (existingByMetaId) {
                    await prisma.issue.update({
                        where: { id: existingByMetaId.id },
                        data: { seriesId: series.id, number: issueNumStr, ...issueDataPayload }
                    });
                } else if (existingByNum) {
                    await prisma.issue.update({
                        where: { id: existingByNum.id },
                        data: { metadataId: issue.sourceId, metadataSource: 'METRON', ...issueDataPayload }
                    });
                } else {
                    await prisma.issue.create({
                        data: {
                            seriesId: series.id, 
                            metadataId: issue.sourceId, 
                            metadataSource: 'METRON', 
                            number: issueNumStr, 
                            status: 'WANTED', 
                            ...issueDataPayload
                        }
                    });
                }
                syncedCount++;
            }

            if (details.status !== 'Ended' && latestDateMs > 0) {
                const endedWindow = await getSeriesEndedCutoff();
                if (endedWindow && latestDateMs < endedWindow.cutoffMs) {
                    await prisma.series.update({
                        where: { id: series.id },
                        data: { status: 'Ended' }
                    });
                    Logger.log(`[Metadata] Series "${series.name}" marked as Ended after ${endedWindow.months}+ months without a new issue.`, 'info');
                }
            }

            try {
                // 15-minute rolling window for heavy disk I/O
                const ioTimeWindow = Math.floor(Date.now() / 900000); 
                
                await omnibusQueue.add('EMBED_METADATA', { 
                    type: 'EMBED_METADATA', 
                    seriesId: series.id 
                }, {
                    jobId: `EMBED_META_${series.id}_${ioTimeWindow}`,
                    delay: 300000, // 5-minute delay to let the entire batch finish downloading
                    removeOnComplete: true,
                    removeOnFail: true
                });
                Logger.log(`[Metadata] Queued XML injection for ${series.name}`, 'info');
            } catch(e) {}

            Logger.log(`[Metadata] Successfully synced ${syncedCount} Metron issues.`, 'success');
            return { success: true, count: syncedCount };

        } catch (e: any) {
            if (e.response?.status === 429) await markSystemFlag('metron_rate_limit_time');
            throw e;
        }
    }

    const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
    if (!setting?.value) throw new Error("No ComicVine API Key configured.");

    Logger.log(`[Metadata Fetcher Debug] Requesting ComicVine Volume: https://comicvine.gamespot.com/api/volume/4050-${metadataId}/`, 'debug');
    
    let volRes;
    try {
        volRes = await axios.get<{ error?: string; results: any }>(`https://comicvine.gamespot.com/api/volume/4050-${metadataId}/`, {
            params: { api_key: setting.value, format: 'json', field_list: 'image,description,deck,publisher,start_year,name,person_credits,character_credits,concepts,end_year,count_of_issues' },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 15000
        });
        await logApiUsage('comicvine', '/volume');
    } catch (e: any) {
        if (e.response?.status === 429) await markSystemFlag('cv_rate_limit_time');
        throw e;
    }

    const volData = volRes.data.results;
    if (!volData) throw new Error("Volume data not found on ComicVine.");

    const imageUrl = volData.image?.medium_url || volData.image?.super_url;

    const { genres: volGenres } = parseComicVineCredits(undefined, undefined, volData.concepts || undefined);
    
    let cvFallbackCover = imageUrl || series.coverUrl;
    
    // --- FIX: Ensure folder exists so we can save the series cover locally ---
    if (folderPath && folderPath.trim() !== '') {
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
        }
        const possibleCovers = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'Cover.jpg', 'Cover.png', 'folder.png'];
        for (const pc of possibleCovers) {
            if (fs.existsSync(path.join(folderPath, pc))) {
                cvFallbackCover = `/api/library/cover?path=${encodeURIComponent(path.join(folderPath, pc))}`;
                break;
            }
        }
    }

    let cvFinalCover = cvFallbackCover;

    if (imageUrl && folderPath && fs.existsSync(folderPath)) {
        try {
            const imgRes = await axios.get<ArrayBuffer>(imageUrl, { responseType: 'arraybuffer' });
            const contentType = String(imgRes.headers['content-type'] || '').toLowerCase();
            const byteLength = imgRes.data.byteLength;
            
            if (contentType.includes('text/html') || byteLength < 1000) {
                throw new Error(`Invalid image payload. Type: ${contentType}, Size: ${byteLength} bytes.`);
            }

            let ext = '.jpg';
            if (contentType.includes('image/png')) ext = '.png';
            if (contentType.includes('image/webp')) ext = '.webp';

            const coverFileName = `cover${ext}`;
            await fs.writeFile(path.join(folderPath, coverFileName), Buffer.from(imgRes.data));
            cvFinalCover = `/api/library/cover?path=${encodeURIComponent(path.join(folderPath, coverFileName))}`;
            
        } catch (e: unknown) {
            Logger.log(`[Metadata] Failed to save new cover, keeping existing fallback: ${getErrorMessage(e)}`, 'warn');
        }
    }

    // ComicVine has no format field, so book type is a conservative guess: explicit
    // format hints in the volume name, or a finished single-issue volume = one-shot
    let guessedBookType: string | null = null;
    const volName = volData.name || '';
    if (/graphic novel|\bOGN\b/i.test(volName)) guessedBookType = 'GN';
    else if (/\bTPB\b|trade paperback|\bHC\b|hardcover/i.test(volName)) guessedBookType = 'TPB';
    else if (volData.count_of_issues === 1 && volData.end_year) guessedBookType = 'OneShot';

    await prisma.series.update({
        where: { id: series.id },
        data: {
            name: volData.name,
            publisher: volData.publisher?.name || 'Other',
            year: parseInt(volData.start_year || "0") || series.year,
            description: volData.description || volData.deck || null,
            coverUrl: cvFinalCover,
            // Keep the remote URL for external consumers (series.json) — coverUrl is a local path
            ...(imageUrl ? { remoteCoverUrl: imageUrl } : {}),
            // Heuristic only fills a blank — never clobber a manual categorization
            ...(guessedBookType && !series.bookType ? { bookType: guessedBookType } : {}),
            status: volData.end_year ? 'Ended' : 'Ongoing'
        }
    });

    await new Promise(r => setTimeout(r, 3000));

    let offset = 0;
    let totalResults = 1;
    let loopCount = 0;
    let syncedCount = 0;
    let issuesCallsMade = 0;

    Logger.log(`[Metadata Fetcher Debug] Fetching issues for volume "${series.name}" (ID: ${metadataId}, Offset: ${offset}, Limit: 100)`, 'debug');
    let latestDateMs = 0;
    while (offset < totalResults && loopCount < 20) {
        Logger.log(`[Metadata Fetcher Debug] Fetching issues for volume "${series.name}" (ID: ${metadataId}, Offset: ${offset}, Limit: 100)`, 'debug');
        let issueRes;
        try {
            issueRes = await axios.get<{ number_of_total_results: number; results: any[] }>(`https://comicvine.gamespot.com/api/issues/`, {
                params: {
                    api_key: setting.value, format: 'json', filter: `volume:${metadataId}`, sort: 'issue_number:asc', limit: 100, offset: offset,
                    field_list: 'id,name,issue_number,store_date,cover_date,image,deck,description'
                },
                headers: { 'User-Agent': 'Omnibus/1.0' },
                timeout: 15000
            });
            issuesCallsMade++;
        } catch (e: any) {
            if (issuesCallsMade > 0) await logApiUsage('comicvine', '/issues', issuesCallsMade); 
            if (e.response?.status === 429) await markSystemFlag('cv_rate_limit_time');
            throw e;
        }

        const data = issueRes.data;
        if (offset === 0) totalResults = data.number_of_total_results || 0;
        
        const cvIssues = data.results || [];

        const allSeriesIssuesForCv = await prisma.issue.findMany({
            where: { seriesId: series.id }
        });

        for (const cvIssue of cvIssues) {
            const issueNumStr = cvIssue.issue_number?.toString() || "0";

            const issueDate = cvIssue.store_date || cvIssue.cover_date || null;
            if (issueDate) {
                const ts = new Date(issueDate).getTime();
                if (!isNaN(ts) && ts > latestDateMs) latestDateMs = ts;
            }

            const existingByCvId = await prisma.issue.findFirst({ 
                where: { metadataId: cvIssue.id.toString(), metadataSource: 'COMICVINE' } 
            });

            const existingByNum = allSeriesIssuesForCv.find(i => isSameIssue(i.number, issueNumStr));

            const targetRecord = existingByCvId || existingByNum;
            const isLocked = (targetRecord as any)?.hasCustomMetadata || false;

            const issueDataPayload = {
                name: isLocked ? targetRecord!.name : cvIssue.name,
                releaseDate: isLocked ? targetRecord!.releaseDate : (cvIssue.store_date || cvIssue.cover_date || null),
                description: cvIssue.description || cvIssue.deck || null,
                coverUrl: cvIssue.image?.medium_url || cvIssue.image?.small_url || null,
                matchState: 'MATCHED'
            };

            const dynamicPayload: any = { ...issueDataPayload };
            if (volGenres.length > 0 && (!existingByCvId || !(existingByCvId as any).genres)) {
                dynamicPayload.genres = JSON.stringify(volGenres);
            }

            if (existingByCvId) {
                await prisma.issue.update({
                    where: { id: existingByCvId.id },
                    data: { seriesId: series.id, number: issueNumStr, ...dynamicPayload }
                });
            } else if (existingByNum) {
                await prisma.issue.update({
                    where: { id: existingByNum.id },
                    data: { metadataId: cvIssue.id.toString(), metadataSource: 'COMICVINE', ...dynamicPayload }
                });
            } else {
                await prisma.issue.create({
                    data: {
                        seriesId: series.id, 
                        metadataId: cvIssue.id.toString(), 
                        metadataSource: 'COMICVINE', 
                        number: issueNumStr, 
                        status: 'WANTED', 
                        ...dynamicPayload
                    }
                });
            }
            syncedCount++;
        }

        offset += 100;
        loopCount++;

        await new Promise(r => setTimeout(r, 3000));
    }
    // The loopCount<20 guard caps a sync at 2000 issues; warn (instead of silently clipping) when a volume
    // genuinely has more — latestDateMs and the 'Ended' heuristic would also be incomplete in that case.
    if (loopCount >= 20 && offset < totalResults) {
        Logger.log(`[Metadata Fetcher] "${series.name}" exceeded the 2000-issue sync cap (${offset}/${totalResults}); remaining issues were not synced this run.`, 'warn');
    }

    if (!volData.end_year && latestDateMs > 0) {
        const endedWindow = await getSeriesEndedCutoff();
        if (endedWindow && latestDateMs < endedWindow.cutoffMs) {
            await prisma.series.update({
                where: { id: series.id },
                data: { status: 'Ended' }
            });
            Logger.log(`[Metadata] Series "${series.name}" marked as Ended after ${endedWindow.months}+ months without a new issue.`, 'info');
        }
    }

    if (issuesCallsMade > 0) {
        await logApiUsage('comicvine', '/issues', issuesCallsMade);
    }

    try {
                // 15-minute rolling window for heavy disk I/O
                const ioTimeWindow = Math.floor(Date.now() / 900000); 
                
                await omnibusQueue.add('EMBED_METADATA', { 
                    type: 'EMBED_METADATA', 
                    seriesId: series.id 
                }, {
                    jobId: `EMBED_META_${series.id}_${ioTimeWindow}`,
                    delay: 300000, // 5-minute delay to let the entire batch finish downloading
                    removeOnComplete: true,
                    removeOnFail: true
                });
                Logger.log(`[Metadata] Queued XML injection for ${series.name}`, 'info');
            } catch(e) {}

    Logger.log(`[Metadata] Successfully synced ${syncedCount} ComicVine issues.`, 'success');
    return { success: true, count: syncedCount };
}