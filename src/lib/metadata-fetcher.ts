import axios from 'axios';
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import { Logger } from './logger';
import { parseComicVineCredits } from '@/lib/utils';

export async function syncSeriesMetadata(cvId: number, folderPath: string) {
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
    if (!setting?.value) throw new Error("No ComicVine API Key configured.");

    const series = await prisma.series.findFirst({ where: { cvId } });
    if (!series) throw new Error("Series not found in database.");

    Logger.log(`[Metadata] Fetching Volume data for CV ID: ${cvId}`, 'info');

    // 1. Fetch Volume (ADDED end_year to field_list)
    const volRes = await axios.get(`https://comicvine.gamespot.com/api/volume/4050-${cvId}/`, {
        params: { api_key: setting.value, format: 'json', field_list: 'image,description,deck,publisher,start_year,name,person_credits,character_credits,end_year' },
        headers: { 'User-Agent': 'Omnibus/1.0' },
        timeout: 15000
    });

    const volData = volRes.data.results;
    if (!volData) throw new Error("Volume data not found on ComicVine.");

    const imageUrl = volData.image?.medium_url || volData.image?.super_url;

    // Use the centralized metadata parser for the Volume data
    const { 
        writers: volWriters, 
        artists: volArtists, 
        characters: volCharacters 
    } = parseComicVineCredits(volData.person_credits, volData.character_credits);

    await prisma.series.update({
        where: { id: series.id },
        data: {
            name: volData.name,
            publisher: volData.publisher?.name || 'Other',
            year: parseInt(volData.start_year) || series.year,
            description: volData.description || volData.deck || null,
            coverUrl: imageUrl,
            status: volData.end_year ? 'Ended' : 'Ongoing' // AUTOMATED STATUS
        }
    });

    if (imageUrl && folderPath && fs.existsSync(folderPath)) {
        try {
            const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            await fs.writeFile(path.join(folderPath, 'cover.jpg'), Buffer.from(imgRes.data));
        } catch (e) {}
    }

    await new Promise(r => setTimeout(r, 1500));

    Logger.log(`[Metadata] Fetching Issues for Volume: ${volData.name}`, 'info');

    // 2. Fetch All Issues (Bulk List for Fast UI Update)
    let offset = 0;
    let totalResults = 1;
    let loopCount = 0;
    let syncedCount = 0;

    while (offset < totalResults && loopCount < 20) {
        const issueRes = await axios.get(`https://comicvine.gamespot.com/api/issues/`, {
            params: {
                api_key: setting.value, format: 'json', filter: `volume:${cvId}`, sort: 'issue_number:asc', limit: 100, offset: offset,
                field_list: 'id,name,issue_number,store_date,cover_date,image,deck,description,person_credits,character_credits'
            },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 15000
        });

        const data = issueRes.data;
        if (offset === 0) totalResults = data.number_of_total_results || 0;
        const cvIssues = data.results || [];

        for (const cvIssue of cvIssues) {
            
            // Use the centralized metadata parser for individual issues
            const { writers, artists, characters } = parseComicVineCredits(cvIssue.person_credits, cvIssue.character_credits);

            const issueNumStr = parseFloat(cvIssue.issue_number?.toString() || "0").toString();

            // Fallback to volume creators if individual issue credits are missing
            const finalWriters = writers.length > 0 ? writers : volWriters;
            const finalArtists = artists.length > 0 ? artists : volArtists;
            const finalCharacters = characters.length > 0 ? characters : volCharacters;

            await prisma.issue.upsert({
                where: { seriesId_number: { seriesId: series.id, number: issueNumStr } },
                create: {
                    seriesId: series.id, cvId: cvIssue.id, number: issueNumStr, name: cvIssue.name,
                    description: cvIssue.description || cvIssue.deck || null,
                    releaseDate: cvIssue.store_date || cvIssue.cover_date || null,
                    coverUrl: cvIssue.image?.medium_url || cvIssue.image?.small_url || null,
                    writers: JSON.stringify(finalWriters),
                    artists: JSON.stringify(finalArtists),
                    characters: JSON.stringify(finalCharacters),
                },
                update: {
                    cvId: cvIssue.id, name: cvIssue.name,
                    description: cvIssue.description || cvIssue.deck || null,
                    releaseDate: cvIssue.store_date || cvIssue.cover_date || null,
                    coverUrl: cvIssue.image?.medium_url || cvIssue.image?.small_url || null,
                    writers: JSON.stringify(finalWriters),
                    artists: JSON.stringify(finalArtists),
                    characters: JSON.stringify(finalCharacters),
                }
            });
            syncedCount++;
        }

        offset += 100;
        loopCount++;
        await new Promise(r => setTimeout(r, 1500));
    }

    Logger.log(`[Metadata] Successfully synced ${syncedCount} issues.`, 'success');
    return { success: true, count: syncedCount };
}