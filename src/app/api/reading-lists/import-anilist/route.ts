// src/app/api/reading-lists/import-anilist/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { processAutomationQueue } from '@/lib/automation';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;

    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
        const { username, requestMissing, isGlobal } = await request.json();
        if (!username) return NextResponse.json({ error: 'AniList username is required' }, { status: 400 });

        const query = `
            query ($userName: String) {
                MediaListCollection(userName: $userName, type: MANGA) {
                    lists {
                        name
                        entries {
                            media {
                                title { romaji english }
                                startDate { year }
                                coverImage { large }
                            }
                        }
                    }
                }
            }
        `;

        const response = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query, variables: { userName: username } })
        });

        if (!response.ok) throw new Error("Failed to locate AniList user.");
        const data = await response.json();
        const lists = data?.data?.MediaListCollection?.lists || [];

        if (lists.length === 0) return NextResponse.json({ error: "No manga lists found for this user." }, { status: 404 });

        const localManga = await prisma.series.findMany({
            where: { isManga: true },
            select: { id: true, name: true }
        });

        const normalize = (str: string) => str.toLowerCase().replace(/[^a-z0-9]/g, '');

        let listsCreated = 0;
        let totalMatchedSeries = 0;
        let missingRequested = 0;
        const automationQueue: any[] = [];

        for (const list of lists) {
            const listName = `AniList: ${list.name}`;
            const entries = list.entries || [];
            const matchedSeriesIds = new Set<string>();

            for (const entry of entries) {
                const engTitle = entry.media?.title?.english ? normalize(entry.media.title.english) : "";
                const romajiTitle = entry.media?.title?.romaji ? normalize(entry.media.title.romaji) : "";
                const displayTitle = entry.media?.title?.english || entry.media?.title?.romaji;

                const match = localManga.find(m => {
                    const localTitle = normalize(m.name);
                    return (engTitle && localTitle === engTitle) || 
                           (romajiTitle && localTitle === romajiTitle) || 
                           (engTitle && localTitle.includes(engTitle)) || 
                           (romajiTitle && localTitle.includes(romajiTitle));
                });

                if (match) {
                    matchedSeriesIds.add(match.id);
                } else if (requestMissing && displayTitle) {
                    const existingReq = await prisma.request.findFirst({
                        where: { activeDownloadName: displayTitle, userId: userId }
                    });

                    if (!existingReq) {
                        const newReq = await prisma.request.create({
                            data: {
                                userId: userId, volumeId: "0", status: 'PENDING',
                                activeDownloadName: displayTitle, imageUrl: entry.media?.coverImage?.large || ""
                            }
                        });
                        
                        automationQueue.push({
                            id: newReq.id, name: displayTitle, year: entry.media?.startDate?.year?.toString() || new Date().getFullYear().toString(),
                            publisher: "Unknown", isManga: true, skipIndexers: false
                        });
                        missingRequested++;
                    }
                }
            }

            // Build the Reading List
            if (matchedSeriesIds.size > 0) {
                // Delete old list if re-syncing
                await prisma.readingList.deleteMany({
                    where: { name: listName, userId: isGlobal ? null : userId }
                });

                const newList = await prisma.readingList.create({
                    data: {
                        name: listName,
                        description: `Imported from AniList user: ${username}`,
                        // FIX: Safely access session and user roles with optional chaining
                        userId: isGlobal && (session?.user as any)?.role === 'ADMIN' ? null : userId
                    }
                });

                // Grab ALL issues for the matched series
                const allIssues = await prisma.issue.findMany({
                    where: { seriesId: { in: Array.from(matchedSeriesIds) } },
                    include: { series: true }
                });

                // Sort issues by Series Name, then numerically by Issue Number
                allIssues.sort((a, b) => {
                    if (a.series.name !== b.series.name) return a.series.name.localeCompare(b.series.name);
                    return parseFloat(a.number.replace(/[^0-9.]/g, '')) - parseFloat(b.number.replace(/[^0-9.]/g, ''));
                });

                let order = 0;
                const itemsData = allIssues.map(issue => ({
                    listId: newList.id,
                    issueId: issue.id,
                    title: `${issue.series.name} #${issue.number}`,
                    order: order++
                }));

                await prisma.readingListItem.createMany({ data: itemsData });

                listsCreated++;
                totalMatchedSeries += matchedSeriesIds.size;
            }
        }

        if (automationQueue.length > 0) processAutomationQueue(automationQueue).catch(() => {});

        if (totalMatchedSeries === 0 && missingRequested === 0) {
            return NextResponse.json({ error: "Found AniList account, but none of the manga matched your server." }, { status: 404 });
        }

        return NextResponse.json({ 
            success: true, 
            message: `Synced ${totalMatchedSeries} manga across ${listsCreated} reading lists! ${missingRequested > 0 ? `Queued ${missingRequested} missing manga.` : ''}` 
        });

    } catch (error: unknown) {
        Logger.log(`AniList Import Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}