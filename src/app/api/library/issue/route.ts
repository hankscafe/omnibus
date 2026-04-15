// src/app/api/library/issue/route.ts

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import axios from 'axios';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { parseComicVineCredits } from '@/lib/utils'; 

const safeParse = (str: string | null) => {
    if (!str) return [];
    try { 
        const arr = JSON.parse(str); 
        return Array.isArray(arr) ? arr.filter((item: string) => item !== "NONE") : [];
    } catch { return []; }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) return NextResponse.json({ error: "Missing issue ID" }, { status: 400 });

  try {
    const issue = await prisma.issue.findUnique({
        where: { id }
    });

    if (!issue) return NextResponse.json({ error: "Issue not found" }, { status: 404 });

    const parsedWriters = safeParse(issue.writers);
    const parsedArtists = safeParse(issue.artists);
    const parsedCoverArtists = safeParse((issue as any).coverArtists);
    const parsedColorists = safeParse((issue as any).colorists);
    const parsedLetterers = safeParse((issue as any).letterers);
    const parsedCharacters = safeParse(issue.characters);
    const parsedGenres = safeParse((issue as any).genres); 
    const parsedStoryArcs = safeParse((issue as any).storyArcs); 
    const parsedTeams = safeParse((issue as any).teams);
    const parsedLocations = safeParse((issue as any).locations);

    // FIX: Use matchState to guarantee a deep fetch runs if the issue hasn't been individually queried yet.
    // This will automatically heal the empty arrays saved by the bulk fetcher.
    const needsDeepFetch = issue.metadataSource === 'COMICVINE' && 
                           issue.metadataId && 
                           !issue.metadataId.startsWith('unmatched_') && 
                           issue.matchState !== 'DEEP_SYNCED';

    if (needsDeepFetch) {
        const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
        if (setting?.value) {
            try {
                const deepRes = await axios.get(`https://comicvine.gamespot.com/api/issue/4000-${issue.metadataId}/`, {
                    params: { 
                        api_key: setting.value, 
                        format: 'json', 
                        field_list: 'person_credits,character_credits,concepts,story_arc_credits,team_credits,location_credits,description,deck' 
                    },
                    headers: { 'User-Agent': 'Omnibus/1.0' },
                    timeout: 5000
                });

                const deepData = deepRes.data.results;
                if (deepData) {
                    const { writers, artists, coverArtists, colorists, letterers, characters, genres, storyArcs, teams, locations } = parseComicVineCredits(
                        deepData.person_credits, 
                        deepData.character_credits, 
                        deepData.concepts, 
                        deepData.story_arc_credits,
                        deepData.team_credits,
                        deepData.location_credits
                    );

                    const newDescription = deepData.description || deepData.deck || issue.description;

                    const finalWriters = writers.length > 0 ? writers : parsedWriters;
                    const finalArtists = artists.length > 0 ? artists : parsedArtists;
                    const finalCoverArtists = coverArtists.length > 0 ? coverArtists : parsedCoverArtists;
                    const finalColorists = colorists.length > 0 ? colorists : parsedColorists;
                    const finalLetterers = letterers.length > 0 ? letterers : parsedLetterers;
                    const finalCharacters = characters.length > 0 ? characters : parsedCharacters;
                    const finalGenres = genres.length > 0 ? genres : parsedGenres;
                    const finalStoryArcs = storyArcs.length > 0 ? storyArcs : ["NONE"];
                    const finalTeams = teams.length > 0 ? teams : parsedTeams;
                    const finalLocations = locations.length > 0 ? locations : parsedLocations;

                    // FIX: Save the data AND flag the issue as DEEP_SYNCED so it doesn't query the API again
                    await prisma.issue.update({
                        where: { id: issue.id },
                        data: {
                            writers: JSON.stringify(finalWriters),
                            artists: JSON.stringify(finalArtists),
                            coverArtists: JSON.stringify(finalCoverArtists),
                            colorists: JSON.stringify(finalColorists),
                            letterers: JSON.stringify(finalLetterers),
                            characters: JSON.stringify(finalCharacters),
                            genres: JSON.stringify(finalGenres), 
                            storyArcs: JSON.stringify(finalStoryArcs), 
                            teams: JSON.stringify(finalTeams),
                            locations: JSON.stringify(finalLocations),
                            description: newDescription,
                            matchState: 'DEEP_SYNCED'
                        } as any
                    }).catch(err => {
                        Logger.log(`[Issue API] Failed to save lazy-loaded metadata: ${getErrorMessage(err)}`, 'error');
                    });

                    return NextResponse.json({
                        writers: finalWriters,
                        artists: finalArtists,
                        coverArtists: finalCoverArtists,
                        colorists: finalColorists,
                        letterers: finalLetterers,
                        characters: finalCharacters,
                        genres: finalGenres, 
                        storyArcs: finalStoryArcs, 
                        teams: finalTeams,
                        locations: finalLocations,
                        description: newDescription
                    });
                }
            } catch (e) {
                Logger.log(`Deep fetch failed, falling back to DB data: ${getErrorMessage(e)}`, 'error');
            }
        }
    }

    return NextResponse.json({
        writers: parsedWriters,
        artists: parsedArtists,
        coverArtists: parsedCoverArtists,
        colorists: parsedColorists,
        letterers: parsedLetterers,
        characters: parsedCharacters,
        genres: parsedGenres, 
        storyArcs: parsedStoryArcs, 
        teams: parsedTeams,
        locations: parsedLocations,
        description: issue.description
    });
  } catch (error: unknown) {
    Logger.log(`[Library Issue API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        const { issueId, fullPath, deleteFile } = await request.json();

        if (issueId && !issueId.includes('.')) {
            await prisma.issue.deleteMany({ where: { id: issueId } });
        }

        if (deleteFile && fullPath) {
            const fs = await import('fs');
            if (fs.existsSync(fullPath)) {
                await fs.promises.unlink(fullPath);
            }
        }

        await AuditLogger.log('DELETE_ISSUE', { 
            issueId, 
            deletedPhysicalFile: deleteFile ? fullPath : 'None' 
        }, (session.user as any).id);
        
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
    Logger.log(`[Library Issue API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}