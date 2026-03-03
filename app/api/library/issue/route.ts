import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import axios from 'axios';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

const safeParse = (str: string | null) => {
    if (!str) return [];
    try { return JSON.parse(str); } catch { return []; }
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

    // --- SMART LAZY LOADING ---
    // If the database is missing deep credits AND it is linked to a valid ComicVine ID
    if (issue.cvId > 0 && parsedWriters.length === 0 && parsedArtists.length === 0 && parsedCharacters.length === 0) {
        const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
        if (setting?.value) {
            try {
                // Fetch the specific deep data for this single issue
                const deepRes = await axios.get(`https://comicvine.gamespot.com/api/issue/4000-${issue.cvId}/`, {
                    params: { api_key: setting.value, format: 'json', field_list: 'person_credits,character_credits,description,deck' },
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
                    const newDescription = deepData.description || deepData.deck || issue.description;

                    const finalWriters = [...new Set(newWriters)];
                    const finalArtists = [...new Set(newArtists)];
                    const finalCharacters = [...new Set(newCharacters)];

                    // Save it to the database so it's instant next time!
                    await prisma.issue.update({
                        where: { id: issue.id },
                        data: {
                            writers: JSON.stringify(finalWriters),
                            artists: JSON.stringify(finalArtists),
                            characters: JSON.stringify(finalCharacters),
                            description: newDescription
                        }
                    });

                    return NextResponse.json({
                        writers: finalWriters,
                        artists: finalArtists,
                        characters: finalCharacters,
                        description: newDescription
                    });
                }
            } catch (e) {
                console.error("Deep fetch failed, falling back to DB data:", e);
            }
        }
    }

    // Standard fast return from DB
    return NextResponse.json({
        writers: parsedWriters,
        artists: parsedArtists,
        characters: parsedCharacters,
        description: issue.description
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// --- NEW DELETION LOGIC ---
export async function DELETE(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        const { issueId, fullPath, deleteFile } = await request.json();

        // 1. Delete DB Record (if it has a valid DB ID, not just a filename fallback)
        if (issueId && !issueId.includes('.')) {
            await prisma.issue.deleteMany({ where: { id: issueId } });
        }

        // 2. Delete Physical File
        if (deleteFile && fullPath) {
            const fs = await import('fs');
            if (fs.existsSync(fullPath)) {
                await fs.promises.unlink(fullPath);
            }
        }

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}