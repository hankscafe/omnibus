import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import axios from 'axios';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    Logger.log('[Monitor Task] Starting scan for monitored series...', 'info');
    
    const monitoredSeries = await prisma.series.findMany({
      where: { monitored: true },
      include: { issues: true }
    });

    if (monitoredSeries.length === 0) {
      return NextResponse.json({ success: true, message: 'No monitored series found.' });
    }

    const cvKeySetting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
    if (!cvKeySetting?.value) throw new Error("Missing ComicVine API Key");

    let newIssuesFound = 0;

    for (const series of monitoredSeries) {
      try {
        Logger.log(`[Monitor Task] Checking CV for: ${series.name}`, 'info');
        
        const cvRes = await axios.get(`https://comicvine.gamespot.com/api/issues/`, {
          params: {
            api_key: cvKeySetting.value,
            format: 'json',
            filter: `volume:${series.cvId}`,
            field_list: 'id,name,issue_number,cover_date,store_date,image' 
          },
          headers: { 'User-Agent': 'Omnibus/1.0' }
        });

        const cvIssues = cvRes.data.results || [];

        for (const cvIssue of cvIssues) {
            const cvNum = parseFloat(cvIssue.issue_number);
            
            // 1. Check Issue Table (Exact CV ID or parsed number)
            const alreadyInLibrary = series.issues.some(i => 
                i.cvId === cvIssue.id || 
                parseFloat(i.number) === cvNum
            );
            if (alreadyInLibrary) continue;

            // 2. Check Request Table (Prevent double-requesting)
            // We check by volumeId and a fuzzy match on the name
            const searchName = `${series.name} #${cvIssue.issue_number}`;
            const alreadyRequested = await prisma.request.findFirst({
                where: { 
                    volumeId: series.cvId.toString(),
                    activeDownloadName: {
                        contains: `#${cvIssue.issue_number}`
                    }
                }
            });
            if (alreadyRequested) continue;

            // IT'S TRULY NEW!
            Logger.log(`[Monitor Task] Found new issue: ${searchName}`, 'success');
            
            const issueYear = (cvIssue.store_date || cvIssue.cover_date || series.year.toString() || "").split('-')[0];
            const issueImage = cvIssue.image?.medium_url || cvIssue.image?.small_url;
            const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });

            await prisma.request.create({
              data: {
                userId: admin?.id || 'system',
                volumeId: series.cvId.toString(),
                status: 'PENDING',
                activeDownloadName: searchName,
                imageUrl: issueImage
              }
            });

            // Trigger automation
            fetch(`${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/api/request/manual`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cvId: series.cvId,
                    name: searchName,
                    year: issueYear,
                    publisher: series.publisher,
                    image: issueImage,
                    type: 'issue',
                    source: 'getcomics',
                    searchResult: { title: searchName } 
                })
            }).catch(() => {});

            newIssuesFound++;
        }
        
        await new Promise(r => setTimeout(r, 1500));

      } catch (err) {
        Logger.log(`[Monitor Task] Failed to scan series ${series.name}`, 'error');
      }
    }

    return NextResponse.json({ success: true, message: `Scan complete. Queued ${newIssuesFound} new issues.` });

  } catch (error: any) {
    Logger.log(`[Monitor Task Error] ${error.message}`, 'error');
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}