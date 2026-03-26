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

        // 1. Parse CSV Headers (LOCG uses specific headers like 'Series', 'Issue', 'Publisher')
        // We use a simple regex to handle CSV quotes cleanly
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

        // 2. Fetch local database into memory for blazing fast fuzzy matching
        const allSeries = await prisma.series.findMany({ select: { id: true, name: true } });
        const allIssues = await prisma.issue.findMany({ select: { id: true, seriesId: true, number: true } });

        const normalize = (str: string) => str.toLowerCase().replace(/[^a-z0-9]/g, '');

        const issuesToLink: { issueId: string, title: string }[] = [];
        let missingCount = 0;

        // 3. Process the CSV rows
        for (let i = 1; i < rows.length; i++) {
            if (!rows[i].trim()) continue;
            
            const cols = parseRow(rows[i]);
            const seriesName = cols[seriesIdx];
            const issueNum = issueIdx !== -1 ? cols[issueIdx] : "1";

            if (!seriesName) continue;

            const normalizedSearchSeries = normalize(seriesName);
            const parsedTargetNum = parseFloat(issueNum.replace(/[^0-9.]/g, ''));

            // Match Series
            const matchedSeries = allSeries.find(s => normalize(s.name) === normalizedSearchSeries || normalize(s.name).includes(normalizedSearchSeries));

            if (matchedSeries) {
                // Match Issue inside that Series
                const matchedIssue = allIssues.find(iss => 
                    iss.seriesId === matchedSeries.id && 
                    parseFloat(iss.number) === parsedTargetNum
                );

                if (matchedIssue) {
                    issuesToLink.push({
                        issueId: matchedIssue.id,
                        title: `${seriesName} #${issueNum}`
                    });
                } else {
                    missingCount++;
                }
            } else {
                missingCount++;
            }
        }

        if (issuesToLink.length === 0) {
            return NextResponse.json({ error: "None of the comics in the CSV matched your downloaded library." }, { status: 404 });
        }

        // 4. Build the Reading List
        const newList = await prisma.readingList.create({
            data: {
                name: listName,
                description: `Imported from CSV. Missing items skipped: ${missingCount}`,
                userId: isGlobal && session.user.role === 'ADMIN' ? null : userId
            }
        });

        let orderCount = 0;
        const itemsData = issuesToLink.map(item => ({
            listId: newList.id,
            issueId: item.issueId,
            title: item.title,
            order: orderCount++
        }));

        await prisma.readingListItem.createMany({ data: itemsData });

        return NextResponse.json({ 
            success: true, 
            listId: newList.id,
            message: `Successfully imported ${issuesToLink.length} issues into "${listName}"!` 
        });

    } catch (error: unknown) {
        Logger.log(`CSV Import Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}