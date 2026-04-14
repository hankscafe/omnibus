// src/lib/importer.ts
import fs from 'fs-extra';
import path from 'path';
import { prisma } from '@/lib/db';
import { DownloadService } from './download-clients';
import { Logger } from './logger';
import { resolveRemotePath } from './utils/path-resolver'; 
import axios from 'axios';
import { DiscordNotifier } from './discord';
import { Mailer } from './mailer';
import { syncSeriesMetadata } from './metadata-fetcher'; 
import { detectManga } from './manga-detector';
import AdmZip from 'adm-zip';

function sanitize(str: string) {
  return str.replace(/[<>:"/\\|?*]/g, '').trim();
}

function extractIssueNumber(filename: string): string {
    let clean = filename.replace(/\.\w+$/, ''); 
    clean = clean.replace(/\[\d{4}(?:-\d{4})?\]/g, '').replace(/\(\d{4}(?:-\d{4})?\)/g, ''); 
    
    const explicitMatch = clean.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v\s*\.?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?[a-zA-Z]?)/i);
    if (explicitMatch) {
        return explicitMatch[1].replace(/^0+(?=\d)/, '');
    }
    
    const matches = [...clean.matchAll(/(?<=^|[^a-zA-Z0-9])0*(\d+(?:\.\d+)?[a-zA-Z]?)(?=[^a-zA-Z0-9]|$)/g)];
    if (matches.length > 0) {
        return matches[matches.length - 1][1].replace(/^0+(?=\d)/, '');
    }
    
    return "1"; 
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

    let sourcePath = "";
    let isFromClient = false;
    const downloadRoot = config.download_path || './downloads';
    const trackingHash = req.downloadLink && !req.downloadLink.startsWith('http') ? req.downloadLink : null;

    if (trackingHash) {
      try {
          const allActive = await DownloadService.getAllActiveDownloads();
          const downloadItem = allActive.find((t: any) => t.id === trackingHash || t.name === req.activeDownloadName);
          if (downloadItem) {
              isFromClient = true;
              const rawPath = path.join(downloadRoot, downloadItem.name);
              sourcePath = await resolveRemotePath(rawPath);
          } else {
              Logger.log("[Importer] Download not found in active client list. Falling back to folder search.", "warn");
          }
      } catch (e: any) {
          Logger.log(`[Importer] Failed to fetch client info: ${e.message}`, "error");
      }
    } 
    
    if (!sourcePath) {
      const rootRawPath = path.join(downloadRoot, req.activeDownloadName || "");
      const rootSourcePath = await resolveRemotePath(rootRawPath);
      
      const getComicsRawPath = path.join(downloadRoot, 'GetComics', req.activeDownloadName || "");
      const getComicsSourcePath = await resolveRemotePath(getComicsRawPath);

      if (fs.existsSync(rootSourcePath)) {
          sourcePath = rootSourcePath; 
          isFromClient = true; 
      } else if (fs.existsSync(getComicsSourcePath)) {
          sourcePath = getComicsSourcePath; 
          isFromClient = false; 
      } else {
          sourcePath = rootSourcePath; 
      }
    }

    await new Promise(r => setTimeout(r, 1000));

    if (!fs.existsSync(sourcePath)) {
        const extensions = ['.cbz', '.cbr', '.zip', '.rar', '.cb7', '.epub'];
        for (const ext of extensions) {
            if (fs.existsSync(sourcePath + ext)) {
                sourcePath = sourcePath + ext;
                break;
            }
        }
    }

    if (!fs.existsSync(sourcePath)) {
      const parentDir = path.dirname(sourcePath);
      const isDriveOnline = fs.existsSync(parentDir) || fs.existsSync(downloadRoot);

      Logger.log(`[Importer] Source file not found at: ${sourcePath}. Check Path Mappings!`, "error");
      
      if (isDriveOnline) {
          const currentRetries = req.retryCount || 0;
          if (currentRetries > 20) { 
              Logger.log(`[Importer] Source file permanently missing for 20+ cycles. Marking request as STALLED.`, "warn");
              await prisma.request.update({
                  where: { id: req.id },
                  data: { status: 'STALLED' }
              });
          } else {
              await prisma.request.update({
                  where: { id: req.id },
                  data: { retryCount: currentRetries + 1 }
              });
          }
      }
      return false;
    }

    if ((req.retryCount || 0) > 0) {
        await prisma.request.update({
            where: { id: req.id },
            data: { retryCount: 0 }
        });
    }

    let actualSourceFile = sourcePath;
    if (fs.statSync(sourcePath).isDirectory()) {
        const files = await fs.promises.readdir(sourcePath);
        let largestFile = "";
        let largestSize = 0;
        for (const f of files) {
            if (f.match(/\.(cbz|cbr|zip|rar|cb7|epub)$/i)) {
                const stat = fs.statSync(path.join(sourcePath, f));
                if (stat.size > largestSize) {
                    largestSize = stat.size;
                    largestFile = path.join(sourcePath, f);
                }
            }
        }
        if (largestFile) {
            actualSourceFile = largestFile;
            Logger.log(`[Importer] Extracted archive from folder: ${path.basename(actualSourceFile)}`, "info");
        } else {
            Logger.log(`[Importer] No valid comic archive found inside folder: ${sourcePath}`, "error");
            return false;
        }
    }

    let series = await prisma.series.findFirst({ 
        where: { metadataId: req.volumeId, metadataSource: 'COMICVINE' } 
    });
    
    if (!series && cvApiKey && req.volumeId !== "0") {
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
                        metadataId: data.id.toString(),
                        metadataSource: 'COMICVINE',
                        matchState: 'MATCHED',
                        name: data.name,
                        year: parseInt(data.start_year) || 0,
                        publisher: data.publisher?.name || "Other",
                        folderPath: "" 
                    }
                });
            }
        } catch (e) {
            Logger.log("[Importer] Metadata pre-fetch failed during import", "warn");
        }
    }

    let isManga = false;
    let cleanSeriesName = (req.activeDownloadName || path.basename(sourcePath))
        .replace(/\.[^/.]+$/, "") 
        .replace(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v|ch(?:apter)?\s*\.?)\s*(\d+(?:\.\d+)?)/i, '') 
        .replace(/\[.*?\]/g, '') 
        .replace(/\(.*?\)/g, '') 
        .trim();

    if (series) {
        isManga = (series as any).isManga || false;
    } else {
        const seriesYearMatch = (req.activeDownloadName || path.basename(sourcePath)).match(/\((\d{4})\)/);
        const detectedYear = seriesYearMatch ? parseInt(seriesYearMatch[1]) : 0;
        isManga = await detectManga({ name: cleanSeriesName, publisher: { name: 'Other' }, year: detectedYear }, actualSourceFile);
    }

    const libraries = await prisma.library.findMany();
    let targetLibrary = null;

    if (series && series.libraryId) {
        targetLibrary = libraries.find(l => l.id === series.libraryId);
    }

    if (!targetLibrary) {
        if (isManga) {
            targetLibrary = libraries.find(l => l.isDefault && l.isManga) || libraries.find(l => l.isManga);
        }
        if (!targetLibrary) {
            targetLibrary = libraries.find(l => l.isDefault && !l.isManga) || libraries.find(l => !l.isManga) || libraries[0];
        }
    }

    const libraryRoot = targetLibrary?.path;

    if (!libraryRoot) {
      Logger.log("[Importer] No Library Path found for this import! Please add a Library in Settings.", "error");
      return false;
    }

    if (isManga && targetLibrary.isManga) {
        Logger.log(`[Importer] Auto-routed to Manga Library: ${targetLibrary.name}`, "info");
    }

    const folderPattern = config.folder_naming_pattern || "{Publisher}/{Series} ({Year})";
    const filePattern = config.file_naming_pattern || "{Series} #{Issue}";
    const mangaFilePattern = config.manga_file_naming_pattern || "{Series} Vol. {Issue}";

    const publisherName = (series?.publisher && series.publisher !== "Unknown") ? sanitize(series.publisher) : "Other";
    const seriesYearFromMeta = series?.year || req.activeDownloadName?.match(/\((\d{4})\)/)?.[1] || "";
    const seriesNameFromMeta = series?.name || cleanSeriesName;
    
    let relFolderPath = folderPattern
        .replace(/{Publisher}/gi, publisherName)
        .replace(/{Series}/gi, sanitize(seriesNameFromMeta))
        .replace(/{Year}/gi, seriesYearFromMeta.toString())
        .replace(/\(\s*\)/g, '') 
        .replace(/\[\s*\]/g, '') 
        .replace(/\s+/g, ' ')
        .trim();

    const folderParts = relFolderPath.split(/[/\\]/).map((p:string) => p.trim()).filter(Boolean);
    const idealDestFolder = path.join(libraryRoot, ...folderParts);

    let destFolder = "";
    if (series?.folderPath && series.folderPath.trim() !== "") {
        if (series.folderPath !== idealDestFolder && fs.existsSync(series.folderPath)) {
            try {
                Logger.log(`[Importer] Standardizing folder to: ${idealDestFolder}`, "info");
                await fs.ensureDir(path.dirname(idealDestFolder));
                await fs.move(series.folderPath, idealDestFolder, { overwrite: false });
                
                await prisma.series.update({
                    where: { id: series.id },
                    data: { folderPath: idealDestFolder, libraryId: targetLibrary.id }
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

    const rawFileName = path.basename(actualSourceFile);
    const ext = path.extname(rawFileName);
    const extractedNum = extractIssueNumber(rawFileName);
    
    let formattedNum = extractedNum;
    if (!extractedNum.includes('.') && extractedNum.length === 1) formattedNum = `0${extractedNum}`;
    
    const filePatToUse = isManga ? mangaFilePattern : filePattern;
    let newFileName = filePatToUse
        .replace(/{Publisher}/gi, publisherName)
        .replace(/{Series}/gi, sanitize(seriesNameFromMeta))
        .replace(/{Year}/gi, seriesYearFromMeta.toString())
        .replace(/{Issue}/gi, formattedNum)
        .replace(/\(\s*\)/g, '')
        .replace(/\[\s*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    let fileName = `${sanitize(newFileName)}${ext}`;
    let finalPath = path.join(destFolder, fileName);

    try {
      await fs.ensureDir(destFolder);

      if (fs.existsSync(finalPath)) {
        finalPath = path.join(destFolder, `${Date.now()}_${fileName}`);
      }
      
      let moveSuccess = false;
      for (let attempt = 1; attempt <= 5; attempt++) {
          try {
              if (!fs.existsSync(actualSourceFile)) {
                  Logger.log(`[Importer] Source file vanished before move: ${actualSourceFile}`, "error");
                  break; 
              }

              if (isFromClient || trackingHash) {
                  Logger.log(`[Importer] Copying Torrent to Library (Preserving Seed): ${actualSourceFile} -> ${finalPath}`, "info");
                  await fs.copy(actualSourceFile, finalPath, { overwrite: true });
              } else {
                  Logger.log(`[Importer] Moving DDL to Library: ${actualSourceFile} -> ${finalPath}`, "info");
                  await fs.move(actualSourceFile, finalPath, { overwrite: true });
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

      if (!moveSuccess) throw new Error("Failed to move file after multiple attempts due to network locks.");

      if (finalPath.toLowerCase().endsWith('.cbr') || finalPath.toLowerCase().endsWith('.rar')) {
          Logger.log(`[Import] CBR detected in library, converting to CBZ...`, 'info');
          const { convertCbrToCbz } = await import('./converter');
          const convertedPath = await convertCbrToCbz(finalPath);
          if (convertedPath) {
              finalPath = convertedPath;
              fileName = path.basename(finalPath);
          }
      }

      let pageCount = 0;
      let xmlMeta: any = null;

      if (finalPath.toLowerCase().match(/\.(cbz|zip|epub)$/i)) {
          try {
              const zip = new AdmZip(finalPath);
              pageCount = zip.getEntries().filter((e: any) => !e.isDirectory && !e.entryName.toLowerCase().includes('__macosx') && e.entryName.match(/\.(jpg|jpeg|png|webp)$/i)).length;
              
              const { parseComicInfo } = await import('./metadata-extractor');
              xmlMeta = await parseComicInfo(finalPath);
          } catch(e) {}
      }

      if (series?.id) {
         let issueNum = extractIssueNumber(fileName);
         if (xmlMeta?.number) issueNum = xmlMeta.number;
         
         const writersStr = xmlMeta?.writers?.length ? JSON.stringify(xmlMeta.writers) : null;
         const artistsStr = xmlMeta?.artists?.length ? JSON.stringify(xmlMeta.artists) : null;
         const charsStr = xmlMeta?.characters?.length ? JSON.stringify(xmlMeta.characters) : null;

         const existingIssue = await prisma.issue.findFirst({
             where: { seriesId: series.id, number: issueNum }
         });

         // --- CRITICAL FIX: Ensure the correct Match State and cvIssueId are injected! ---
         const targetMetaId = xmlMeta?.cvIssueId ? xmlMeta.cvIssueId.toString() : `unmatched_${Math.random()}`;
         const targetMetaSource = xmlMeta?.cvIssueId ? 'COMICVINE' : 'LOCAL';
         const matchState = xmlMeta?.cvIssueId ? 'MATCHED' : 'UNMATCHED';

         if (existingIssue) {
             await prisma.issue.update({
                 where: { id: existingIssue.id },
                 data: { 
                     status: 'DOWNLOADED', 
                     filePath: finalPath, 
                     pageCount,
                     name: existingIssue.name || xmlMeta?.title || null,
                     description: existingIssue.description || xmlMeta?.summary || null,
                     writers: existingIssue.writers && existingIssue.writers !== "[]" ? existingIssue.writers : writersStr,
                     artists: existingIssue.artists && existingIssue.artists !== "[]" ? existingIssue.artists : artistsStr,
                     characters: existingIssue.characters && existingIssue.characters !== "[]" ? existingIssue.characters : charsStr,
                     metadataId: existingIssue.metadataId?.startsWith('unmatched') ? targetMetaId : existingIssue.metadataId,
                     metadataSource: existingIssue.metadataSource === 'LOCAL' ? targetMetaSource : existingIssue.metadataSource,
                     matchState: existingIssue.matchState === 'UNMATCHED' ? matchState : existingIssue.matchState
                 }
             });
         } else {
             await prisma.issue.create({
                 data: {
                     seriesId: series.id, 
                     metadataId: targetMetaId,
                     metadataSource: targetMetaSource,
                     matchState: matchState,
                     number: issueNum, 
                     status: 'DOWNLOADED', 
                     filePath: finalPath, 
                     pageCount,
                     name: xmlMeta?.title || null,
                     description: xmlMeta?.summary || null,
                     writers: writersStr,
                     artists: artistsStr,
                     characters: charsStr
                 }
             });
         }

         try {
             await prisma.series.update({
                 where: { id: series.id },
                 data: { folderPath: destFolder, libraryId: targetLibrary.id }
             });
         } catch (e) { }
      }

      try {
          if (req.volumeId !== "0") {
              Logger.log("[Importer] Triggering direct internal metadata sync...", "info");
              await syncSeriesMetadata(req.volumeId, destFolder, series?.metadataSource || 'COMICVINE');
          }
      } catch (syncErr: any) {
          Logger.log(`[Importer] Metadata sync failed: ${syncErr.message}`, "warn");
      }

      await prisma.request.update({
        where: { id: requestId },
        data: { status: 'COMPLETED', progress: 100, notified: false }
      });

      if (trackingHash) {
          try {
              const ignoredSetting = await prisma.systemSetting.findUnique({ where: { key: 'ignored_downloads' } });
              let ignored: string[] = [];
              if (ignoredSetting?.value) {
                  try { ignored = JSON.parse(ignoredSetting.value); } catch(e) {}
              }
              if (!ignored.includes(trackingHash)) {
                  ignored.push(trackingHash);
                  await prisma.systemSetting.upsert({
                      where: { key: 'ignored_downloads' },
                      update: { value: JSON.stringify(ignored) },
                      create: { key: 'ignored_downloads', value: JSON.stringify(ignored) }
                  });
              }
          } catch (ignoreErr) { }
      }

      let shouldNotify = true;
      let notificationTitle = req.activeDownloadName || series?.name || "Unknown Comic";
      let notificationDesc = series?.description;

      if (req.volumeId && req.volumeId !== "0") {
          const activeStatuses = ['PENDING', 'DOWNLOADING', 'MANUAL_DDL', 'PENDING_APPROVAL', 'IMPORTING'];
          const pendingInVolume = await prisma.request.count({
              where: {
                  userId: req.userId,
                  volumeId: req.volumeId,
                  status: { in: activeStatuses }
              }
          });

          if (pendingInVolume > 0) {
              Logger.log(`[Importer] Delaying notification for ${req.activeDownloadName}. ${pendingInVolume} issues still active in volume.`, "info");
              shouldNotify = false;
          } else {
              const twoHoursBefore = new Date(req.createdAt.getTime() - 2 * 60 * 60 * 1000);
              const twoHoursAfter = new Date(req.createdAt.getTime() + 2 * 60 * 60 * 1000);

              const batchCount = await prisma.request.count({
                  where: {
                      userId: req.userId,
                      volumeId: req.volumeId,
                      status: { in: ['COMPLETED', 'IMPORTED'] },
                      createdAt: { gte: twoHoursBefore, lte: twoHoursAfter }
                  }
              });

              if (batchCount > 1) {
                  notificationTitle = `${series?.name || "Series"} - ${batchCount} Issues Available!`;
                  notificationDesc = `All ${batchCount} requested issues for ${series?.name || "this series"} have finished downloading and are now available in your library.\n\n${series?.description || ""}`;
              }
          }
      }

      if (shouldNotify) {
          await DiscordNotifier.sendAlert('comic_available', {
              title: notificationTitle,
              imageUrl: req.imageUrl,
              user: req.user?.username,
              description: notificationDesc,
              publisher: series?.publisher,
              year: series?.year?.toString()
          }).catch(() => {});
          
          await Mailer.sendAlert('comic_available', {
              title: notificationTitle,
              email: req.user?.email,
              user: req.user?.username,
              requester: req.user?.username,
              imageUrl: req.imageUrl,
              description: notificationDesc,
              date: new Date().toLocaleString()
          }).catch(() => {});
      }

      Logger.log(`[Importer] Successfully imported to: ${destFolder}`, "success");
      return true;

    } catch (e: any) {
      Logger.log(`[Importer] Import Failed: ${e.message}`, "error");
      if (req) {
          await DiscordNotifier.sendAlert('download_failed', {
              title: req.activeDownloadName || series?.name || "Unknown Comic",
              imageUrl: req.imageUrl,
              user: req.user?.username,
              description: series?.description,
              publisher: series?.publisher,
              year: series?.year?.toString()
          }).catch(() => {});
      }
      return false;
    }
  }
};