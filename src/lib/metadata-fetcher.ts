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

export async function syncSeriesMetadata(metadataId: string, folderPath: string, metadataSource: string = 'COMICVINE') {
    const series = await prisma.series.findFirst({ 
        where: { metadataId, metadataSource } 
    });
    if (!series) throw new Error("Series not found in database.");

    Logger.log(`[Metadata] Fetching data for ID: ${metadataId} via ${metadataSource}`, 'info');

    if (metadataSource === 'METRON') {
        try {
            const metron = new MetronProvider();
            const details = await metron.getSeriesDetails(metadataId);
            
            let finalCoverUrl = details.coverUrl;

            // --- FIX: Check if we already have a local cover. Prioritize it to heal the database.
            if (folderPath && fs.existsSync(folderPath)) {
                const possibleCovers = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'Cover.jpg', 'Cover.png', 'folder.png'];
                for (const pc of possibleCovers) {
                    if (fs.existsSync(path.join(folderPath, pc))) {
                        finalCoverUrl = `/api/library/cover?path=${encodeURIComponent(path.join(folderPath, pc))}`;
                        break;
                    }
                }
            }

            if (details.coverUrl && folderPath && fs.existsSync(folderPath)) {
                try {
                    const imgRes = await axios.get<ArrayBuffer>(details.coverUrl, { responseType: 'arraybuffer' });
                    await fs.writeFile(path.join(folderPath, 'cover.jpg'), Buffer.from(imgRes.data));
                    finalCoverUrl = `/api/library/cover?path=${encodeURIComponent(path.join(folderPath, 'cover.jpg'))}`;
                } catch (e) {}
            }
            
            await prisma.series.update({
                where: { id: series.id },
                data: {
                    name: details.name,
                    publisher: details.publisher,
                    year: details.year || series.year,
                    description: details.description,
                    coverUrl: finalCoverUrl, 
                    status: details.status
                }
            });

            const issues = await metron.getSeriesIssues(metadataId);
            let syncedCount = 0;
            
            for (const issue of issues) {
                const issueNumStr = issue.issueNumber;
                
                const existingByMetaId = await prisma.issue.findFirst({ 
                    where: { metadataId: issue.sourceId, metadataSource: 'METRON' } 
                });

                const existingByNum = await prisma.issue.findFirst({
                    where: { seriesId: series.id, number: issueNumStr }
                });

                // NEW: Check if the record exists and is locked by the Admin
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
                    matchState: 'DEEP_SYNCED' 
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

            try {
                await omnibusQueue.add('EMBED_METADATA', { type: 'EMBED_METADATA', seriesId: series.id }, {
                    jobId: `EMBED_META_${series.id}_${Date.now()}`
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

    let volRes;
    try {
        volRes = await axios.get<{ error?: string; results: any }>(`https://comicvine.gamespot.com/api/volume/4050-${metadataId}/`, {
            params: { api_key: setting.value, format: 'json', field_list: 'image,description,deck,publisher,start_year,name,person_credits,character_credits,concepts,end_year' },
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

    let finalCoverUrl = imageUrl;
    
    // --- FIX: Check if we already have a local cover. Prioritize it to heal the database.
    if (folderPath && fs.existsSync(folderPath)) {
        const possibleCovers = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'Cover.jpg', 'Cover.png', 'folder.png'];
        for (const pc of possibleCovers) {
            if (fs.existsSync(path.join(folderPath, pc))) {
                finalCoverUrl = `/api/library/cover?path=${encodeURIComponent(path.join(folderPath, pc))}`;
                break;
            }
        }
    }

    // Attempt to fetch fresh metadata from CV, but don't overwrite the local DB path proxy if it fails
    if (imageUrl && folderPath && fs.existsSync(folderPath)) {
        try {
            const imgRes = await axios.get<ArrayBuffer>(imageUrl, { responseType: 'arraybuffer' });
            await fs.writeFile(path.join(folderPath, 'cover.jpg'), Buffer.from(imgRes.data));
            finalCoverUrl = `/api/library/cover?path=${encodeURIComponent(path.join(folderPath, 'cover.jpg'))}`;
        } catch (e: unknown) {
            Logger.log(`[Metadata] Failed to save cover image locally: ${getErrorMessage(e)}`, 'warn');
        }
    }

    await prisma.series.update({
        where: { id: series.id },
        data: {
            name: volData.name,
            publisher: volData.publisher?.name || 'Other',
            year: parseInt(volData.start_year || "0") || series.year,
            description: volData.description || volData.deck || null,
            coverUrl: finalCoverUrl, 
            status: volData.end_year ? 'Ended' : 'Ongoing' 
        }
    });

    await new Promise(r => setTimeout(r, 3000));

    let offset = 0;
    let totalResults = 1;
    let loopCount = 0;
    let syncedCount = 0;
    let issuesCallsMade = 0;

    while (offset < totalResults && loopCount < 20) {
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

        for (const cvIssue of cvIssues) {
            const issueNumStr = cvIssue.issue_number?.toString() || "0";

            const existingByCvId = await prisma.issue.findFirst({ 
                where: { metadataId: cvIssue.id.toString(), metadataSource: 'COMICVINE' } 
            });

            const existingByNum = await prisma.issue.findFirst({
                where: { seriesId: series.id, number: issueNumStr }
            });

            // NEW: Check if the record exists and is locked by the Admin
            const targetRecord = existingByCvId || existingByNum;
            const isLocked = (targetRecord as any)?.hasCustomMetadata || false;

            const issueDataPayload = {
                // If locked, keep the existing name/date. Otherwise, use CV's data.
                name: isLocked ? targetRecord!.name : cvIssue.name,
                releaseDate: isLocked ? targetRecord!.releaseDate : (cvIssue.store_date || cvIssue.cover_date || null),
                description: cvIssue.description || cvIssue.deck || null,
                coverUrl: cvIssue.image?.medium_url || cvIssue.image?.small_url || null,
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

    if (issuesCallsMade > 0) {
        await logApiUsage('comicvine', '/issues', issuesCallsMade);
    }

    try {
        await omnibusQueue.add('EMBED_METADATA', { type: 'EMBED_METADATA', seriesId: series.id }, {
            jobId: `EMBED_META_${series.id}_${Date.now()}`
        });
        Logger.log(`[Metadata] Queued XML injection for ${series.name}`, 'info');
    } catch(e) {}

    Logger.log(`[Metadata] Successfully synced ${syncedCount} ComicVine issues.`, 'success');
    return { success: true, count: syncedCount };
}