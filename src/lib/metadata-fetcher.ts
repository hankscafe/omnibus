// src/lib/metadata-fetcher.ts
import axios from 'axios';
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import { Logger } from './logger';
import { parseComicVineCredits } from '@/lib/utils';
import { getErrorMessage } from './utils/error';
import { ComicVineVolume, ComicVineIssue } from '@/types'; 

export async function syncSeriesMetadata(cvId: number, folderPath: string) {
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
    if (!setting?.value) throw new Error("No ComicVine API Key configured.");

    const series = await prisma.series.findFirst({ where: { cvId } });
    if (!series) throw new Error("Series not found in database.");

    Logger.log(`[Metadata] Fetching Volume data for CV ID: ${cvId}`, 'info');

    // 1. Fetch Volume
    const volRes = await axios.get<{ error?: string; results: any }>(`https://comicvine.gamespot.com/api/volume/4050-${cvId}/`, {
        params: { api_key: setting.value, format: 'json', field_list: 'image,description,deck,publisher,start_year,name,person_credits,character_credits,concepts,end_year' },
        headers: { 'User-Agent': 'Omnibus/1.0' },
        timeout: 15000
    });

    const volData = volRes.data.results;
    if (!volData) throw new Error("Volume data not found on ComicVine.");

    const imageUrl = volData.image?.medium_url || volData.image?.super_url;

    const { 
        writers: volWriters, 
        artists: volArtists, 
        characters: volCharacters,
        genres: volGenres
    } = parseComicVineCredits(volData.person_credits || undefined, volData.character_credits || undefined, volData.concepts || undefined);

    await prisma.series.update({
        where: { id: series.id },
        data: {
            name: volData.name,
            publisher: volData.publisher?.name || 'Other',
            year: parseInt(volData.start_year || "0") || series.year,
            description: volData.description || volData.deck || null,
            coverUrl: imageUrl,
            status: volData.end_year ? 'Ended' : 'Ongoing' 
        }
    });

    if (imageUrl && folderPath && fs.existsSync(folderPath)) {
        try {
            const imgRes = await axios.get<ArrayBuffer>(imageUrl, { responseType: 'arraybuffer' });
            await fs.writeFile(path.join(folderPath, 'cover.jpg'), Buffer.from(imgRes.data));
        } catch (e: unknown) {
            Logger.log(`[Metadata] Failed to save cover image locally: ${getErrorMessage(e)}`, 'warn');
        }
    }

    await new Promise(r => setTimeout(r, 1500));

    Logger.log(`[Metadata] Fetching Issues for Volume: ${volData.name}`, 'info');

    // 2. Fetch All Issues
    let offset = 0;
    let totalResults = 1;
    let loopCount = 0;
    let syncedCount = 0;

    while (offset < totalResults && loopCount < 20) {
        const issueRes = await axios.get<{ number_of_total_results: number; results: any[] }>(`https://comicvine.gamespot.com/api/issues/`, {
            params: {
                api_key: setting.value, format: 'json', filter: `volume:${cvId}`, sort: 'issue_number:asc', limit: 100, offset: offset,
                field_list: 'id,name,issue_number,store_date,cover_date,image,deck,description,person_credits,character_credits,concepts,story_arc_credits'
            },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 15000
        });

        const data = issueRes.data;
        if (offset === 0) totalResults = data.number_of_total_results || 0;
        
        const cvIssues = data.results || [];

        for (const cvIssue of cvIssues) {
            const { writers, artists, characters, genres, storyArcs } = parseComicVineCredits(
                cvIssue.person_credits || undefined, 
                cvIssue.character_credits || undefined, 
                cvIssue.concepts || undefined,
                cvIssue.story_arc_credits || undefined
            );
            const issueNumStr = cvIssue.issue_number?.toString() || "0";

            const finalWriters = writers.length > 0 ? writers : volWriters;
            const finalArtists = artists.length > 0 ? artists : volArtists;
            const finalCharacters = characters.length > 0 ? characters : volCharacters;
            const finalGenres = genres.length > 0 ? genres : volGenres;

            const existingByCvId = await prisma.issue.findUnique({ where: { cvId: cvIssue.id } });

            // --- THE FIX: PRESERVE EXISTING STORY ARCS ---
            // If the bulk endpoint drops the story arcs, we gracefully reuse the ones already in the database
            let finalStoryArcs = storyArcs;
            if (storyArcs.length === 0 && existingByCvId && (existingByCvId as any).storyArcs) {
                try {
                    const parsed = JSON.parse((existingByCvId as any).storyArcs);
                    if (Array.isArray(parsed)) finalStoryArcs = parsed;
                } catch(e) {}
            }

            const issueDataPayload = {
                name: cvIssue.name,
                description: cvIssue.description || cvIssue.deck || null,
                releaseDate: cvIssue.store_date || cvIssue.cover_date || null,
                coverUrl: cvIssue.image?.medium_url || cvIssue.image?.small_url || null,
                writers: JSON.stringify(finalWriters),
                artists: JSON.stringify(finalArtists),
                characters: JSON.stringify(finalCharacters),
                genres: JSON.stringify(finalGenres), 
                storyArcs: JSON.stringify(finalStoryArcs), 
            };

            if (existingByCvId) {
                await prisma.issue.update({
                    where: { id: existingByCvId.id },
                    data: { seriesId: series.id, number: issueNumStr, ...issueDataPayload }
                });
            } else {
                const existingByNum = await prisma.issue.findFirst({
                    where: { seriesId: series.id, number: issueNumStr }
                });

                if (existingByNum) {
                    await prisma.issue.update({
                        where: { id: existingByNum.id },
                        data: { cvId: cvIssue.id, ...issueDataPayload }
                    });
                } else {
                    await prisma.issue.create({
                        data: {
                            seriesId: series.id, cvId: cvIssue.id, number: issueNumStr, status: 'WANTED', ...issueDataPayload
                        }
                    });
                }
            }
            syncedCount++;
        }

        offset += 100;
        loopCount++;
        await new Promise(r => setTimeout(r, 1500));
    }

    Logger.log(`[Metadata] Successfully synced ${syncedCount} issues.`, 'success');
    return { success: true, count: syncedCount };
}