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
import { sanitizeDescription } from '@/lib/utils/sanitize';
import { safeParse } from '@/lib/utils/safe-parse';
import { omnibusQueue } from '@/lib/queue';
import { getAccessibleLibraryIds, canAccessLibraryId } from '@/lib/library-access';
import { cachedCvGet } from '@/lib/metadata/metadata-cache';
import { issueIdentityMismatch } from '@/lib/metadata/issue-identity';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) return NextResponse.json({ error: "Missing issue ID" }, { status: 400 });

  try {
    const issue = await prisma.issue.findUnique({
        where: { id },
        // metadataId/metadataSource feed the #194 identity guard on the deep-fetch below.
        include: { series: { select: { libraryId: true, metadataId: true, metadataSource: true } } }
    });

    if (!issue) return NextResponse.json({ error: "Issue not found" }, { status: 404 });

    // Per-library access: the issue's series must be in a library the user has been granted (admins bypass).
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const accessibleLibs = await getAccessibleLibraryIds((session?.user as any)?.id, (session?.user as any)?.role);
    if (!canAccessLibraryId(accessibleLibs, issue.series?.libraryId)) {
        return NextResponse.json({ error: "You don't have access to this library." }, { status: 403 });
    }

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

    const needsDeepFetch = issue.metadataId &&
                           !issue.metadataId.startsWith('unmatched_') &&
                           issue.matchState !== 'DEEP_SYNCED' &&
                           !(issue as any).hasCustomMetadata; // a manually curated issue is never re-fetched over

    // file_metadata_priority (discussions #177/#182): the view-time merge is fill-blanks-only when
    // the admin prefers embedded file metadata — an existing non-empty value (ComicInfo-derived or
    // manual) is never replaced by the provider's. Parity with the engine's merge_credit_json;
    // previously this route overwrote file credits whenever the provider returned data.
    const fillOnly = needsDeepFetch
        ? (await prisma.systemSetting.findUnique({ where: { key: 'file_metadata_priority' } }))?.value === 'true'
        : false;
    const mergeList = (fetched: string[] | undefined, existing: string[]): string[] => {
        const f = fetched || [];
        if (f.length === 0) return existing;          // never-wipe (#179)
        if (fillOnly && existing.length > 0) return existing; // fill-blanks-only
        return f;
    };

    if (needsDeepFetch && issue.metadataId) {
        if (issue.metadataSource === 'METRON') {
            try {
                const { MetronProvider } = await import('@/lib/metadata/providers/metron');
                const metron = new MetronProvider();
                const deepData = await metron.getIssueDetails(issue.metadataId); // Guaranteed string

                // #194 guard: never trust the stored metadataId blindly — a sync race can leave a
                // row holding another issue's id, and writing that payload (then stamping
                // DEEP_SYNCED) locks the wrong data in. On mismatch, serve DB data untouched.
                const mismatch = issueIdentityMismatch({
                    rowNumber: issue.number,
                    seriesMetadataId: issue.series?.metadataId,
                    seriesMetadataSource: issue.series?.metadataSource,
                    expectedSource: 'METRON',
                    fetchedParentId: deepData.seriesId != null ? deepData.seriesId.toString() : null,
                    fetchedIssueNumber: deepData.issueNumber
                });
                if (mismatch) {
                    Logger.log(`[Issue API] Skipping Metron deep-fetch for issue ${issue.id} (#${issue.number}): stored metadataId ${issue.metadataId} ${mismatch}.`, 'warn');
                } else {
                    const newDescription = fillOnly && issue.description ? issue.description : (deepData.description || issue.description);
                    const finalWriters = mergeList(deepData.writers, parsedWriters);
                    const finalArtists = mergeList(deepData.artists, parsedArtists);
                    const finalCoverArtists = mergeList(deepData.coverArtists, parsedCoverArtists);
                    const finalColorists = mergeList(deepData.colorists, parsedColorists);
                    const finalLetterers = mergeList(deepData.letterers, parsedLetterers);
                    const finalCharacters = mergeList(deepData.characters, parsedCharacters);
                    // ["NONE"] only when BOTH sides are empty — the old shape dropped file-derived arcs
                    // to the sentinel whenever the provider returned none (the #179 wipe class).
                    const mergedArcs = mergeList(deepData.storyArcs, parsedStoryArcs);
                    const finalStoryArcs = mergedArcs.length > 0 ? mergedArcs : ["NONE"];
                    const finalTeams = mergeList(deepData.teams, parsedTeams);

                    await prisma.issue.update({
                        where: { id: issue.id },
                        data: {
                            writers: JSON.stringify(finalWriters),
                            artists: JSON.stringify(finalArtists),
                            coverArtists: JSON.stringify(finalCoverArtists),
                            colorists: JSON.stringify(finalColorists),
                            letterers: JSON.stringify(finalLetterers),
                            characters: JSON.stringify(finalCharacters),
                            storyArcs: JSON.stringify(finalStoryArcs),
                            teams: JSON.stringify(finalTeams),
                            description: newDescription,
                            matchState: 'DEEP_SYNCED'
                        } as any
                    }).catch(err => {
                        Logger.log(`[Issue API] Failed to save lazy-loaded Metron metadata: ${getErrorMessage(err)}`, 'error');
                    });

                    return NextResponse.json({
                        number: issue.number,
                        name: issue.name,
                        releaseDate: issue.releaseDate,
                        universe: issue.universe,
                        writers: finalWriters,
                        artists: finalArtists,
                        coverArtists: finalCoverArtists,
                        colorists: finalColorists,
                        letterers: finalLetterers,
                        characters: finalCharacters,
                        genres: parsedGenres,
                        storyArcs: finalStoryArcs,
                        teams: finalTeams,
                        locations: parsedLocations,
                        description: newDescription
                    });
                }

            } catch (e) {
                Logger.log(`Metron deep fetch failed, falling back to DB data: ${getErrorMessage(e)}`, 'error');
            }
        } else {
            const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
            if (setting?.value) {
                try {
                    const deepRes = await cachedCvGet(`https://comicvine.gamespot.com/api/issue/4000-${issue.metadataId}/`, {
                        params: {
                            api_key: setting.value,
                            format: 'json',
                            // volume + issue_number feed the #194 identity guard below.
                            field_list: 'person_credits,character_credits,concepts,story_arc_credits,team_credits,location_credits,description,deck,volume,issue_number'
                        },
                        headers: { 'User-Agent': 'Omnibus/1.0' },
                        timeout: 5000
                    });

                    const deepData = deepRes.data.results;
                    // #194 guard: never trust the stored metadataId blindly — a sync race can leave a
                    // row holding another issue's id, and writing that payload (then stamping
                    // DEEP_SYNCED) locks the wrong data in. On mismatch, serve DB data untouched.
                    const mismatch = deepData ? issueIdentityMismatch({
                        rowNumber: issue.number,
                        seriesMetadataId: issue.series?.metadataId,
                        seriesMetadataSource: issue.series?.metadataSource,
                        expectedSource: 'COMICVINE',
                        fetchedParentId: deepData.volume?.id != null ? deepData.volume.id.toString() : null,
                        fetchedIssueNumber: deepData.issue_number
                    }) : null;
                    if (mismatch) {
                        Logger.log(`[Issue API] Skipping CV deep-fetch for issue ${issue.id} (#${issue.number}): stored metadataId ${issue.metadataId} ${mismatch}.`, 'warn');
                    }
                    if (deepData && !mismatch) {
                        const { writers, artists, coverArtists, colorists, letterers, characters, genres, storyArcs, teams, locations } = parseComicVineCredits(
                            deepData.person_credits, 
                            deepData.character_credits, 
                            deepData.concepts, 
                            deepData.story_arc_credits,
                            deepData.team_credits,
                            deepData.location_credits
                        );

                        const newDescription = fillOnly && issue.description ? issue.description : (deepData.description || deepData.deck || issue.description);

                        const finalWriters = mergeList(writers, parsedWriters);
                        const finalArtists = mergeList(artists, parsedArtists);
                        const finalCoverArtists = mergeList(coverArtists, parsedCoverArtists);
                        const finalColorists = mergeList(colorists, parsedColorists);
                        const finalLetterers = mergeList(letterers, parsedLetterers);
                        const finalCharacters = mergeList(characters, parsedCharacters);
                        const finalGenres = mergeList(genres, parsedGenres);
                        const mergedArcs = mergeList(storyArcs, parsedStoryArcs);
                        const finalStoryArcs = mergedArcs.length > 0 ? mergedArcs : ["NONE"];
                        const finalTeams = mergeList(teams, parsedTeams);
                        const finalLocations = mergeList(locations, parsedLocations);

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
                            Logger.log(`[Issue API] Failed to save lazy-loaded CV metadata: ${getErrorMessage(err)}`, 'error');
                        });

                        return NextResponse.json({
                            number: issue.number,
                            name: issue.name,
                            releaseDate: issue.releaseDate,
                            universe: issue.universe,
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
    }

    return NextResponse.json({
        number: issue.number,
        name: issue.name,
        releaseDate: issue.releaseDate,
        universe: issue.universe,
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
        // Sanitize provider HTML before it reaches the dangerouslySetInnerHTML synopsis sink (stored XSS).
        description: sanitizeDescription(issue.description)
    });
  } catch (error: unknown) {
    Logger.log(`[Library Issue API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

// Save manually edited issue metadata (the per-issue ComicInfo editor). Marks the issue as
// custom (locks it from auto-sync + the lazy deep-fetch) and optionally embeds to ComicInfo.xml.
export async function PATCH(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        const body = await request.json();
        const issueId = body.issueId;
        if (!issueId) return NextResponse.json({ error: "Missing issue ID" }, { status: 400 });

        const existing = await prisma.issue.findUnique({ where: { id: issueId }, include: { series: true } });
        if (!existing) return NextResponse.json({ error: "Issue not found" }, { status: 404 });

        // Multi-value fields arrive from the editor as arrays; persisted as JSON strings.
        const ARRAY_FIELDS = ['writers', 'artists', 'coverArtists', 'colorists', 'letterers', 'characters', 'genres', 'storyArcs', 'teams', 'locations'];
        const SCALAR_FIELDS = ['number', 'name', 'description', 'releaseDate', 'universe'];

        const data: any = {};
        for (const f of SCALAR_FIELDS) {
            if (body[f] !== undefined) data[f] = body[f] === '' ? null : body[f];
        }
        for (const f of ARRAY_FIELDS) {
            if (body[f] !== undefined) {
                const arr = Array.isArray(body[f]) ? body[f].map((s: any) => String(s).trim()).filter(Boolean) : [];
                data[f] = JSON.stringify(arr);
            }
        }
        // Lock against auto-sync overwrite, and stop the GET lazy deep-fetch from clobbering the edit.
        data.hasCustomMetadata = true;
        data.matchState = 'DEEP_SYNCED';

        await prisma.issue.update({ where: { id: issueId }, data });

        // Write-to-file decision: an explicit per-edit toggle wins; otherwise the global default.
        let writeToFile = body.writeToFile;
        if (writeToFile === undefined) {
            const setting = await prisma.systemSetting.findUnique({ where: { key: 'metadata_write_comicinfo' } });
            writeToFile = setting?.value !== 'false'; // default: write
        }

        if (writeToFile) {
            try {
                await omnibusQueue.add('EMBED_METADATA', { type: 'EMBED_METADATA', issueIds: [issueId] }, {
                    jobId: `EMBED_META_ISSUE_${issueId}_${Date.now()}`
                });
                Logger.log(`[Metadata] Queued ComicInfo.xml embed for edited issue: ${existing.series?.name || ''} #${existing.number}`, 'info');
            } catch (e) {}
        }

        await AuditLogger.log('UPDATE_ISSUE_METADATA', {
            issueId,
            issueName: `${existing.series?.name || ''} #${existing.number}`,
            wroteToFile: !!writeToFile
        }, (session.user as any).id);

        return NextResponse.json({ success: true, wroteToFile: !!writeToFile });
    } catch (error: unknown) {
        Logger.log(`[Library Issue API] PATCH Error: ${getErrorMessage(error)}`, 'error');
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