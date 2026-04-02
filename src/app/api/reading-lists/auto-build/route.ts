import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import axios from 'axios';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;

        const { cvEventId, isGlobal } = await request.json();
        if (!cvEventId) return NextResponse.json({ error: "Missing Event ID" }, { status: 400 });

        const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
        if (!setting?.value) return NextResponse.json({ error: "ComicVine API Key missing" }, { status: 400 });

        const eventRes = await axios.get(`https://comicvine.gamespot.com/api/story_arc/4045-${cvEventId}/`, {
            params: { api_key: setting.value, format: 'json' },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 10000
        });

        const eventData = eventRes.data.results;
        
        if (!eventData || !eventData.name) {
            return NextResponse.json({ error: "Event not found on ComicVine. Please double-check the ID." }, { status: 404 });
        }

        const issuesList = eventData.issues || eventData.issue_credits || [];

        if (issuesList.length === 0) {
            return NextResponse.json({ error: "Event found, but ComicVine has no issues attached to it." }, { status: 404 });
        }

        const newList = await prisma.readingList.create({
            data: {
                name: eventData.name,
                description: eventData.description ? eventData.description.replace(/(<([^>]+)>)/gi, "").substring(0, 500) : null,
                coverUrl: eventData.image?.medium_url || eventData.image?.screen_url || null,
                userId: isGlobal ? null : (userId || null) 
            }
        });

        const issuesToCreate = [];
        let orderCounter = 1;

        for (const cvIssue of issuesList) {
            const targetCvId = parseInt(cvIssue.id);
            
            const existingIssue = await prisma.issue.findFirst({
                where: { metadataId: targetCvId.toString(), metadataSource: 'COMICVINE' }
            });

            let issueTitle = cvIssue.name;
            if (!issueTitle && cvIssue.volume?.name) {
                issueTitle = `${cvIssue.volume.name} #${cvIssue.issue_number || '?'}`;
            } else if (!issueTitle) {
                issueTitle = `Issue #${cvIssue.issue_number || '?'}`;
            }

            issuesToCreate.push({
                listId: newList.id,
                issueId: existingIssue ? existingIssue.id : null,
                cvIssueId: targetCvId,
                title: issueTitle,
                order: orderCounter++
            });
        }

        if (issuesToCreate.length > 0) {
            await prisma.readingListItem.createMany({ data: issuesToCreate });
        }

        return NextResponse.json({ success: true, listId: newList.id, message: `Imported ${issuesToCreate.length} issues into ${eventData.name}!` });

    } catch (error: unknown) {
        Logger.log(`Auto-Build Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}