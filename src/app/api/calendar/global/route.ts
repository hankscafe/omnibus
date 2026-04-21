// src/app/api/calendar/global/route.ts
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import axios from 'axios';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function GET(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { searchParams } = new URL(request.url);
        const weekOffset = parseInt(searchParams.get('weekOffset') || '0', 10);

        // 1. Calculate Rolling 7-Day Window Starting from TODAY
        const today = new Date();
        const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
        start.setUTCDate(start.getUTCDate() + (weekOffset * 7));

        const end = new Date(start);
        end.setUTCDate(start.getUTCDate() + 6); // 7 day window inclusive

        const startDateStr = start.toISOString().split('T')[0];
        const endDateStr = end.toISOString().split('T')[0];
        const todayStr = today.toISOString().split('T')[0];
        
        // Bumped to v7 to force a cache bust and use the simplified logic
        const cacheKey = `calendar_global_v7_${todayStr}_offset_${weekOffset}`;
        
        const cache = await prisma.systemSetting.findUnique({ where: { key: cacheKey } });

        if (cache && cache.value) {
            return NextResponse.json({ 
                startDate: startDateStr, 
                endDate: endDateStr, 
                releases: JSON.parse(cache.value) 
            });
        }

        // 2. Fetch Metron Credentials
        const settings = await prisma.systemSetting.findMany({
            where: { key: { in: ['metron_user', 'metron_pass'] } }
        });
        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

        if (!config.metron_user || !config.metron_pass) {
            return NextResponse.json({ error: "Metron credentials missing in Settings. Cannot fetch global pull list." }, { status: 400 });
        }

        // 3. Fetch Weekly Issues from Metron
        let nextUrl = `https://metron.cloud/api/issue/?store_date_range_after=${startDateStr}&store_date_range_before=${endDateStr}`;
        let allIssues: any[] = [];

        while (nextUrl && allIssues.length < 1000) {
            const res = await axios.get(nextUrl, {
                auth: { username: config.metron_user, password: config.metron_pass },
                headers: { 'User-Agent': 'Omnibus/1.0' },
                timeout: 15000
            });
            if (res.data && res.data.results) {
                allIssues.push(...res.data.results);
            }
            nextUrl = res.data.next;
            if (nextUrl) await new Promise(r => setTimeout(r, 1000));
        }

        // 4. CROSS-REFERENCE LOCAL DATABASE
        const localSeries = await prisma.series.findMany({
            select: { id: true, name: true, publisher: true, metadataId: true, metadataSource: true, monitored: true }
        });
        
        const nameToPubMap = new Map<string, string>();
        localSeries.forEach(s => {
            if (s.name && s.publisher && s.publisher !== "Unknown") {
                nameToPubMap.set(s.name.toLowerCase().trim(), s.publisher);
            }
        });

        // 5. Format the releases
        const formattedReleases = allIssues.map(issue => {
            const rawSeriesName = typeof issue.series === 'object' ? issue.series?.name : issue.series;
            const seriesName = rawSeriesName ? rawSeriesName.trim() : "Unknown";
            const normalizedName = seriesName.toLowerCase();
            
            // Link a local volumeId so the Request/Subscribe buttons work properly
            const localMatch = localSeries.find(s => s.name.toLowerCase().trim() === normalizedName);
            const volumeId = localMatch ? localMatch.metadataId : (typeof issue.series === 'object' ? issue.series?.id : null);
            const metadataSource = localMatch ? localMatch.metadataSource : 'METRON'; // <-- ADDED THIS
            
            // Fallback to local DB publisher if we have it, else Unknown
            const publisher = nameToPubMap.get(normalizedName) || localMatch?.publisher || "Unknown";

            return {
                id: issue.id,
                volumeId: volumeId,
                metadataSource: metadataSource, // <-- ADDED THIS
                seriesName: seriesName,
                issueNumber: issue.number || issue.issue || "1",
                publisher: publisher,
                releaseDate: issue.store_date || issue.cover_date,
                coverUrl: issue.image || null,
                description: issue.desc || issue.description || null,
                year: issue.series?.year_began?.toString() || startDateStr.split('-')[0]
            };
        });

        // 6. Auto-Inject Upcoming Issues into the Omnibus Tracked Series Tab
        const monitoredSeries = localSeries.filter(s => s.monitored);
        if (monitoredSeries.length > 0) {
            const existingIssues = await prisma.issue.findMany({
                where: { seriesId: { in: monitoredSeries.map(s => s.id) } },
                select: { seriesId: true, number: true }
            });

            const issuesToCreate = [];
            for (const release of formattedReleases) {
                const matchedSeries = monitoredSeries.find(s => s.name.toLowerCase().trim() === release.seriesName.toLowerCase().trim());
                if (matchedSeries) {
                    const alreadyExists = existingIssues.some(i => i.seriesId === matchedSeries.id && parseFloat(i.number) === parseFloat(release.issueNumber));
                    if (!alreadyExists) {
                        issuesToCreate.push({
                            seriesId: matchedSeries.id,
                            metadataId: release.id.toString(),
                            metadataSource: 'METRON',
                            matchState: 'MATCHED',
                            number: release.issueNumber?.toString() || '0',
                            name: release.seriesName,
                            releaseDate: release.releaseDate,
                            coverUrl: release.coverUrl,
                            status: 'WANTED'
                        });
                    }
                }
            }
            
            if (issuesToCreate.length > 0) {
                await prisma.issue.createMany({ data: issuesToCreate as any }).catch(()=> {});
                Logger.log(`[Global Calendar] Auto-injected ${issuesToCreate.length} upcoming issues for monitored series.`, 'success');
            }
        }

        // Cache the results for the day
        await prisma.systemSetting.upsert({
            where: { key: cacheKey },
            update: { value: JSON.stringify(formattedReleases) },
            create: { key: cacheKey, value: JSON.stringify(formattedReleases) }
        });

        // Cleanup old caches
        const oldDate = new Date(today);
        oldDate.setUTCDate(today.getUTCDate() - 1);
        const oldDateStr = oldDate.toISOString().split('T')[0];
        await prisma.systemSetting.deleteMany({ 
            where: { key: { startsWith: `calendar_global_v7_${oldDateStr}` } } 
        }).catch(()=>{});

        return NextResponse.json({ 
            startDate: startDateStr, 
            endDate: endDateStr, 
            releases: formattedReleases 
        });

    } catch (error: any) {
        Logger.log(`Global Calendar API Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: "Failed to fetch global releases from Metron." }, { status: 500 });
    }
}