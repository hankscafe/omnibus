// src/app/api/reading-lists/import-cbl/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { XMLParser } from 'fast-xml-parser';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;

    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
        const formData = await request.formData();
        const file = formData.get('file') as File;
        const url = formData.get('url') as string;
        const listName = formData.get('name') as string;
        const isGlobal = formData.get('isGlobal') === 'true';

        if (!listName || (!file && !url)) {
            return NextResponse.json({ error: "List Name and either a File or URL are required." }, { status: 400 });
        }

        let xmlContent = "";

        if (file) {
            xmlContent = await file.text();
        } else if (url) {
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                xmlContent = await res.text();
            } catch (e) {
                return NextResponse.json({ error: "Failed to download CBL from the provided URL." }, { status: 400 });
            }
        }

        if (!xmlContent) return NextResponse.json({ error: "CBL file is empty or unreadable." }, { status: 400 });

        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
        let parsed: any;
        try {
            parsed = parser.parse(xmlContent);
        } catch (e) {
            return NextResponse.json({ error: "Invalid XML format." }, { status: 400 });
        }

        if (!parsed?.ReadingList?.Books?.Book) {
            return NextResponse.json({ error: "Could not find any books in this CBL file." }, { status: 400 });
        }

        let rawBooks = parsed.ReadingList.Books.Book;
        if (!Array.isArray(rawBooks)) rawBooks = [rawBooks];

        // --- ADDED: Fetch coverUrl and folderPath ---
        const allSeries = await prisma.series.findMany({ select: { id: true, name: true, coverUrl: true, folderPath: true } });
        const allIssues = await prisma.issue.findMany({ select: { id: true, seriesId: true, number: true } });

        const normalize = (str: string) => str ? str.toLowerCase().replace(/[^a-z0-9]/g, '') : "";

        const itemsToLink: { issueId: string | null, title: string }[] = [];
        let missingCount = 0;
        let listCoverUrl: string | null = null; // <-- NEW: Hold the list cover

        for (const book of rawBooks) {
            const seriesName = book.Series || book.series;
            const issueNum = book.Number || book.number || "1";

            if (!seriesName) continue;

            const normalizedSearchSeries = normalize(seriesName);
            const parsedTargetNum = parseFloat(issueNum.replace(/[^0-9.]/g, ''));

            const matchedSeries = allSeries.find(s => normalize(s.name) === normalizedSearchSeries || normalize(s.name).includes(normalizedSearchSeries));
            let matchedIssueId = null;

            if (matchedSeries) {
                // --- NEW: Grab the cover of the first matched series for the List ---
                if (!listCoverUrl) {
                    if (matchedSeries.coverUrl) {
                        listCoverUrl = matchedSeries.coverUrl;
                    } else if (matchedSeries.folderPath) {
                        listCoverUrl = `/api/library/cover?path=${encodeURIComponent(matchedSeries.folderPath)}`;
                    }
                }
                // ------------------------------------------------------------------

                const matchedIssue = allIssues.find(iss => 
                    iss.seriesId === matchedSeries.id && 
                    parseFloat(iss.number) === parsedTargetNum
                );

                if (matchedIssue) {
                    matchedIssueId = matchedIssue.id;
                } else {
                    missingCount++;
                }
            } else {
                missingCount++;
            }

            itemsToLink.push({
                issueId: matchedIssueId,
                title: `${seriesName} #${issueNum}`
            });
        }

        if (itemsToLink.length === 0) {
            return NextResponse.json({ error: "Could not extract any valid comics from this CBL file." }, { status: 400 });
        }

        const newList = await prisma.readingList.create({
            data: {
                name: listName,
                description: `Imported from CBL. Items not currently in your library: ${missingCount}`,
                coverUrl: listCoverUrl, // <--- Add the coverUrl here!
                userId: isGlobal && (session?.user as any)?.role === 'ADMIN' ? null : userId
            }
        });

        let orderCount = 0;
        const itemsData = itemsToLink.map(item => ({
            listId: newList.id,
            issueId: item.issueId, 
            title: item.title,
            order: orderCount++
        }));

        await prisma.readingListItem.createMany({ data: itemsData });

        return NextResponse.json({ 
            success: true, 
            listId: newList.id,
            message: `Successfully imported ${itemsToLink.length} issues into "${listName}"!` 
        });

    } catch (error: unknown) {
        Logger.log(`CBL Import Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}