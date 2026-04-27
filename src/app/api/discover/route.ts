// src/app/api/discover/route.ts
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db'; 
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function GET(request: Request) {
  try {
      const { searchParams } = new URL(request.url);
      const type = searchParams.get('type') || 'popular'; 
      
      // --- NEW: Handle Settings Fetch ---
      if (type === 'settings') {
          const settings = await prisma.systemSetting.findMany({
              where: { key: { in: ['show_popular_issues', 'show_new_releases'] } }
          });
          const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
          return NextResponse.json({
              showPopular: config.show_popular_issues !== 'false',
              showNew: config.show_new_releases !== 'false'
          });
      }
      
      const offset = parseInt(searchParams.get('offset') || '0', 10);
      const limit = parseInt(searchParams.get('limit') || '14', 10);
      
      const cacheKey = type === 'new' ? 'discover_cache_new' : 'discover_cache_popular';
      
      const cache = await prisma.systemSetting.findUnique({
          where: { key: cacheKey }
      });

      if (cache && cache.value) {
          const allResults = JSON.parse(cache.value);
          const slice = allResults.slice(offset, offset + limit);

          // --- FIX: Cross-reference with Library and Requests ---
          const volumeIds = slice.map((r: any) => r.cvId?.toString()).filter(Boolean);
          
          const existingRequests = await prisma.request.findMany({
              where: { volumeId: { in: volumeIds } },
              select: { volumeId: true, activeDownloadName: true, status: true }
          });

          const existingIssues = await prisma.issue.findMany({
              where: { series: { metadataId: { in: volumeIds } } },
              select: { number: true, series: { select: { metadataId: true } } }
          });

          const results = slice.map((r: any) => {
              const issueName = `${r.title} #${r.issueNumber}`;
              const request = existingRequests.find(req => 
                  req.volumeId === r.cvId?.toString() && req.activeDownloadName === issueName
              );
              const inLibrary = existingIssues.some(iss => 
                  iss.series.metadataId === r.cvId?.toString() && iss.number === r.issueNumber
              );

              return {
                  ...r,
                  image: r.image && r.image.startsWith('http') ? `/api/library/cover?path=${encodeURIComponent(r.image)}` : r.image,
                  requestStatus: request?.status || null,
                  inLibrary: inLibrary
              };
          });
          
          const nextOffset = (offset + limit < allResults.length) ? offset + limit : null;
          return NextResponse.json({ results, nextOffset });
      }

      return NextResponse.json({ results: [], nextOffset: null });

  } catch (error) {
      Logger.log(`Discovery API Error: ${getErrorMessage(error)}`, 'error');
      return NextResponse.json({ results: [], nextOffset: null }); 
  }
}