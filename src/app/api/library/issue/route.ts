// src/app/api/library/issue/route.ts
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import axios from 'axios';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

const safeParse = (str: string | null) => {
    if (!str) return [];
    try { 
        const arr = JSON.parse(str); 
        // Filter out our magic "NONE" string so it never reaches the UI
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
    const parsedCharacters = safeParse(issue.characters);
    const parsedGenres = safeParse((issue as any).genres); 
    const parsedStoryArcs = safeParse((issue as any).storyArcs); 

    // --- SMART LAZY LOADING ---
    // Trigger if writers are missing OR if storyArcs is exactly "[]" or null
    const needsDeepFetch = issue.cvId > 0 && (
        parsedWriters.length === 0 || 
        !(issue as any).storyArcs || 
        (issue as any).storyArcs === "[]"
    );

    if (needsDeepFetch) {
        const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
        if (setting?.value) {
            try {
                // Fetch the specific deep data for this single issue
                const deepRes = await axios.get(`https://comicvine.gamespot.com/api/issue/4000-${issue.cvId}/`, {
                    params: { api_key: setting.value, format: 'json', field_list: 'person_credits,character_credits,concepts,story_arc_credits,description,deck' },
                    headers: { 'User-Agent': 'Omnibus/1.0' },
                    timeout: 5000
                });

                const deepData = deepRes.data.results;
                if (deepData) {
                    const newWriters: string[] = [];
                    const newArtists: string[] = [];
                    
                    if (deepData.person_credits) {
                        deepData.person_credits.forEach((p: any) => {
                            const role = (p.role || '').toLowerCase();
                            if (role.includes('writer') || role.includes('script') || role.includes('plot') || role.includes('story')) newWriters.push(p.name);
                            if (role.includes('pencil') || role.includes('ink') || role.includes('artist') || role.includes('color') || role.includes('illustrator')) newArtists.push(p.name);
                        });
                    }
                    
                    const newCharacters = deepData.character_credits ? deepData.character_credits.map((c:any) => c.name) : [];
                    const newGenres = deepData.concepts ? deepData.concepts.map((c:any) => c.name) : []; 
                    const newStoryArcs = deepData.story_arc_credits ? deepData.story_arc_credits.map((s:any) => s.name) : []; 
                    const newDescription = deepData.description || deepData.deck || issue.description;

                    const finalWriters = [...new Set(newWriters)];
                    const finalArtists = [...new Set(newArtists)];
                    const finalCharacters = [...new Set(newCharacters)];
                    const finalGenres = [...new Set([...parsedGenres, ...newGenres])];
                    
                    // The Magic Trick: If ComicVine genuinely has NO story arcs for this issue, we save ["NONE"].
                    const finalStoryArcs = newStoryArcs.length > 0 ? [...new Set(newStoryArcs)] : ["NONE"];

                    const issueExists = await prisma.issue.findUnique({
                        where: { id: issue.id },
                        select: { id: true }
                    });

                    if (issueExists) {
                        await prisma.issue.update({
                            where: { id: issue.id },
                            data: {
                                writers: JSON.stringify(finalWriters),
                                artists: JSON.stringify(finalArtists),
                                characters: JSON.stringify(finalCharacters),
                                genres: JSON.stringify(finalGenres), 
                                storyArcs: JSON.stringify(finalStoryArcs), 
                                description: newDescription
                            }
                        }).catch(err => {
                            Logger.log(`[Issue API] Failed to save lazy-loaded metadata: ${getErrorMessage(err)}`, 'error');
                        });
                    }

                    return NextResponse.json({
                        writers: finalWriters,
                        artists: finalArtists,
                        characters: finalCharacters,
                        genres: finalGenres, 
                        storyArcs: newStoryArcs, 
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
        characters: parsedCharacters,
        genres: parsedGenres, 
        storyArcs: parsedStoryArcs, 
        description: issue.description
    });
  } catch (error: unknown) {
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

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}