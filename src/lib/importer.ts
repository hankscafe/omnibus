// src/lib/importer.ts
import fs from 'fs-extra';
import path from 'path';
import { prisma } from '@/lib/db';
import { DownloadService } from './download-clients';
import { Logger } from './logger';
import { resolveRemotePath } from './utils/path-resolver'; 
import axios from 'axios';
import { SystemNotifier } from './notifications';
import { syncSeriesMetadata } from './metadata-fetcher'; 
import { detectManga } from './manga-detector';
import AdmZip from 'adm-zip';
import { isSameIssue, extractIssueNumber } from '@/lib/utils/issue-parser';
import { COMIC_EXTENSIONS, COMIC_EXT_REGEX, IMAGE_EXT_REGEX } from '@/lib/utils/formats';
import { sanitizeFilename as sanitize } from '@/lib/utils/sanitize';
import { WATCHED_DIR } from '@/lib/utils/paths';

function fixMagicNumberSync(filePath: string): string {
    try {
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return filePath;
        const buffer = Buffer.alloc(4);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buffer, 0, 4, 0);
        fs.closeSync(fd);
        const hex = buffer.toString('hex').toLowerCase();
        
        const currentExt = path.extname(filePath).toLowerCase();
        let trueExt = currentExt;

        if (hex === '52617221') {
            trueExt = '.cbr';
        } else if (hex === '504b0304') {
            trueExt = '.cbz';
        }

        if (trueExt !== currentExt && ((currentExt === '.cbz' || currentExt === '.zip') && trueExt === '.cbr' || (currentExt === '.cbr' || currentExt === '.rar') && trueExt === '.cbz')) {
            Logger.log(`[Importer] Detected fake extension (${currentExt} -> ${trueExt}) on destination file! Renaming to match true signature...`, 'info');
            const correctedPath = filePath.replace(/\.[^/.]+$/, trueExt);
            fs.renameSync(filePath, correctedPath);
            return correctedPath;
        }
    } catch (e: any) {
        Logger.log(`[Importer Debug] Failed to verify file signature for ${filePath}: ${e.message}`, 'warn');
    }
    return filePath;
}

export const Importer = {
  async importRequest(requestId: string) {
    const req = await prisma.request.findUnique({ 
        where: { id: requestId },
        include: { user: true } 
    });
    
    // Abort if the user cancelled the request while it was downloading
    if (!req || req.status === 'COMPLETED' || req.status === 'IMPORTED' || req.status === 'CANCELLED') return false;

    Logger.log(`[Importer] Starting import for: ${req.activeDownloadName || requestId}`, 'info');
    Logger.log(`[Importer Debug] Resolving physical path for request [${requestId}]...`, 'debug');

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
              
              // Fetch the specific client to check if it has a custom Local Path override
              const clientConfig = await prisma.downloadClient.findFirst({
                  where: { name: downloadItem.clientName }
              });
              
              const clientRoot = clientConfig?.localPath || downloadRoot;
              const rawPath = path.join(clientRoot, downloadItem.name);
              sourcePath = await resolveRemotePath(rawPath);
              
              Logger.log(`[Importer Debug] Using client root path: ${clientRoot} for ${downloadItem.name}`, 'debug');
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
        const extensions = COMIC_EXTENSIONS;
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

    // --- MAGIC NUMBER / FAKE EXTENSION FIXER (IN-MEMORY ONLY) ---
    // We only detect the true extension here to aid batch processing detection.
    // The actual file renaming is deferred until after the file has been copied/moved 
    // to its final destination to prevent breaking active torrent seeding.
    let inMemoryTrueExt = path.extname(sourcePath).toLowerCase();
    if (fs.existsSync(sourcePath) && !fs.statSync(sourcePath).isDirectory()) {
        try {
            const buffer = Buffer.alloc(4);
            const fd = fs.openSync(sourcePath, 'r');
            fs.readSync(fd, buffer, 0, 4, 0);
            fs.closeSync(fd);
            const hex = buffer.toString('hex').toLowerCase();
            
            if (hex === '52617221') {
                inMemoryTrueExt = '.cbr';
            } else if (hex === '504b0304') {
                inMemoryTrueExt = '.cbz';
            }
        } catch (e: any) {
            Logger.log(`[Importer Debug] Failed to verify file signature for in-memory check: ${e.message}`, 'warn');
        }
    }

    // --- BATCH DOWNLOAD DETECTION ---
    let actualSourceFile = sourcePath;
    let isBatchFolder = false;
    let isBatchArchive = false;
    let batchFiles: string[] = [];
    let nestedArchiveCount = 0; 

    if (fs.statSync(sourcePath).isDirectory()) {
        async function getComicFilesInDir(dir: string) {
            let results: string[] = [];
            const items = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                    results = results.concat(await getComicFilesInDir(fullPath));
                } else if (COMIC_EXT_REGEX.test(item.name)) {
                    results.push(fullPath);
                }
            }
            return results;
        }
        
        batchFiles = await getComicFilesInDir(sourcePath);

        if (batchFiles.length > 1) {
            isBatchFolder = true;
            Logger.log(`[Importer Debug] Detected multiple archives (${batchFiles.length}) in directory: ${sourcePath}`, 'debug');
        } else if (batchFiles.length === 1) {
            actualSourceFile = batchFiles[0];
            Logger.log(`[Importer] Extracted single archive from folder: ${path.basename(actualSourceFile)}`, "info");
        } else {
            Logger.log(`[Importer] No valid comic archive found inside folder: ${sourcePath}`, "error");
            return false;
        }
    } else {
        if (inMemoryTrueExt === '.zip' || inMemoryTrueExt === '.cbz') {
            try {
                const zip = new AdmZip(sourcePath);
                const entries = zip.getEntries();
                const comicFiles = entries.filter((e: any) => !e.isDirectory && COMIC_EXT_REGEX.test(e.entryName));
                
                if (comicFiles.length > 0) {
                    isBatchArchive = true;
                    nestedArchiveCount = comicFiles.length;
                    Logger.log(`[Importer Debug] Found ${nestedArchiveCount} nested archives inside ${path.basename(sourcePath)}`, 'debug');
                }
            } catch(e: any) {
                Logger.log(`[Importer Debug] Error inspecting zip for nested archives: ${e.message}`, 'error');
            }
        }
    }

    // --- BATCH ROUTING EXECUTION ---
    if (isBatchFolder || isBatchArchive) {
        const totalItems = isBatchFolder ? batchFiles.length : nestedArchiveCount;
        Logger.log(`[Importer Debug] Detected batch payload. isBatchFolder: ${isBatchFolder}, isBatchArchive: ${isBatchArchive}. Total items: ${totalItems}`, 'debug');
        Logger.log(`[Importer] Batch download detected. Routing to WATCHED folder...`, 'info');
        
        const watchedDir = WATCHED_DIR;
        await fs.ensureDir(watchedDir);
        let moveSuccessCount = 0;

        if (isBatchFolder) {
            for (const file of batchFiles) {
                Logger.log(`[Importer Debug] Routing nested file to Watched: ${path.basename(file)}`, 'debug');
                let finalDest = path.join(watchedDir, path.basename(file));
                if (fs.existsSync(finalDest)) {
                    finalDest = path.join(watchedDir, `${Date.now()}_${path.basename(file)}`);
                }
                try {
                    if (isFromClient || trackingHash) {
                        await fs.copy(file, finalDest, { overwrite: true });
                    } else {
                        await fs.move(file, finalDest, { overwrite: true });
                    }
                    
                    finalDest = fixMagicNumberSync(finalDest);

                    moveSuccessCount++;
                } catch(err: any) {
                    Logger.log(`[Importer Debug] Failed to route ${path.basename(file)} to Watched folder: ${err.message}`, 'warn');
                }
            }
            if (!isFromClient && !trackingHash) {
                try { await fs.remove(sourcePath); } catch(e) {}
            }
        } else if (isBatchArchive) {
            try {
                const zip = new AdmZip(sourcePath);
                const entries = zip.getEntries();
                for (const entry of entries) {
                    if (!entry.isDirectory && COMIC_EXT_REGEX.test(entry.entryName)) {
                        const fileName = path.basename(entry.entryName);
                        Logger.log(`[Importer Debug] Extracting nested archive from ZIP to Watched: ${fileName}`, 'debug');
                        let finalDest = path.join(watchedDir, fileName);
                        if (fs.existsSync(finalDest)) {
                            finalDest = path.join(watchedDir, `${Date.now()}_${fileName}`);
                        }
                        fs.writeFileSync(finalDest, entry.getData());
                        
                        finalDest = fixMagicNumberSync(finalDest);

                        moveSuccessCount++;
                    }
                }
                if (!isFromClient && !trackingHash) {
                    await fs.remove(sourcePath);
                }
            } catch (err: any) {
                Logger.log(`[Importer] Failed to extract batch archive: ${err.message}`, 'error');
                return false;
            }
        }

        // Safely clear the queue for anything sharing the link (Except missing match placeholders)
        if (req.downloadLink && req.downloadLink !== "PENDING_MATCH") {
            await prisma.request.updateMany({
                where: { downloadLink: req.downloadLink, status: 'DOWNLOADING' },
                data: { status: 'COMPLETED', progress: 100, notified: false }
            });
        } else {
            await prisma.request.update({
                where: { id: requestId },
                data: { status: 'COMPLETED', progress: 100, notified: false }
            });
        }

        try {
            const { omnibusQueue } = await import('./queue');
            await omnibusQueue.add('WATCHED_FOLDER_SYNC', { type: 'WATCHED_FOLDER_SYNC' }, {
                jobId: `WATCHED_SYNC_BATCH_${Date.now()}`
            });
        } catch(e) {}

        Logger.log(`[Importer] Successfully routed ${moveSuccessCount} files to Watched folder. Batch import complete.`, 'success');
        
        await SystemNotifier.sendAlert('comic_available', {
            title: `${req.activeDownloadName || "Batch Download"} - ${moveSuccessCount} Files`,
            imageUrl: req.imageUrl,
            user: req.user?.username,
            email: req.user?.email,
            description: `Your batch download has finished! The files have been sent to the Watched Folder for auto-tagging and organization.`,
            date: new Date().toLocaleString()
        });

        // CRITICAL: Only add trackingHash (Torrents) to the ignore list so DDLs can be re-downloaded later if needed!
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

        return true;
    }

    // --- DUAL PROVIDER METADATA FETCHING ---
    let series = await prisma.series.findFirst({ 
        where: { metadataId: req.volumeId, metadataSource: req.metadataSource || 'COMICVINE' } 
    });
    
    // Fetch missing Series record from ComicVine
    if (!series && cvApiKey && req.volumeId !== "0" && req.metadataSource !== 'METRON') {
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

    // Fetch missing Series record from Metron
    if (!series && req.volumeId !== "0" && req.metadataSource === 'METRON') {
        try {
            Logger.log(`[Importer] Fetching missing metadata for Metron Series ID: ${req.volumeId}`, 'info');
            const { MetronProvider } = await import('./metadata/providers/metron');
            const metron = new MetronProvider();
            const details = await metron.getSeriesDetails(req.volumeId);
            if (details) {
                series = await prisma.series.create({
                    data: {
                        metadataId: details.sourceId,
                        metadataSource: 'METRON',
                        matchState: 'MATCHED',
                        name: details.name,
                        year: details.year || 0,
                        publisher: details.publisher || "Other",
                        folderPath: "" 
                    }
                });
            }
        } catch (e) {
            Logger.log("[Importer] Metron metadata pre-fetch failed during import", "warn");
        }
    }

    let isManga = false;
    const cleanSeriesName = (req.activeDownloadName || path.basename(sourcePath))
        .replace(/\.[^/.]+$/, "") 
        // Added -? to strip negative signs so they don't pollute the series name
        .replace(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v|ch(?:apter)?\s*\.?)\s*(-?\d+(?:\.\d+)?)/i, '') 
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

    Logger.log(`[Importer Debug] Library Resolution -> isManga: ${isManga}, Target Library: "${targetLibrary?.name}", Path: "${targetLibrary?.path}"`, 'debug');

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
    const safeUniverse = (series as any)?.universe ? sanitize((series as any).universe) : "";
    // Series Group is not supplied by ComicVine/Metron — the folder uses the value already stored on
    // the series record (set by a prior scan or a manual edit). A group found only in this file's
    // ComicInfo.xml is persisted to the series below so subsequent imports/renames pick it up.
    const safeSeriesGroup = (series as any)?.seriesGroup ? sanitize((series as any).seriesGroup) : "";

    Logger.log(`[Importer Debug] Applying Folder Pattern: "${folderPattern}" | Variables -> Publisher: "${publisherName}", Series: "${seriesNameFromMeta}", Year: "${seriesYearFromMeta}"`, 'debug');

    const relFolderPath = folderPattern
        .replace(/{Publisher}/gi, publisherName)
        .replace(/{Series}/gi, sanitize(seriesNameFromMeta))
        .replace(/{Year}/gi, seriesYearFromMeta.toString())
        .replace(/{VolumeYear}/gi, seriesYearFromMeta.toString())
        .replace(/{UniverseName}/gi, safeUniverse)
        .replace(/{SeriesGroup}/gi, safeSeriesGroup)
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

    Logger.log(`[Importer Debug] Evaluated Folder Pattern: Publisher="${publisherName}", Series="${seriesNameFromMeta}", Year="${seriesYearFromMeta}" -> Result: ${destFolder}`, 'debug');

    let pageCount = 0;
    let xmlMeta: any = null;

    const isActualZip = inMemoryTrueExt === '.cbz' || inMemoryTrueExt === '.zip' || actualSourceFile.toLowerCase().match(/\.(cbz|zip|epub)$/i);

    if (isActualZip) {
        try {
            const zip = new AdmZip(actualSourceFile);
            pageCount = zip.getEntries().filter((e: any) => !e.isDirectory && !e.entryName.toLowerCase().includes('__macosx') && IMAGE_EXT_REGEX.test(e.entryName)).length;
            
            const { parseComicInfo } = await import('./metadata-extractor');
            xmlMeta = await parseComicInfo(actualSourceFile);
        } catch(e) {}
    }

    const rawFileName = path.basename(actualSourceFile);
    const ext = path.extname(rawFileName);
    const extractedNum = extractIssueNumber(rawFileName);
    Logger.log(`[Importer Debug] Extracted internal issue number as: ${extractedNum} from raw string: ${rawFileName}`, 'debug');
    
    let formattedNum = extractedNum;
    if (!extractedNum.includes('.') && extractedNum.length === 1) formattedNum = `0${extractedNum}`;
    
    // Sanitize the XML year to prevent ComicVine IDs in the filename
    let xmlYear = xmlMeta?.year;
    if (xmlYear && (xmlYear < 1900 || xmlYear > 2100)) {
        xmlYear = null;
    }
    
    const issueYearFromMeta = xmlMeta?.year ? xmlMeta.year.toString() : seriesYearFromMeta.toString();
    const filePatToUse = isManga ? mangaFilePattern : filePattern;
    
    const issueTitle = xmlMeta?.title || "";
    const universeName = xmlMeta?.universe || "";
    const seriesGroupName = xmlMeta?.seriesGroup || (series as any)?.seriesGroup || "";

    const newFileName = filePatToUse
        .replace(/{Publisher}/gi, publisherName)
        .replace(/{Series}/gi, sanitize(seriesNameFromMeta))
        .replace(/{Year}/gi, seriesYearFromMeta.toString())
        .replace(/{VolumeYear}/gi, seriesYearFromMeta.toString())
        .replace(/{IssueYear}/gi, issueYearFromMeta)
        .replace(/{Issue}/gi, formattedNum)
        .replace(/{IssueTitle}/gi, sanitize(issueTitle))
        .replace(/{UniverseName}/gi, sanitize(universeName))
        .replace(/{SeriesGroup}/gi, sanitize(seriesGroupName))
        .replace(/\(\s*\)/g, '')
        .replace(/\[\s*\]/g, '')
        .replace(/\s*-\s*-/g, ' - ') // Collapses double hyphens (e.g., " -  - " becomes " - ")
        .replace(/(^\s*-\s*|\s*-\s*$)/g, '') // Removes any leading or trailing hyphens
        .replace(/\s+/g, ' ')
        .trim();

    let fileName = `${sanitize(newFileName)}${ext}`;
    let finalPath = path.join(destFolder, fileName);
    
    Logger.log(`[Importer Debug] Evaluated File Pattern: Issue="${formattedNum}", IssueYear="${issueYearFromMeta}" -> Result: ${fileName}`, 'debug');
    Logger.log(`[Importer Debug] Target move operation: [${actualSourceFile}] -> [${finalPath}]`, 'debug');

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

      finalPath = fixMagicNumberSync(finalPath);
      fileName = path.basename(finalPath);

      if (finalPath.toLowerCase().endsWith('.cbr') || finalPath.toLowerCase().endsWith('.rar') || finalPath.toLowerCase().endsWith('.cb7')) {
          Logger.log(`[Import] CBR detected in library, converting to CBZ...`, 'info');
          const { convertCbrToCbz } = await import('./converter');
          const convertedPath = await convertCbrToCbz(finalPath);
          if (convertedPath) {
              finalPath = convertedPath;
              fileName = path.basename(finalPath);
          }
      }

      if (series?.id) {
         let issueNum = extractIssueNumber(fileName);
         if (xmlMeta?.number) issueNum = xmlMeta.number;
         
         const writersStr = xmlMeta?.writers?.length ? JSON.stringify(xmlMeta.writers) : null;
         const artistsStr = xmlMeta?.artists?.length ? JSON.stringify(xmlMeta.artists) : null;
         const charsStr = xmlMeta?.characters?.length ? JSON.stringify(xmlMeta.characters) : null;
         const coverArtistsStr = xmlMeta?.coverArtists?.length ? JSON.stringify(xmlMeta.coverArtists) : null;
         const coloristsStr = xmlMeta?.colorists?.length ? JSON.stringify(xmlMeta.colorists) : null;
         const letterersStr = xmlMeta?.letterers?.length ? JSON.stringify(xmlMeta.letterers) : null;
         const teamsStr = xmlMeta?.teams?.length ? JSON.stringify(xmlMeta.teams) : null;
         const locationsStr = xmlMeta?.locations?.length ? JSON.stringify(xmlMeta.locations) : null;

         const allSeriesIssues = await prisma.issue.findMany({
             where: { seriesId: series.id }
         });
         const existingIssue = allSeriesIssues.find(i => isSameIssue(i.number, issueNum));
         const targetMetaId = xmlMeta?.metadataIssueId ? xmlMeta.metadataIssueId.toString() : `unmatched_${Math.random()}`;
         const targetMetaSource = xmlMeta?.metadataIssueId ? xmlMeta.metadataSource : 'LOCAL';
         const matchState = xmlMeta?.metadataIssueId ? 'MATCHED' : 'UNMATCHED';

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
                     coverArtists: (existingIssue as any).coverArtists && (existingIssue as any).coverArtists !== "[]" ? (existingIssue as any).coverArtists : coverArtistsStr,
                     colorists: (existingIssue as any).colorists && (existingIssue as any).colorists !== "[]" ? (existingIssue as any).colorists : coloristsStr,
                     letterers: (existingIssue as any).letterers && (existingIssue as any).letterers !== "[]" ? (existingIssue as any).letterers : letterersStr,
                     teams: (existingIssue as any).teams && (existingIssue as any).teams !== "[]" ? (existingIssue as any).teams : teamsStr,
                     locations: (existingIssue as any).locations && (existingIssue as any).locations !== "[]" ? (existingIssue as any).locations : locationsStr,
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
                     characters: charsStr,
                     coverArtists: coverArtistsStr,
                     colorists: coloristsStr,
                     letterers: letterersStr,
                     teams: teamsStr,
                     locations: locationsStr
                 } as any
             });
         }

         try {
             await prisma.series.update({
                 where: { id: series.id },
                 data: {
                     folderPath: destFolder,
                     libraryId: targetLibrary.id,
                     // Capture a Series Group embedded in the file's ComicInfo.xml so future
                     // imports/renames can place this series under its umbrella folder. Only
                     // fills a blank — never clobbers an existing (e.g. manually set) group.
                     ...((xmlMeta?.seriesGroup && !(series as any).seriesGroup) ? { seriesGroup: xmlMeta.seriesGroup } : {})
                 }
             });
         } catch (e) { }
      }

      try {
          if (req.volumeId !== "0" && series?.id) {
              Logger.log("[Importer] Queuing deduplicated metadata sync...", "info");
              const { omnibusQueue } = await import('./queue');
              
              // 10-minute rolling window: a batch download of many issues of the SAME series collapses
              // (via the bucketed jobId) into ONE sync instead of one per import — cutting redundant
              // full-series provider fetches. The matching delay lets the batch finish before it runs.
              const SYNC_DEDUP_WINDOW_MS = 600000;
              const timeWindow = Math.floor(Date.now() / SYNC_DEDUP_WINDOW_MS);

              await omnibusQueue.add('METADATA_SYNC', {
                  type: 'METADATA_SYNC',
                  seriesIds: [series.id]
              }, {
                  jobId: `METADATA_SYNC_MATCH_${series.id}_${timeWindow}`,
                  delay: SYNC_DEDUP_WINDOW_MS,
                  removeOnComplete: true,
                  removeOnFail: true
              });
          }
      } catch (syncErr: any) {
          Logger.log(`[Importer] Metadata sync queue failed: ${syncErr.message}`, "warn");
      }

      // Safely clear the queue for anything sharing the link (Except missing match placeholders)
        if (req.downloadLink && req.downloadLink !== "PENDING_MATCH") {
            await prisma.request.updateMany({
                where: { downloadLink: req.downloadLink, status: 'DOWNLOADING' },
                data: { status: 'COMPLETED', progress: 100, notified: false }
            });
        } else {
            await prisma.request.update({
                where: { id: requestId },
                data: { status: 'COMPLETED', progress: 100, notified: false }
            });
        }

      // CRITICAL: Only add trackingHash (Torrents) to the ignore list so DDLs can be re-downloaded later if needed!
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
          // --- UPDATED: USING UNIFIED SYSTEM NOTIFIER ---
          await SystemNotifier.sendAlert('comic_available', {
              title: notificationTitle,
              imageUrl: req.imageUrl,
              user: req.user?.username,
              email: req.user?.email,
              description: notificationDesc,
              publisher: series?.publisher,
              year: series?.year?.toString(),
              date: new Date().toLocaleString()
          });
      }

      Logger.log(`[Importer] Successfully imported to: ${destFolder}`, "success");
      return true;

    } catch (e: any) {
      Logger.log(`[Importer] Import Failed: ${e.message}`, "error");
      if (req) {
          // --- FIX: Safely route the failed Series metadata mapping ---
          const failedSeries = req.volumeId !== "0" ? await prisma.series.findFirst({ 
              where: { 
                  metadataId: req.volumeId, 
                  metadataSource: req.metadataSource || 'COMICVINE' 
              } 
          }) : null;

          // --- UPDATED: USING UNIFIED SYSTEM NOTIFIER ---
          await SystemNotifier.sendAlert('download_failed', {
              title: req.activeDownloadName || failedSeries?.name || "Unknown Comic",
              imageUrl: req.imageUrl,
              user: req.user?.username,
              description: failedSeries?.description,
              publisher: failedSeries?.publisher,
              year: failedSeries?.year?.toString()
          });
      }
      return false;
    }
  }
};