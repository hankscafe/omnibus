// src/app/api/reading-lists/import-mal/route.ts
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
        if (!username) return NextResponse.json({ error: 'MyAnimeList username is required' }, { status: 400 });

        let allEntries: any[] = [];
        let page = 1;
        let hasNextPage = true;

        while (hasNextPage && page <= 5) {
            const response = await fetch(`https://api.jikan.moe/v4/users/${username}/mangalist?page=${page}`, {
                headers: { 'Accept': 'application/json' }
            });

            if (!response.ok) {
                if (page === 1) throw new Error("Failed to locate MAL user. Ensure the username is correct and public.");
                break;
            }

            const data = await response.json();
            allEntries = allEntries.concat(data.data || []);
            hasNextPage = data.pagination?.has_next_page || false;
            page++;
            if (hasNextPage) await new Promise(r => setTimeout(r, 400)); 
        }

        if (allEntries.length === 0) return NextResponse.json({ error: "No manga found on this MAL account." }, { status: 404 });

        const statusMap: Record<number, string> = {
            1: "Reading", 2: "Completed", 3: "On Hold", 4: "Dropped", 6: "Plan to Read"
        };

        const groupedLists: Record<string, any[]> = {};
        for (const entry of allEntries) {
            const statusName = statusMap[entry.status] || "Other";
            if (!groupedLists[statusName]) groupedLists[statusName] = [];
            groupedLists[statusName].push(entry);
        }

        const localManga = await prisma.series.findMany({
            where: { isManga: true }, select: { id: true, name: true }
        });

        const normalize = (str: string) => str.toLowerCase().replace(/[^a-z0-9]/g, '');

        let listsCreated = 0;
        let totalMatchedSeries = 0;
        let missingRequested = 0;
        const automationQueue: any[] = [];

        for (const [statusName, entries] of Object.entries(groupedLists)) {
            const listName = `MAL: ${statusName}`;
            const matchedSeriesIds = new Set<string>();

            for (const entry of entries) {
                const manga = entry.manga;
                if (!manga) continue;

                const engTitle = manga.title_english ? normalize(manga.title_english) : "";
                const romajiTitle = manga.title ? normalize(manga.title) : "";
                const displayTitle = manga.title_english || manga.title;

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
                                activeDownloadName: displayTitle, imageUrl: manga.images?.jpg?.large_image_url || manga.images?.jpg?.image_url || ""
                            }
                        });
                        
                        automationQueue.push({
                            id: newReq.id, name: displayTitle, year: manga.published?.prop?.from?.year?.toString() || new Date().getFullYear().toString(),
                            publisher: "Unknown", isManga: true, skipIndexers: false
                        });
                        missingRequested++;
                    }
                }
            }

            if (matchedSeriesIds.size > 0) {
                await prisma.readingList.deleteMany({
                    where: { name: listName, userId: isGlobal ? null : userId }
                });

                const newList = await prisma.readingList.create({
                    data: { 
                        name: listName, 
                        description: `Imported from MyAnimeList user: ${username}`, 
                        // FIX: Safely access session and user roles with optional chaining
                        userId: isGlobal && (session?.user as any)?.role === 'ADMIN' ? null : userId 
                    }
                });

                const allIssues = await prisma.issue.findMany({
                    where: { seriesId: { in: Array.from(matchedSeriesIds) } },
                    include: { series: true }
                });

                allIssues.sort((a, b) => {
                    if (a.series.name !== b.series.name) return a.series.name.localeCompare(b.series.name);
                    return parseFloat(a.number.replace(/[^0-9.]/g, '')) - parseFloat(b.number.replace(/[^0-9.]/g, ''));
                });

                let order = 0;
                const itemsData = allIssues.map(issue => ({
                    listId: newList.id, issueId: issue.id, title: `${issue.series.name} #${issue.number}`, order: order++
                }));

                await prisma.readingListItem.createMany({ data: itemsData });
                listsCreated++;
                totalMatchedSeries += matchedSeriesIds.size;
            }
        }

        if (automationQueue.length > 0) processAutomationQueue(automationQueue).catch(() => {});

        if (totalMatchedSeries === 0 && missingRequested === 0) {
            return NextResponse.json({ error: "Found MAL account, but none of the manga matched your server." }, { status: 404 });
        }

        return NextResponse.json({ 
            success: true, 
            message: `Synced ${totalMatchedSeries} manga across ${listsCreated} reading lists! ${missingRequested > 0 ? `Queued ${missingRequested} missing manga.` : ''}` 
        });

    } catch (error: unknown) {
        Logger.log(`MyAnimeList Import Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}