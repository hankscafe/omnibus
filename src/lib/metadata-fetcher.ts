import axios from 'axios';
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import { Logger } from './logger';
import { parseComicVineCredits } from '@/lib/utils';
import { getErrorMessage } from './utils/error';
import { MangaDexProvider } from './metadata/providers/mangadex';
import { sanitizeDescription } from './utils/sanitize'; //

export async function syncSeriesMetadata(metadataId: string, folderPath: string, metadataSource: string = 'COMICVINE') {
    const series = await prisma.series.findFirst({ 
        where: { metadataId, metadataSource } 
    });
    if (!series) throw new Error("Series not found in database.");

    Logger.log(`[Metadata] Fetching data for ID: ${metadataId} via ${metadataSource}`, 'info');

    // -------------------------------------------------------------
    // MANGADEX ENGINE
    // -------------------------------------------------------------
    if (metadataSource === 'MANGADEX') {
        const md = new MangaDexProvider();
        const details = await md.getSeriesDetails(metadataId);
        
        let finalCoverUrl = details.coverUrl;
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
                description: sanitizeDescription(details.description), // SECURITY FIX
                coverUrl: finalCoverUrl, 
                status: details.status
            }
        });

        const issues = await md.getSeriesIssues(metadataId);
        for (const issue of issues) {
            const issueNumStr = issue.issueNumber;
            const existingByMetaId = await prisma.issue.findFirst({ 
                where: { metadataId: issue.sourceId, metadataSource: 'MANGADEX' } 
            });

            const issueDataPayload = {
                name: issue.name,
                description: sanitizeDescription(issue.description), // SECURITY FIX
                releaseDate: issue.releaseDate,
                coverUrl: issue.coverUrl,
                writers: JSON.stringify(issue.writers),
                artists: JSON.stringify(issue.artists),
                characters: JSON.stringify(issue.characters),
                genres: "[]",
                storyArcs: "[]", 
            };

            if (existingByMetaId) {
                await prisma.issue.update({
                    where: { id: existingByMetaId.id },
                    data: { seriesId: series.id, number: issueNumStr, ...issueDataPayload }
                });
            } else {
                await prisma.issue.create({
                    data: {
                        seriesId: series.id, 
                        metadataId: issue.sourceId, 
                        metadataSource: 'MANGADEX', 
                        number: issueNumStr, 
                        status: 'WANTED', 
                        ...issueDataPayload
                    }
                });
            }
        }

        Logger.log(`[Metadata] Successfully synced MangaDex issues.`, 'success');
        return { success: true };
    }

    // -------------------------------------------------------------
    // COMICVINE ENGINE
    // -------------------------------------------------------------
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
    if (!setting?.value) throw new Error("No ComicVine API Key configured.");

    const volRes = await axios.get(`https://comicvine.gamespot.com/api/volume/4050-${metadataId}/`, {
        params: { api_key: setting.value, format: 'json', field_list: 'image,description,deck,publisher,start_year,name,person_credits,character_credits,concepts,end_year' },
        headers: { 'User-Agent': 'Omnibus/1.0' },
        timeout: 15000
    });

    const volData = volRes.data.results;
    if (!volData) throw new Error("Volume data not found on ComicVine.");

    const imageUrl = volData.image?.medium_url || volData.image?.super_url;
    const { writers: volWriters, artists: volArtists, characters: volCharacters, genres: volGenres } = parseComicVineCredits(volData.person_credits || undefined);

    let finalCoverUrl = imageUrl;
    if (imageUrl && folderPath && fs.existsSync(folderPath)) {
        try {
            const imgRes = await axios.get<ArrayBuffer>(imageUrl, { responseType: 'arraybuffer' });
            await fs.writeFile(path.join(folderPath, 'cover.jpg'), Buffer.from(imgRes.data));
            finalCoverUrl = `/api/library/cover?path=${encodeURIComponent(path.join(folderPath, 'cover.jpg'))}`;
        } catch (e: unknown) {
            Logger.log(`[Metadata] Failed to save cover image locally`, 'warn');
        }
    }

    await prisma.series.update({
        where: { id: series.id },
        data: {
            name: volData.name,
            publisher: volData.publisher?.name || 'Other',
            year: parseInt(volData.start_year || "0") || series.year,
            description: sanitizeDescription(volData.description || volData.deck), // SECURITY FIX
            coverUrl: finalCoverUrl,
            status: volData.end_year ? 'Ended' : 'Ongoing' 
        }
    });

    await new Promise(r => setTimeout(r, 1500));

    let offset = 0;
    let totalResults = 1;

    while (offset < totalResults) {
        const issueRes = await axios.get(`https://comicvine.gamespot.com/api/issues/`, {
            params: {
                api_key: setting.value, format: 'json', filter: `volume:${metadataId}`, sort: 'issue_number:asc', limit: 100, offset: offset,
                field_list: 'id,name,issue_number,store_date,cover_date,image,deck,description,person_credits,character_credits,concepts,story_arc_credits'
            },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 15000
        });

        const data = issueRes.data;
        if (offset === 0) totalResults = data.number_of_total_results || 0;
        const cvIssues = data.results || [];

        for (const cvIssue of cvIssues) {
            const { writers, artists, characters, genres, storyArcs } = parseComicVineCredits(cvIssue.person_credits || undefined);
            const issueNumStr = cvIssue.issue_number?.toString() || "0";

            const existingByCvId = await prisma.issue.findFirst({ 
                where: { metadataId: cvIssue.id.toString(), metadataSource: 'COMICVINE' } 
            });

            const issueDataPayload = {
                name: cvIssue.name,
                description: sanitizeDescription(cvIssue.description || cvIssue.deck), // SECURITY FIX
                releaseDate: cvIssue.store_date || cvIssue.cover_date || null,
                coverUrl: cvIssue.image?.medium_url || cvIssue.image?.small_url || null,
                writers: JSON.stringify(writers.length ? writers : volWriters),
                artists: JSON.stringify(artists.length ? artists : volArtists),
                characters: JSON.stringify(characters.length ? characters : volCharacters),
                genres: JSON.stringify(genres.length ? genres : volGenres), 
                storyArcs: JSON.stringify(storyArcs), 
            };

            if (existingByCvId) {
                await prisma.issue.update({
                    where: { id: existingByCvId.id },
                    data: { seriesId: series.id, number: issueNumStr, ...issueDataPayload }
                });
            } else {
                await prisma.issue.create({
                    data: {
                        seriesId: series.id, 
                        metadataId: cvIssue.id.toString(), 
                        metadataSource: 'COMICVINE', 
                        number: issueNumStr, 
                        status: 'WANTED', 
                        ...issueDataPayload
                    }
                });
            }
        }
        offset += 100;
        await new Promise(r => setTimeout(r, 1500));
    }

    Logger.log(`[Metadata] Successfully synced ComicVine issues.`, 'success');
    return { success: true };
}