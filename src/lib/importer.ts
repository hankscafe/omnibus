import fs from 'fs-extra';
import path from 'path';
import { prisma } from '@/lib/db';
import { DownloadService } from './download-clients';
import { Logger } from './logger';
import { resolveRemotePath } from './utils/path-resolver'; 
import axios from 'axios';
import { DiscordNotifier } from './discord';
import { syncSeriesMetadata } from './metadata-fetcher'; 

function sanitize(str: string) {
  return str.replace(/[<>:"/\\|?*]/g, '').trim();
}

function extractIssueNumber(filename: string): string {
    let clean = filename.replace(/\.\w+$/, ''); // Strip extension
    clean = clean.replace(/\[\d{4}\]/g, '').replace(/\(\d{4}\)/g, ''); // Strip years
    
    const explicitMatch = clean.match(/(?:#|issue\s*|vol(?:ume)?\s*|v\s*|ch(?:apter)?\s*)0*(\d+(?:\.\d+)?)/i);
    if (explicitMatch) return parseFloat(explicitMatch[1]).toString();
    
    const matches = [...clean.matchAll(/(?:[^a-zA-Z0-9]|^)0*(\d+(?:\.\d+)?)(?:[^a-zA-Z0-9]|$)/g)];
    if (matches.length > 0) return parseFloat(matches[matches.length - 1][1]).toString();
    
    return "0";
}

export const Importer = {
  async importRequest(requestId: string) {
    const req = await prisma.request.findUnique({ 
        where: { id: requestId },
        include: { user: true } 
    });
    
    if (!req || req.status === 'COMPLETED' || req.status === 'IMPORTED') return false;

    Logger.log(`[Importer] Starting import for: ${req.activeDownloadName || requestId}`, 'info');

    const settings = await prisma.systemSetting.findMany();
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
    const cvApiKey = config.cv_api_key;

    let series = await prisma.series.findFirst({ where: { cvId: parseInt(req.volumeId) } });
    
    if (!series && cvApiKey) {
        try {
            Logger.log(`[Importer] Fetching missing metadata for Volume ID: ${req.volumeId}`, 'info');
            const cvRes = await axios.get(`https://comicvine.gamespot.com/api/volume/4050-${req.volumeId}/`, {
                params: { api_key: cvApiKey, format: 'json', field_list: 'id,publisher,name,start_year' },
                headers: { 'User-Agent': 'Omnibus/1.0' }
            });
            const data = cvRes.data.results;
            if (data) {
                series = await prisma.series.create({
                    data: {
                        cvId: data.id,
                        name: data.name,
                        year: parseInt(data.start_year) || 0,
                        publisher: data.publisher?.name || "Other",
                        folderPath: "" 
                    }
                });
            }
        } catch (e) {
            Logger.log("[Importer] Metadata pre-fetch failed during import", "error");
        }
    }

    const mangaPublishers = config.manga_publishers ? config.manga_publishers.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean) : [];
    const mangaKeywords = config.manga_keywords ? config.manga_keywords.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean) : [];

    let isManga = false;
    const pubName = (series?.publisher || "").toLowerCase();
    const volName = (series?.name || req.activeDownloadName || "").toLowerCase();

    if (mangaPublishers.some((p: string) => pubName.includes(p))) isManga = true;
    if (mangaKeywords.some((k: string) => volName.includes(k))) isManga = true;

    let libraryRoot = config.library_path;
    if (isManga && config.manga_library_path) {
        libraryRoot = config.manga_library_path;
        Logger.log(`[Importer] Auto-routed to Manga Library`, "info");
    }

    if (!libraryRoot) {
      Logger.log("[Importer] No Library Path found for this import!", "error");
      return false;
    }

    const publisherName = (series?.publisher && series.publisher !== "Unknown") ? sanitize(series.publisher) : "Other";
    const rawSeriesName = series ? series.name : (req.activeDownloadName || "Request_" + requestId);
    const cleanSeriesName = rawSeriesName.replace(/\s*#\d+.*$/, '').trim();
    const seriesYear = series?.year || req.activeDownloadName?.match(/\((\d{4})\)/)?.[1] || "";
    
    const seriesFolderName = sanitize(`${cleanSeriesName} ${seriesYear ? `(${seriesYear})` : ''}`.trim());
    const idealDestFolder = path.join(libraryRoot, publisherName, seriesFolderName);

    let destFolder = "";
    if (series?.folderPath && series.folderPath.trim() !== "") {
        if (series.folderPath !== idealDestFolder && fs.existsSync(series.folderPath)) {
            try {
                Logger.log(`[Importer] Metadata updated. Auto-relocating folder to: ${idealDestFolder}`, "info");
                await fs.ensureDir(path.dirname(idealDestFolder));
                await fs.move(series.folderPath, idealDestFolder, { overwrite: false });
                
                await prisma.series.update({
                    where: { id: series.id },
                    data: { folderPath: idealDestFolder }
                });

                const existingIssues = await prisma.issue.findMany({ where: { seriesId: series.id } });
                for (const issue of existingIssues) {
                    if (issue.filePath && issue.filePath.startsWith(series.folderPath)) {
                        const newIssuePath = issue.filePath.replace(series.folderPath, idealDestFolder);
                        await prisma.issue.update({
                            where: { id: issue.id },
                            data: { filePath: newIssuePath }
                        });
                    }
                }
                destFolder = idealDestFolder;
            } catch (moveErr: any) {
                destFolder = series.folderPath;
            }
        } else if (series.folderPath !== idealDestFolder && !fs.existsSync(series.folderPath)) {
            destFolder = idealDestFolder;
        } else {
            destFolder = series.folderPath;
        }
    } else {
        destFolder = idealDestFolder;
    }

    let sourcePath = "";
    const downloadRoot = config.download_path || './downloads';

    if (req.downloadHash) {
      try {
          const allActive = await DownloadService.getAllActiveDownloads();
          const downloadItem = allActive.find((t: any) => t.id === req.downloadHash);
          if (!downloadItem) {
            Logger.log("[Importer] Download not found in active client list.", "error");
            return false;
          }
          const rawPath = path.join(downloadRoot, downloadItem.name);
          sourcePath = await resolveRemotePath(rawPath);
      } catch (e: any) {
          Logger.log(`[Importer] Failed to fetch client info: ${e.message}`, "error");
          return false;
      }
    } else {
      const rawPath = path.join(downloadRoot, 'GetComics', req.activeDownloadName || "");
      sourcePath = await resolveRemotePath(rawPath);

      if (!fs.existsSync(sourcePath)) {
          const legacyRawPath = path.join(downloadRoot, req.activeDownloadName || "");
          const legacySourcePath = await resolveRemotePath(legacyRawPath);
          if (fs.existsSync(legacySourcePath)) {
              sourcePath = legacySourcePath;
          }
      }
    }

    await new Promise(r => setTimeout(r, 1000));

    if (!fs.existsSync(sourcePath)) {
      Logger.log(`[Importer] Source file not found at: ${sourcePath}. Check Path Mappings!`, "error");
      return false;
    }

    const rawFileName = path.basename(sourcePath);
    const fileName = sanitize(rawFileName); 
    let finalPath = path.join(destFolder, fileName);

    try {
      await fs.ensureDir(destFolder);

      if (fs.existsSync(finalPath)) {
        finalPath = path.join(destFolder, `${Date.now()}_${fileName}`);
      }
      
      let moveSuccess = false;
      for (let attempt = 1; attempt <= 5; attempt++) {
          try {
              if (!fs.existsSync(sourcePath)) {
                  Logger.log(`[Importer] Source file vanished before move: ${sourcePath}`, "error");
                  break; 
              }

              if (req.downloadHash) {
                  Logger.log(`[Importer] Copying Torrent to Library: ${sourcePath} -> ${finalPath}`, "info");
                  await fs.copy(sourcePath, finalPath, { overwrite: true });
              } else {
                  Logger.log(`[Importer] Moving DDL to Library: ${sourcePath} -> ${finalPath}`, "info");
                  await fs.move(sourcePath, finalPath, { overwrite: true });
              }
              
              moveSuccess = true;
              break; 
          } catch (err: any) {
              if (err.code === 'ENOENT' || err.code === 'EBUSY' || err.code === 'EPERM') {
                  Logger.log(`[Importer] Network File Lock detected (Attempt ${attempt}/5). Retrying in 3s...`, "info");
                  await new Promise(r => setTimeout(r, 3000));
              } else {
                  throw err;
              }
          }
      }

      if (!moveSuccess) {
          throw new Error("Failed to move file after multiple attempts due to network locks.");
      }

      if (series?.id) {
         const issueNum = extractIssueNumber(fileName);
         
         await prisma.issue.upsert({
             where: {
                 seriesId_number: {
                     seriesId: series.id,
                     number: issueNum
                 }
             },
             create: {
                 seriesId: series.id,
                 cvId: -Math.abs(Math.floor(Math.random() * 1000000000)),
                 number: issueNum,
                 status: 'DOWNLOADED',
                 filePath: finalPath
             },
             update: {
                 status: 'DOWNLOADED',
                 filePath: finalPath
             }
         });

         try {
             await prisma.series.update({
                 where: { id: series.id },
                 data: { folderPath: destFolder }
             });
         } catch (e) { }
      }

      try {
          Logger.log("[Importer] Triggering direct internal metadata sync...", "info");
          await syncSeriesMetadata(parseInt(req.volumeId), destFolder);
      } catch (syncErr: any) {
          Logger.log(`[Importer] Metadata sync failed: ${syncErr.message}`, "warn");
      }

      await prisma.request.update({
        where: { id: requestId },
        data: { status: 'COMPLETED', progress: 100 }
      });

      // FIXED: Inject rich metadata on success
      await DiscordNotifier.sendAlert('comic_available', {
          title: req.activeDownloadName || series?.name || "Unknown Comic",
          imageUrl: req.imageUrl,
          user: req.user?.username,
          description: series?.description,
          publisher: series?.publisher,
          year: series?.year?.toString()
      });

      Logger.log(`[Importer] Successfully imported to: ${destFolder}`, "success");
      return true;

    } catch (e: any) {
      Logger.log(`[Importer] Import Failed: ${e.message}`, "error");
      if (req) {
          // FIXED: Inject rich metadata on failure
          await DiscordNotifier.sendAlert('download_failed', {
              title: req.activeDownloadName || series?.name || "Unknown Comic",
              imageUrl: req.imageUrl,
              user: req.user?.username,
              description: series?.description,
              publisher: series?.publisher,
              year: series?.year?.toString()
          });
      }
      return false;
    }
  }
};