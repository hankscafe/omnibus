export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { prisma } from '@/lib/db';

/**
 * INTERNAL FUNCTION: Handles moving files and updating DB
 */
async function processDownload(requestId: string, fileName: string, config: any) {
  const source = path.join(config.download_path, fileName);
  
  // 1. Fetch Request & Related Series
  const request = await prisma.request.findUnique({ 
      where: { id: requestId }
  });

  if (!request) return { success: false, error: "Request not found" };

  const series = await prisma.series.findUnique({ 
      where: { cvId: parseInt(request.volumeId) } 
  });

  if (!series) return { success: false, error: "Associated Series not found" };
  
  // Check if file exists
  if (!fs.existsSync(source)) {
    return { success: false, error: "Source file not found (already moved?)" };
  }

  // 2. Prepare Destination
  // Use stored folderPath or fallback to "Name (Year)"
  const seriesFolder = series.folderPath || `${series.name} (${series.year})`.replace(/[<>:"/\\|?*]/g, '');
  const destDir = path.join(config.library_path, seriesFolder);
  const destFile = path.join(destDir, fileName);

  try {
    await fs.ensureDir(destDir);
    await fs.move(source, destFile, { overwrite: true });

    // 3. Update Database
    await prisma.$transaction(async (tx) => {
      // Mark Request as IMPORTED
      await tx.request.update({
        where: { id: requestId },
        data: { status: 'IMPORTED', progress: 100 }
      });

      // If this was a specific Issue request, we can create the Issue record now.
      if (request.issueId) {
          // --- FIXED: PARSE FLOAT NUMBER EXTRACTION ---
          const rawIssueMatch = fileName.match(/(?:#|issue\s*#?)\s*(\d+(?:\.\d+)?)/i)?.[1] || "0";
          const issueNum = parseFloat(rawIssueMatch).toString();
          
          await tx.issue.upsert({
              where: { 
                  seriesId_number: {
                      seriesId: series.id,
                      number: issueNum
                  }
              },
              create: {
                  seriesId: series.id,
                  cvId: parseInt(request.issueId),
                  number: issueNum,
                  status: 'DOWNLOADED',
                  filePath: destFile
              },
              update: {
                  status: 'DOWNLOADED',
                  filePath: destFile
              }
          });
      }
    });

    return { success: true };
  } catch (error) {
    console.error("Post-Processing Error:", error);
    return { success: false, error };
  }
}

/**
 * MAIN ROUTE: Polls qBittorrent and triggers processing
 */
export async function GET() {
  try {
    const settings = await prisma.systemSetting.findMany();
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

    if (!config.qbit_url) {
      return NextResponse.json({ activeCount: 0, torrents: [], error: "qBittorrent not configured" });
    }

    // 1. Sanitize & Auth
    const qbitUrl = config.qbit_url.replace(/\/$/, "");
    const loginParams = new URLSearchParams();
    loginParams.append('username', config.qbit_username || '');
    loginParams.append('password', config.qbit_password || '');

    const authRes = await axios.post(`${qbitUrl}/api/v2/auth/login`, loginParams, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 3000 
    });
    
    const cookie = authRes.headers['set-cookie'];

    // 2. Get Torrents (FILTERED BY CATEGORY)
    // We strictly ask for category='comics' to ignore movies/games
    const { data: torrents } = await axios.get(`${qbitUrl}/api/v2/torrents/info`, {
      params: { category: 'comics' }, 
      headers: { Cookie: cookie },
      timeout: 3000
    });

    // 3. Match Logic
    const activeRequests = await prisma.request.findMany({
        where: { status: 'DOWNLOADING' }
    });

    const volumeIds = activeRequests.map(r => parseInt(r.volumeId));
    const seriesList = await prisma.series.findMany({
        where: { cvId: { in: volumeIds } }
    });

    for (const torrent of torrents) {
      if (torrent.progress === 1) {
        const matchedRequest = activeRequests.find(req => {
            const series = seriesList.find(s => s.cvId === parseInt(req.volumeId));
            if (!series) return false;
            return torrent.name.toLowerCase().includes(series.name.toLowerCase());
        });

        if (matchedRequest) {
          try {
             await processDownload(matchedRequest.id, torrent.name, config);
          } catch (err) {
             console.error(`Failed to process ${torrent.name}`, err);
          }
        }
      }
    }

    return NextResponse.json({ 
      activeCount: torrents.length,
      torrents: torrents.map((t: any) => ({ name: t.name, progress: t.progress, status: t.state }))
    });

  } catch (error: any) {
    const msg = error.response ? `qBit Error: ${error.response.status}` : error.message;
    return NextResponse.json({ 
        activeCount: 0, 
        torrents: [],
        error: `Connection Failed: ${msg}` 
    });
  }
}