// src/app/api/reading-lists/auto-build/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import axios from 'axios';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

// Helper function to respect Metron's 20 req/min burst limit
async function fetchWithBackoff(url: string, auth: any, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const res = await axios.get(url, {
                auth,
                headers: { 'User-Agent': 'Omnibus/1.0' },
                timeout: 10000,
                validateStatus: (status) => status < 500 // Don't throw on 429 so we can read headers
            });

            if (res.status === 429) {
                // DRF sets Retry-After to the number of seconds to wait
                const retryAfter = parseInt(res.headers['retry-after'] || '60', 10);
                Logger.log(`[Auto-Build] Metron rate limit hit! Waiting ${retryAfter} seconds before resuming...`, 'warn');
                await new Promise(resolve => setTimeout(resolve, (retryAfter + 1) * 1000));
                continue; // Try again
            }

            if (res.status >= 400) {
                throw new Error(`HTTP ${res.status}`);
            }

            return res;
        } catch (error) {
            if (attempt === maxRetries - 1) throw error;
            Logger.log(`[Auto-Build] Metron fetch failed. Retrying attempt ${attempt + 2}/${maxRetries}...`, 'warn');
            await new Promise(resolve => setTimeout(resolve, 2000)); // Standard fallback delay
        }
    }
    throw new Error('Max retries reached');
}

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        const userId = (session?.user as any)?.id;

        const body = await request.json();
        const eventId = body.eventId || body.cvEventId;
        const eventSource = body.eventSource || 'COMICVINE';
        const isGlobal = body.isGlobal;

        if (!eventId) return NextResponse.json({ error: "Missing Event ID" }, { status: 400 });

        Logger.log(`[Auto-Build] Initiating Reading List build for ID: ${eventId} from ${eventSource}...`, 'info');

        let eventName = "";
        let eventDescription = "";
        let eventCoverUrl = null;
        let issuesList: any[] = [];

        if (eventSource === 'METRON') {
            const metronUser = await prisma.systemSetting.findUnique({ where: { key: 'metron_user' } });
            const metronPass = await prisma.systemSetting.findUnique({ where: { key: 'metron_pass' } });

            if (!metronUser?.value || !metronPass?.value) {
                return NextResponse.json({ error: "Metron credentials missing in Settings." }, { status: 400 });
            }

            const auth = { username: metronUser.value, password: metronPass.value };

            // 1. Get the Arc Details
            Logger.log(`[Auto-Build] Fetching Metron Arc details...`, 'info');
            const eventRes = await fetchWithBackoff(`https://metron.cloud/api/arc/${eventId}/`, auth);
            const eventData = eventRes.data;
            
            if (!eventData || !eventData.name) {
                return NextResponse.json({ error: "Event not found on Metron. Please double-check the ID." }, { status: 404 });
            }

            eventName = eventData.name;
            eventDescription = eventData.desc ? eventData.desc.replace(/(<([^>]+)>)/gi, "").substring(0, 500) : null;
            eventCoverUrl = eventData.image || null;

            Logger.log(`[Auto-Build] Found Metron Arc: "${eventName}". Paginating through issue list...`, 'info');

            // 2. Fetch the specific paginated issue_list endpoint
            try {
                let nextUrl: string | null = `https://metron.cloud/api/arc/${eventId}/issue_list/`;
                let pageCount = 0;
                
                // Safety limit of 30 pages (approx. 3000 issues) to prevent infinite loops
                while (nextUrl && pageCount < 30) { 
                    Logger.log(`[Auto-Build] Fetching Metron page ${pageCount + 1}...`, 'info');
                    const issuesRes = await fetchWithBackoff(nextUrl, auth);
                    
                    if (issuesRes.data?.results) {
                        const count = issuesRes.data.results.length;
                        issuesList.push(...issuesRes.data.results);
                        Logger.log(`[Auto-Build] Page ${pageCount + 1} retrieved ${count} issues.`, 'info');
                    }
                    
                    // Metron provides the full ready-to-use URL for the next page
                    nextUrl = issuesRes.data?.next || null;
                    pageCount++;
                }
                Logger.log(`[Auto-Build] Metron pagination complete. Total issues found: ${issuesList.length}.`, 'info');
            } catch(e) {
                Logger.log(`[Auto-Build] Metron Arc Issues Fetch Error: ${getErrorMessage(e)}`, 'error');
            }

            if (issuesList.length === 0) {
                return NextResponse.json({ error: "Event found, but Metron has no issues attached to it." }, { status: 404 });
            }

        } else {
            // COMICVINE
            const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
            if (!setting?.value) return NextResponse.json({ error: "ComicVine API Key missing" }, { status: 400 });

            Logger.log(`[Auto-Build] Fetching ComicVine Arc details...`, 'info');
            const eventRes = await axios.get(`https://comicvine.gamespot.com/api/story_arc/4045-${eventId}/`, {
                params: { api_key: setting.value, format: 'json' },
                headers: { 'User-Agent': 'Omnibus/1.0' },
                timeout: 10000
            });

            const eventData = eventRes.data.results;
            
            if (!eventData || !eventData.name) {
                return NextResponse.json({ error: "Event not found on ComicVine. Please double-check the ID." }, { status: 404 });
            }

            eventName = eventData.name;
            eventDescription = eventData.description ? eventData.description.replace(/(<([^>]+)>)/gi, "").substring(0, 500) : null;
            eventCoverUrl = eventData.image?.medium_url || eventData.image?.screen_url || null;
            issuesList = eventData.issues || eventData.issue_credits || [];

            Logger.log(`[Auto-Build] Found ComicVine Arc: "${eventName}". Total issues: ${issuesList.length}.`, 'info');

            if (issuesList.length === 0) {
                return NextResponse.json({ error: "Event found, but ComicVine has no issues attached to it." }, { status: 404 });
            }
        }

        // 3. Create the List in Omnibus
        Logger.log(`[Auto-Build] Creating Reading List database entry for "${eventName}"...`, 'info');
        const newList = await prisma.readingList.create({
            data: {
                name: eventName,
                description: eventDescription,
                coverUrl: eventCoverUrl,
                userId: isGlobal ? null : (userId || null) 
            }
        });

        const issuesToCreate = [];
        let orderCounter = 1;

        Logger.log(`[Auto-Build] Fuzzy matching ${issuesList.length} issues against local library...`, 'info');

        // 4. Map the issues based on the Source platform's data structure
        for (const issueObj of issuesList) {
            const targetId = parseInt(issueObj.id);
            
            const existingIssue = await prisma.issue.findFirst({
                where: { metadataId: targetId.toString(), metadataSource: eventSource }
            });

            // Metron returns 'number', ComicVine returns 'issue_number'
            const issueNum = issueObj.number || issueObj.issue_number || issueObj.issue || '?';
            let issueTitle = issueObj.name || issueObj.issue_name;

            // Handle Metron's nested series object vs ComicVine's volume object
            if (!issueTitle && issueObj.series?.name) {
                issueTitle = `${issueObj.series.name} #${issueNum}`;
            } else if (!issueTitle && issueObj.volume?.name) {
                issueTitle = `${issueObj.volume.name} #${issueNum}`; 
            } else if (!issueTitle) {
                issueTitle = `Issue #${issueNum}`;
            }

            // NEW: Extremely detailed matching trace
            if (existingIssue) {
                Logger.log(`[Auto-Build Debug] Matched arc item [ID: ${targetId}] to local file: ${existingIssue.filePath}`, 'debug');
            } else {
                Logger.log(`[Auto-Build Debug] Could NOT find local file match for arc item [ID: ${targetId}] ("${issueTitle}")`, 'debug');
            }

            issuesToCreate.push({
                listId: newList.id,
                issueId: existingIssue ? existingIssue.id : null,
                cvIssueId: eventSource === 'COMICVINE' ? targetId : null,
                title: issueTitle,
                order: orderCounter++
            });
        }

        if (issuesToCreate.length > 0) {
            Logger.log(`[Auto-Build] Saving ${issuesToCreate.length} mapped issues to the reading list...`, 'info');
            await prisma.readingListItem.createMany({ data: issuesToCreate });
        }

        Logger.log(`[Auto-Build] Successfully completed building "${eventName}"!`, 'info');
        return NextResponse.json({ success: true, listId: newList.id, message: `Imported ${issuesToCreate.length} issues into ${eventName}!` });

    } catch (error: unknown) {
        Logger.log(`[Auto-Build] Fatal Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}