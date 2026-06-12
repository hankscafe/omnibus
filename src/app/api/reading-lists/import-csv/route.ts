// src/app/api/reading-lists/import-csv/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;

    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
        const formData = await request.formData();
        const file = formData.get('file') as File;
        const listName = formData.get('name') as string;
        const isGlobal = formData.get('isGlobal') === 'true';

        if (!file || !listName) {
            return NextResponse.json({ error: "File and List Name are required." }, { status: 400 });
        }

        const fileContent = await file.text();
        const rows = fileContent.split(/\r?\n/);
        if (rows.length < 2) return NextResponse.json({ error: "CSV file appears to be empty." }, { status: 400 });

        const parseRow = (row: string) => {
            const matches = row.match(/(\\.|[^",]+|"(?:\\.|[^"])*")/g) || [];
            return matches.map(m => m.replace(/^"|"$/g, '').trim());
        };

        const headers = parseRow(rows[0]).map(h => h.toLowerCase());
        
        const seriesIdx = headers.findIndex(h => h === 'series' || h === 'title');
        const issueIdx = headers.findIndex(h => h === 'issue' || h === 'number' || h === 'issue number');
        
        if (seriesIdx === -1) {
            return NextResponse.json({ error: "Could not find a 'Series' or 'Title' column in the CSV." }, { status: 400 });
        }

        const allSeries = await prisma.series.findMany({ select: { id: true, name: true, coverUrl: true, folderPath: true } });
        const allIssues = await prisma.issue.findMany({ select: { id: true, seriesId: true, number: true } });

        const normalize = (str: string) => str.toLowerCase().replace(/[^a-z0-9]/g, '');

        const itemsToLink: { issueId: string | null, title: string }[] = [];
        let missingCount = 0;
        let listCoverUrl: string | null = null; 

        Logger.log(`[CSV Import Debug] Processing ${rows.length - 1} data rows from CSV...`, 'debug');

        for (let i = 1; i < rows.length; i++) {
            if (!rows[i].trim()) continue;
            
            const cols = parseRow(rows[i]);
            const seriesName = cols[seriesIdx];
            const issueNum = issueIdx !== -1 ? cols[issueIdx] : "1";

            if (!seriesName) continue;

            const normalizedSearchSeries = normalize(seriesName);
            const parsedTargetNum = parseFloat(issueNum.replace(/[^0-9.-]/g, ''));

            Logger.log(`[CSV Import Debug] Evaluating CSV entry: "${seriesName} #${issueNum}" (Normalized: "${normalizedSearchSeries}")`, 'debug');

            const matchedSeries = allSeries.find(s => normalize(s.name) === normalizedSearchSeries || normalize(s.name).includes(normalizedSearchSeries));
            let matchedIssueId = null;

            if (matchedSeries) {
                if (!listCoverUrl) {
                    if (matchedSeries.coverUrl) {
                        listCoverUrl = matchedSeries.coverUrl;
                    } else if (matchedSeries.folderPath) {
                        listCoverUrl = `/api/library/cover?path=${encodeURIComponent(matchedSeries.folderPath)}`;
                    }
                }

                const matchedIssue = allIssues.find(iss => 
                    iss.seriesId === matchedSeries.id && 
                    parseFloat(iss.number) === parsedTargetNum
                );

                if (matchedIssue) {
                    matchedIssueId = matchedIssue.id;
                    Logger.log(`[CSV Import Debug] SUCCESS -> Linked to local issue [ID: ${matchedIssueId}]`, 'debug');
                } else {
                    missingCount++;
                    Logger.log(`[CSV Import Debug] FAILED -> Matched series "${matchedSeries.name}", but issue #${issueNum} is missing locally.`, 'debug');
                }
            } else {
                missingCount++;
                Logger.log(`[CSV Import Debug] FAILED -> No local series matched "${seriesName}".`, 'debug');
            }

            itemsToLink.push({
                issueId: matchedIssueId,
                title: `${seriesName} #${issueNum}`
            });
        }

        if (itemsToLink.length === 0) {
            return NextResponse.json({ error: "Could not extract any valid comics from the CSV." }, { status: 400 });
        }

        const canMakeGlobal = (session?.user as any)?.role === 'ADMIN' || (session?.user as any)?.canCreateGlobalLists === true;

        const newList = await prisma.readingList.create({
            data: {
                name: listName,
                description: `Imported from CSV. Items not currently in your library: ${missingCount}`,
                coverUrl: listCoverUrl,
                isGlobal: isGlobal === true && canMakeGlobal,
                userId: userId
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
        Logger.log(`CSV Import Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}