// src/app/api/calendar/global/route.ts
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
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

        // --- STRICT SUNDAY TO SATURDAY WEEK ALIGNMENT ---
        const today = new Date();
        const currentDayOfWeek = today.getUTCDay(); 
        
        const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
        start.setUTCDate(start.getUTCDate() - currentDayOfWeek + (weekOffset * 7));

        const end = new Date(start);
        end.setUTCDate(start.getUTCDate() + 6); // 7 day window inclusive

        const startDateStr = start.toISOString().split('T')[0];
        const endDateStr = end.toISOString().split('T')[0];
        const todayStr = today.toISOString().split('T')[0];
        
        // --- BUMP CACHE TO v15 TO INCLUDE MONITORED/LIBRARY STATUS ---
        const cacheKey = `calendar_global_v15_${todayStr}_offset_${weekOffset}`;
        
        const cache = await prisma.systemSetting.findUnique({ where: { key: cacheKey } });

        if (cache && cache.value) {
            return NextResponse.json({ 
                startDate: startDateStr, 
                endDate: endDateStr, 
                releases: JSON.parse(cache.value) 
            });
        }

        const settings = await prisma.systemSetting.findMany({
            where: { key: { in: ['metron_user', 'metron_pass'] } }
        });
        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

        if (!config.metron_user || !config.metron_pass) {
            return NextResponse.json({ error: "Metron credentials missing in Settings. Cannot fetch global pull list." }, { status: 400 });
        }

        // --- THE FIX: Native Fetch with Explicit Basic Auth Headers ---
        const authHeader = `Basic ${Buffer.from(`${config.metron_user}:${config.metron_pass}`).toString('base64')}`;
        
        let nextUrl: string | null = `https://metron.cloud/api/issue/?store_date_range_after=${startDateStr}&store_date_range_before=${endDateStr}`;
        const allIssues: any[] = [];

        Logger.log(`[Global Calendar] Fetching Metron Releases: ${nextUrl}`, 'info');

        while (nextUrl && allIssues.length < 1000) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            // --- FIX: Explicit Type Assignment ---
            const response: any = await fetch(nextUrl, {
                method: 'GET',
                headers: { 
                    'User-Agent': 'Omnibus/1.0',
                    'Authorization': authHeader
                },
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);

            if (response.status === 429) {
                const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10);
                Logger.log(`[Global Calendar] Metron Rate Limit hit (429)! Pausing for ${retryAfter} seconds...`, 'warn');
                await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
                continue;
            }

            // --- FIX: Explicit Type Assignment ---
            const data: any = await response.json().catch(() => ({}));

            if (data && data.results) {
                allIssues.push(...data.results);
            }
            nextUrl = data.next || null;
            
            // Proactive Burst Tracking via Fetch Headers
            const remaining = parseInt(response.headers.get('x-ratelimit-burst-remaining') || '20', 10);
            if (remaining <= 2) {
                const reset = parseInt(response.headers.get('x-ratelimit-burst-reset') || '0', 10);
                if (reset > 0) {
                    const sleepMs = Math.max(0, (reset * 1000) - Date.now()) + 500;
                    if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));
                } else {
                    await new Promise(r => setTimeout(r, 2000));
                }
            } else if (nextUrl) {
                await new Promise(r => setTimeout(r, 500));
            }
        }

        const localSeries = await prisma.series.findMany({
            select: { id: true, name: true, publisher: true, metadataId: true, metadataSource: true, monitored: true }
        });
        
        const nameToPubMap = new Map<string, string>();
        localSeries.forEach(s => {
            if (s.name && s.publisher && s.publisher !== "Unknown") {
                nameToPubMap.set(s.name.toLowerCase().trim(), s.publisher);
            }
        });

        const formattedReleases = allIssues.map(issue => {
            const rawSeriesName = typeof issue.series === 'object' ? issue.series?.name : issue.series;
            const seriesName = rawSeriesName ? rawSeriesName.trim() : "Unknown";
            const normalizedName = seriesName.toLowerCase();
            
            const localMatch = localSeries.find(s => s.name.toLowerCase().trim() === normalizedName);
            const volumeId = localMatch ? localMatch.metadataId : (typeof issue.series === 'object' ? issue.series?.id : null);
            const metadataSource = localMatch ? localMatch.metadataSource : 'METRON'; 
            const publisher = nameToPubMap.get(normalizedName) || localMatch?.publisher || "Unknown";

            return {
                id: issue.id,
                volumeId: volumeId,
                metadataSource: metadataSource, 
                seriesName: seriesName,
                issueNumber: issue.number || issue.issue || "1",
                publisher: publisher,
                releaseDate: issue.store_date || issue.cover_date,
                coverUrl: issue.image || null,
                description: issue.desc || issue.description || null,
                year: issue.series?.year_began?.toString() || startDateStr.split('-')[0],
                monitored: localMatch?.monitored || false,
                inLibrary: !!localMatch
            };
        });

        const monitoredSeries = localSeries.filter(s => s.monitored);
        if (monitoredSeries.length > 0) {
            const existingIssues = await prisma.issue.findMany({
                where: { seriesId: { in: monitoredSeries.map(s => s.id) } },
                select: { seriesId: true, number: true }
            });

            const issuesToCreate: any[] = [];
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
                await prisma.issue.createMany({ data: issuesToCreate }).catch(()=> {});
            }
        }

        await prisma.systemSetting.upsert({
            where: { key: cacheKey },
            update: { value: JSON.stringify(formattedReleases) },
            create: { key: cacheKey, value: JSON.stringify(formattedReleases) }
        });

        const oldDate = new Date(today);
        oldDate.setUTCDate(today.getUTCDate() - 1);
        const oldDateStr = oldDate.toISOString().split('T')[0];
        
        await prisma.systemSetting.deleteMany({ 
            where: { key: { startsWith: `calendar_global_v14_` } } 
        }).catch(()=>{});
        
        await prisma.systemSetting.deleteMany({ 
            where: { key: { startsWith: `calendar_global_v15_${oldDateStr}` } } 
        }).catch(()=>{});

        return NextResponse.json({ startDate: startDateStr, endDate: endDateStr, releases: formattedReleases });

    } catch (error: any) {
        Logger.log(`Global Calendar API Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: "Failed to fetch global releases from Metron." }, { status: 500 });
    }
}