// src/lib/download-clients.ts
import axios from 'axios';
import FormData from 'form-data';
import { prisma } from '@/lib/db';
import { Logger } from './logger';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { DiscordNotifier } from './discord';
import { getErrorMessage } from './utils/error';
import { HosterEngine } from './hosters';
import { decryptSecret } from './encryption';
import { ENGINE_URL, engineHeaders, engineFetchLong } from '@/lib/engine';

async function getNetworkHeaders() {
    const customHeaders = await prisma.customHeader.findMany();
    const headers: Record<string, string> = {};
    customHeaders.forEach((h: any) => {
        if (h.key && h.value) headers[h.key.trim()] = h.value.trim();
    });
    return headers;
}

export const DownloadService = {
  async addDownload(rawClient: any, downloadUrl: string, title: string, seedTimeLimit: number, seedRatio: number = 0) {
    // Credentials are encrypted at rest; decrypt into a local copy before use.
    const client = { ...rawClient, pass: await decryptSecret(rawClient.pass), apiKey: await decryptSecret(rawClient.apiKey) };
    const cleanUrl = client.url.replace(/\/$/, '');
    const categoryString = client.category || 'comics';
    const primaryCategory = categoryString.split(',')[0].trim();
    const networkHeaders = await getNetworkHeaders();

    Logger.log(`[Download Service Debug] Preparing to add download to ${client.name} (${client.type}): Title: "${title}", URL: "${downloadUrl.substring(0, 60)}...", Category: ${primaryCategory}`, 'debug');

    const baseConfig = {
      headers: { 'User-Agent': 'Omnibus/1.0', ...networkHeaders },
      timeout: 30000 
    };

    try {
      let fileBuffer: Buffer | null = null;
      
      // --- THE FIX: Let Omnibus fetch the file into memory for ALL clients except magnets.
      // This protects NZBGet and Deluge from Cloudflare blocks by utilizing Omnibus's FlareSolverr config!
      if (!downloadUrl.startsWith('magnet:')) {
        try {
            const fileRes = await axios.get(downloadUrl, { responseType: 'arraybuffer', ...baseConfig });
            fileBuffer = Buffer.from(fileRes.data);
        } catch (err) { Logger.log(`[Proxy] File fetch failed, using URL instead.`, 'info'); }
      }

      if (client.type === 'qbit') {
        const loginRes = await axios.post(`${cleanUrl}/api/v2/auth/login`, 
          new URLSearchParams({ username: client.user || '', password: client.pass || '' }),
          { ...baseConfig, headers: { ...baseConfig.headers, 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        const cookie = loginRes.headers['set-cookie'];
        const form = new FormData();
        if (fileBuffer) form.append('torrents', fileBuffer, 'comic.torrent');
        else form.append('urls', downloadUrl);
        form.append('category', primaryCategory);
        if (seedTimeLimit > 0) form.append('seeding_time_limit', seedTimeLimit.toString());
        if (seedRatio > 0) form.append('ratio_limit', seedRatio.toString()); 
        
        await axios.post(`${cleanUrl}/api/v2/torrents/add`, form, {
          ...baseConfig, headers: { ...baseConfig.headers, Cookie: cookie, ...form.getHeaders() }
        });
      }
      else if (client.type === 'deluge') {
        const authRes = await axios.post(`${cleanUrl}/json`, { method: "auth.login", params: [client.pass], id: 1 }, baseConfig);
        const cookie = authRes.headers['set-cookie'];
        const options: any = { download_location: primaryCategory };
        if (seedRatio > 0) { options.stop_at_ratio = true; options.stop_ratio = seedRatio; }
        const method = downloadUrl.startsWith('magnet:') ? "core.add_torrent_magents" : "core.add_torrent_url";
        await axios.post(`${cleanUrl}/json`, { method: method, params: [[downloadUrl], options], id: 2 }, { ...baseConfig, headers: { ...baseConfig.headers, Cookie: cookie } });
      }
      else if (client.type === 'sab') {
          if (fileBuffer) {
              const safeName = (title || "download").replace(/[\\/:*?"<>|]/g, "_").slice(0, 200);
              const form = new FormData();
              form.append("apikey", client.apiKey || "");
              form.append("mode", "addfile");
              form.append("cat", primaryCategory);
              form.append("nzbname", safeName);
              form.append("output", "json");
              form.append("name", fileBuffer, { filename: `${safeName}.nzb`, contentType: 'application/x-nzb' });

              try {
                  await axios.post(`${cleanUrl}/api`, form, {
                      ...baseConfig,
                      headers: { ...baseConfig.headers, ...form.getHeaders() }
                  });
              } catch (e) {
                  Logger.log(`[SABnzbd] addfile failed, falling back to addurl...`, 'warn');
                  await axios.get(`${cleanUrl}/api`, { params: { mode: 'addurl', name: downloadUrl, nzbname: title, cat: primaryCategory, apikey: client.apiKey, output: 'json' }, ...baseConfig });
              }
          } else {
              await axios.get(`${cleanUrl}/api`, { params: { mode: 'addurl', name: downloadUrl, nzbname: title, cat: primaryCategory, apikey: client.apiKey, output: 'json' }, ...baseConfig });
          }
      }
      else if (client.type === 'nzbget') {
          const auth = Buffer.from(`${client.user}:${client.pass}`).toString('base64');
          
          // --- THE FIX: Convert the Omnibus buffer to Base64 so NZBGet receives the raw file data
          const nzbContent = fileBuffer ? fileBuffer.toString('base64') : downloadUrl;
          
          await axios.post(`${cleanUrl}/jsonrpc`, { 
              method: "append", 
              params: [title, nzbContent, primaryCategory, 0, false, false, "", 0, "SCORE", []] 
          }, { 
              ...baseConfig, 
              headers: { ...baseConfig.headers, Authorization: `Basic ${auth}` } 
          });
      }

      Logger.log(`[${client.type.toUpperCase()}] SUCCESS: Added ${title}`, 'success');
      return { success: true };
    } catch (error: unknown) {
      Logger.log(`[Download Service] Failed: ${getErrorMessage(error)}`, 'error');
      throw error;
    }
  },

  // --- Method to cancel and wipe active downloads ---
  async removeDownload(rawClient: any, downloadId: string) {
      // Credentials are encrypted at rest; decrypt into a local copy before use.
      const client = { ...rawClient, pass: await decryptSecret(rawClient.pass), apiKey: await decryptSecret(rawClient.apiKey) };
      const cleanUrl = client.url.replace(/\/$/, '');
      const networkHeaders = await getNetworkHeaders();
      const baseConfig = { headers: { 'User-Agent': 'Omnibus/1.0', ...networkHeaders }, timeout: 15000 };

      try {
          if (client.type === 'qbit') {
              const loginRes = await axios.post(`${cleanUrl}/api/v2/auth/login`, 
                  new URLSearchParams({ username: client.user || '', password: client.pass || '' }),
                  { ...baseConfig, headers: { ...baseConfig.headers, 'Content-Type': 'application/x-www-form-urlencoded' } }
              );
              const cookie = loginRes.headers['set-cookie'];
              await axios.get(`${cleanUrl}/api/v2/torrents/delete`, {
                  params: { hashes: downloadId, deleteFiles: true },
                  headers: { ...baseConfig.headers, Cookie: cookie }
              });
          }
          else if (client.type === 'sab') {
              await axios.get(`${cleanUrl}/api`, { 
                  params: { mode: 'queue', name: 'delete', value: downloadId, del_files: 1, apikey: client.apiKey, output: 'json' }, 
                  ...baseConfig 
              });
          }
          else if (client.type === 'deluge') {
              const authRes = await axios.post(`${cleanUrl}/json`, { method: "auth.login", params: [client.pass], id: 1 }, baseConfig);
              const cookie = authRes.headers['set-cookie'];
              await axios.post(`${cleanUrl}/json`, { 
                  method: "core.remove_torrent", params: [downloadId, true], id: 2 
              }, { headers: { ...baseConfig.headers, Cookie: cookie } });
          }
          else if (client.type === 'nzbget') {
              const auth = Buffer.from(`${client.user}:${client.pass}`).toString('base64');
              // GroupDelete removes the item and associated files
              await axios.post(`${cleanUrl}/jsonrpc`, { 
                  method: "editqueue", params: ["GroupDelete", 0, "", [parseInt(downloadId)]] 
              }, { headers: { ...baseConfig.headers, Authorization: `Basic ${auth}` } });
          }

          Logger.log(`[${client.type.toUpperCase()}] SUCCESS: Removed cancelled download ${downloadId}`, 'success');
          return true;
      } catch (error: unknown) {
          Logger.log(`[Download Service] Failed to remove cancelled download ${downloadId}: ${getErrorMessage(error)}`, 'error');
          return false;
      }
  },

  async downloadDirectFile(url: string, filename: string, targetPath: string, requestId: string, hoster?: string) {
      const diskSetting = await prisma.systemSetting.findUnique({ where: { key: 'is_disk_full' } });
      if (diskSetting?.value === 'true') {
          throw new Error("Download aborted: Disk Space is Critically Full (< 2GB).");
      }

      const { Importer } = await import('./importer');
      
      const extMatch = url.split(/[#?]/)[0].split('.').pop();
      const ext = (extMatch && extMatch.length <= 4) ? extMatch : 'cbz';
      let finalFilename = filename.toLowerCase().endsWith(`.${ext}`) ? filename : `${filename}.${ext}`;
      
      const getComicsFolder = path.join(targetPath, 'GetComics');
      let filePath = path.join(getComicsFolder, finalFilename);
      let partFilePath = `${filePath}.part`; 

      let finalDownloadUrl = url;

      try {
          try {
              if (!fs.existsSync(getComicsFolder)) {
                  fs.mkdirSync(getComicsFolder, { recursive: true });
              }
          } catch (mkdirErr: any) {}

          let resolvedHoster: any = null;

          // GetComics links (the direct CDN or the Cloudflare-gated main server) are streamed by the
          // engine, which handles the warm-up/solver; the HosterEngine only resolves third-party
          // mirrors. `unknown` is a held/manual link. Legacy `getcomics` kept for un-migrated callers.
          const isGetComics = hoster === 'getcomics_direct' || hoster === 'getcomics_main' || hoster === 'getcomics';
          if (hoster && !isGetComics && hoster !== 'unknown') {
              await prisma.request.update({
                  where: { id: requestId },
                  data: { status: 'DOWNLOADING', progress: 0 }
              });

              resolvedHoster = await HosterEngine.resolveLink(url, hoster);
              
              if (resolvedHoster.success) {
                  if (resolvedHoster.directUrl) {
                      finalDownloadUrl = resolvedHoster.directUrl;
                      Logger.log(`[Internal DL] Successfully resolved ${hoster} to direct stream URL.`, 'success');
                  } else if (resolvedHoster.isMegaStream) {
                      Logger.log(`[Internal DL] Successfully resolved Mega folder/file.`, 'success');
                  }
                  
                  if (resolvedHoster.fileName) {
                      const newExtMatch = resolvedHoster.fileName.split('.').pop();
                      const newExt = (newExtMatch && newExtMatch.length <= 4) ? newExtMatch : 'cbz';
                      finalFilename = filename.toLowerCase().endsWith(`.${newExt}`) ? filename : `${filename}.${newExt}`;
                      filePath = path.join(getComicsFolder, finalFilename);
                      partFilePath = `${filePath}.part`;
                  }
              } else if (hoster === 'annas_archive') {
                  // Anna's Archive without a usable premium key (or a key/quota error) can't be resolved
                  // automatically — the file sits behind a slow-download CAPTCHA wall only a human can
                  // pass. Hold the /md5/ link for manual pickup instead of throwing into a STALLED retry
                  // loop (parity with the Cloudflare-gated GetComics manual-hold below).
                  Logger.log(`[Internal DL] Anna's Archive link needs a premium API key; holding for manual download: ${url}`, 'warn');
                  await prisma.request.update({
                      where: { id: requestId },
                      data: { status: 'MANUAL_DDL', downloadLink: url, activeDownloadName: finalFilename }
                  }).catch(() => {});
                  return false;
              } else {
                  throw new Error(`Failed to resolve ${hoster} link: ${resolvedHoster.error}`);
              }
          }

          // Non-Mega downloads (a plain GetComics URL or a resolved direct HTTP URL) are streamed by
          // the Rust engine: it owns the byte pump, the 45s stall-watchdog, progress, the small-file
          // guard, and the .part -> final rename. Hoster resolution (above) and the Mega SDK stream
          // (below) stay in Node, as does the failure alert in the catch block.
          if (!resolvedHoster?.isMegaStream) {
              await prisma.request.update({
                  where: { id: requestId },
                  data: { activeDownloadName: finalFilename, status: 'DOWNLOADING', progress: 0, downloadLink: url }
              });
              Logger.log(`[Internal DL] Streaming via engine: ${finalFilename}`, 'info');

              const streamRes = await engineFetchLong(ENGINE_URL + '/api/download/stream', {
                  method: 'POST',
                  headers: engineHeaders({ 'Content-Type': 'application/json' }),
                  body: JSON.stringify({
                      request_id: requestId,
                      url: finalDownloadUrl,
                      headers: resolvedHoster?.headers || {},
                      dest_path: filePath,
                      ext
                  })
              });
              if (!streamRes.ok) throw new Error(`Engine stream endpoint returned ${streamRes.status}`);
              const result = await streamRes.json();
              if (!result.success) {
                  // A Cloudflare-gated GetComics /dls/ link the engine couldn't clear automatically
                  // (the engine emits the distinct "manual download required" marker). Rather than fail
                  // into a STALLED retry loop on a link only a human can pass, hold it as MANUAL_DDL so
                  // the admin dashboard surfaces a one-click "Link" to download it in a browser, where
                  // the Cloudflare challenge can be solved interactively.
                  if (/manual download required/i.test(result.error || '')) {
                      Logger.log(`[Internal DL] GetComics link is Cloudflare-gated and couldn't be solved; holding for manual download: ${url}`, 'warn');
                      await prisma.request.update({
                          where: { id: requestId },
                          data: { status: 'MANUAL_DDL', downloadLink: url, activeDownloadName: finalFilename }
                      }).catch(() => {});
                      return false;
                  }
                  throw new Error(result.error || "Engine download failed");
              }

              Logger.log(`[Internal DL] Download complete (engine). Handing off to Importer...`, 'success');
              return true;
          }

          if (fs.existsSync(partFilePath)) {
              try { fs.unlinkSync(partFilePath); } catch (e) {}
          }

          await prisma.request.update({
            where: { id: requestId },
            data: { activeDownloadName: finalFilename, status: 'DOWNLOADING', progress: 0, downloadLink: url }
          });

          Logger.log(`[Internal DL] Starting download: ${finalFilename}`, 'info');

          let response: any;
          let attempt = 0;
          const maxAttempts = 3;
          let abortController = new AbortController();
          
          let megaStream: any = null;

          while (attempt < maxAttempts) {
              attempt++;
              abortController = new AbortController(); 
              try {
                  if (resolvedHoster?.isMegaStream && resolvedHoster?.megaFileNode) {
                      megaStream = resolvedHoster.megaFileNode.download();
                      break;
                  } else {
                      const requestHeaders: any = { 
                          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                          'Accept': 'application/zip, application/x-rar-compressed, application/octet-stream, */*',
                          'Referer': 'https://getcomics.org/' 
                      };
                      
                      if (resolvedHoster?.headers) {
                          Object.assign(requestHeaders, resolvedHoster.headers);
                      }

                      response = await axios({ 
                          method: 'get', 
                          url: finalDownloadUrl, 
                          responseType: 'stream', 
                          headers: requestHeaders,
                          timeout: 60000,
                          signal: abortController.signal
                      });
                      break; 
                  }
              } catch (err: any) {
                  if (attempt >= maxAttempts) throw err; 
                  const status = err.response?.status;
                  Logger.log(`[Internal DL] Attempt ${attempt} failed (Status: ${status || err.message}). Retrying in 3s...`, 'warn');
                  await new Promise(r => setTimeout(r, 3000));
              }
          }

          if (response && !resolvedHoster?.isMegaStream) {
              const contentType = (response.headers['content-type'] || '').toLowerCase();
              if (contentType.includes('text/html')) {
                  throw new Error("Download URL returned an HTML webpage instead of a comic file.");
              }
          }

          const writer = fs.createWriteStream(partFilePath);
          
          let totalLength = 0;
          if (resolvedHoster?.isMegaStream && resolvedHoster?.megaFileNode) {
              totalLength = resolvedHoster.megaFileNode.size;
          } else if (response?.headers) {
              totalLength = parseInt(response.headers['content-length'] || '0');
          }

          let downloadedBytes = 0;
          let lastUpdate = 0;

          let stallTimer: NodeJS.Timeout | null = null;
          const resetStallTimer = () => {
              if (stallTimer) clearTimeout(stallTimer);
              stallTimer = setTimeout(() => {
                  Logger.log(`[Internal DL] Data stream stalled for 45 seconds. Killing connection to trigger retry.`, 'error');
                  abortController.abort(new Error("Download stalled for 45 seconds"));
                  if (megaStream) megaStream.destroy(new Error("Download stalled"));
              }, 45000);
          };

          resetStallTimer(); 

          const dataStream = megaStream || response.data;

          dataStream.on('data', (chunk: Buffer) => {
              resetStallTimer(); 
              downloadedBytes += chunk.length;
              if (totalLength) {
                  const percent = Math.round((downloadedBytes / totalLength) * 100);
                  const now = Date.now();
                  if (percent % 5 === 0 && now - lastUpdate > 2000) {
                      lastUpdate = now;
                      prisma.request.update({ where: { id: requestId }, data: { progress: percent } }).catch(() => {});
                  }
              }
          });

          try {
              await pipeline(dataStream, writer);
          } finally {
              if (stallTimer) clearTimeout(stallTimer); 
          }

          const stats = fs.statSync(partFilePath);
          if (stats.size < 500000) {
             throw new Error(`Downloaded file is suspiciously small (${Math.round(stats.size/1024)}kb). Aborting.`);
          }

          if (fs.existsSync(filePath)) {
              try { fs.unlinkSync(filePath); } catch(e) {
                   Logger.log(`[Internal DL] Warning: Could not overwrite existing file (might be locked by Windows).`, 'warn');
              }
          }

          try {
              fs.renameSync(partFilePath, filePath);
          } catch (renameErr) {
              const timestampedPath = filePath.replace(`.${ext}`, `_${Date.now()}.${ext}`);
              fs.renameSync(partFilePath, timestampedPath);
          }

          Logger.log(`[Internal DL] Download complete. Handing off to Importer...`, 'success');
          return true;
      } catch (error: unknown) {
          if (fs.existsSync(partFilePath)) try { fs.unlinkSync(partFilePath); } catch (e) {}
          
          Logger.log(`[Internal DL] Download Failed: ${getErrorMessage(error)}`, 'error');
          
          await prisma.request.update({
            where: { id: requestId },
            data: { status: 'STALLED', progress: 0 }
          }).catch(() => {});

          const failedReq = await prisma.request.findUnique({ where: { id: requestId }, include: { user: true } });
          const failedSeries = failedReq?.volumeId && failedReq.volumeId !== "0" ? await prisma.series.findFirst({ where: { metadataId: failedReq.volumeId, metadataSource: 'COMICVINE' } }) : null;

          await DiscordNotifier.sendAlert('download_failed', { 
              title: finalFilename || "Unknown Download",
              imageUrl: failedReq?.imageUrl,
              user: failedReq?.user?.username,
              description: failedSeries?.description,
              publisher: failedSeries?.publisher,
              year: failedSeries?.year?.toString()
          });
          
          throw error;
      }
  },

  async getAllActiveDownloads() {
    const clients = await prisma.downloadClient.findMany();
    if (clients.length === 0) return [];
    
    const networkHeaders = await getNetworkHeaders();
    const baseHeaders = { 'User-Agent': 'Omnibus/1.0', ...networkHeaders };

    let allDownloads: any[] = [];

    for (const rawClient of clients) {
      // Credentials are encrypted at rest; decrypt into a local copy before use.
      const client = { ...rawClient, pass: await decryptSecret(rawClient.pass), apiKey: await decryptSecret(rawClient.apiKey) };
      try {
        const cleanUrl = client.url?.replace(/\/$/, '');
        if (!cleanUrl) continue;

        const categoryString = client.category || 'comics';
        const allowedCategories = categoryString.toLowerCase().split(',').map(c => c.trim());
        const isAllowedCategory = (cat: string) => {
            if (!cat) return false;
            return allowedCategories.includes(cat.toLowerCase());
        };

        if (client.type === 'qbit') {
          const loginRes = await axios.post(`${cleanUrl}/api/v2/auth/login`, 
            new URLSearchParams({ username: client.user || '', password: client.pass || '' }),
            { headers: { ...baseHeaders, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
          );
          const cookie = loginRes.headers['set-cookie'];
          
          const listRes = await axios.get(`${cleanUrl}/api/v2/torrents/info`, {
            params: { filter: 'all' },
            headers: { Cookie: cookie, ...baseHeaders },
            timeout: 15000
          });

          if (Array.isArray(listRes.data)) {
            const validTorrents = listRes.data.filter((t: any) => isAllowedCategory(t.category));
            Logger.log(`[Download Service Debug] [qBit] Fetched ${listRes.data.length} total torrents. ${validTorrents.length} matched allowed categories (${allowedCategories.join(', ')}).`, 'debug');
            
            allDownloads.push(...validTorrents.map((t: any) => ({
              id: t.hash, name: t.name, progress: (t.progress * 100).toFixed(1),
              status: t.state, clientName: client.name, size: (t.size / 1024 / 1024).toFixed(2) + " MB"
            })));
          }
        }
        else if (client.type === 'deluge') {
            const authRes = await axios.post(`${cleanUrl}/json`, { method: "auth.login", params: [client.pass], id: 1 }, { headers: baseHeaders, timeout: 15000 });
            const cookie = authRes.headers['set-cookie'];
            const listRes = await axios.post(`${cleanUrl}/json`, { method: "web.update_ui", params: [["name", "progress", "state", "total_size"], {}], id: 2 }, { headers: { ...baseHeaders, Cookie: cookie }, timeout: 15000 });
            if (listRes.data.result?.torrents) {
                const torrents = listRes.data.result.torrents;
                allDownloads.push(...Object.keys(torrents).map(hash => ({
                    id: hash, name: torrents[hash].name, progress: torrents[hash].progress.toFixed(1),
                    status: torrents[hash].state, clientName: client.name, size: (torrents[hash].total_size / 1024 / 1024).toFixed(2) + " MB"
                })));
            }
        }
        else if (client.type === 'sab') {
            const queueRes = await axios.get(`${cleanUrl}/api`, { params: { mode: 'queue', apikey: client.apiKey, output: 'json' }, headers: baseHeaders, timeout: 15000 });
            if (queueRes.data.queue?.slots) {
                const validSlots = queueRes.data.queue.slots.filter((s: any) => isAllowedCategory(s.cat));
                Logger.log(`[Download Service Debug] [SABnzbd] Fetched ${queueRes.data.queue.slots.length} queue items. ${validSlots.length} matched allowed categories.`, 'debug');
                allDownloads.push(...validSlots.map((s: any) => ({ id: s.nzo_id, name: s.filename, progress: s.percentage, status: s.status, clientName: client.name, size: s.size })));
            }
            try {
                const historyRes = await axios.get(`${cleanUrl}/api`, { params: { mode: 'history', limit: 20, apikey: client.apiKey, output: 'json' }, headers: baseHeaders, timeout: 15000 });
                if (historyRes.data.history?.slots) {
                    const validHistory = historyRes.data.history.slots.filter((s: any) => isAllowedCategory(s.category));
                    Logger.log(`[Download Service Debug] [SABnzbd] Fetched ${historyRes.data.history.slots.length} history items. ${validHistory.length} matched allowed categories.`, 'debug');
                    allDownloads.push(...validHistory.map((s: any) => ({
                        id: s.nzo_id, name: s.name, progress: s.status === 'Completed' ? "100.0" : "0.0", status: s.status, clientName: client.name, size: s.size
                    })));
                }
            } catch (e) { }
        }
        else if (client.type === 'nzbget') {
            const auth = Buffer.from(`${client.user}:${client.pass}`).toString('base64');
            const listRes = await axios.post(`${cleanUrl}/jsonrpc`, { method: "listgroups", params: [] }, { headers: { ...baseHeaders, Authorization: `Basic ${auth}` }, timeout: 15000 });
            if (Array.isArray(listRes.data.result)) {
                const validGroups = listRes.data.result.filter((g: any) => isAllowedCategory(g.Category));
                allDownloads.push(...validGroups.map((g: any) => ({ id: String(g.NZBID), name: g.NZBName, progress: ((g.DownloadedSizeMB / g.FileSizeMB) * 100).toFixed(1), status: g.Status, clientName: client.name, size: g.FileSizeMB + " MB" })));
            }
            try {
                const historyRes = await axios.post(`${cleanUrl}/jsonrpc`, { method: "history", params: [] }, { headers: { ...baseHeaders, Authorization: `Basic ${auth}` }, timeout: 15000 });
                if (Array.isArray(historyRes.data.result)) {
                    const validHistory = historyRes.data.result.filter((g: any) => isAllowedCategory(g.Category));
                    allDownloads.push(...validHistory.map((g: any) => ({
                        id: String(g.NZBID), name: g.Name, progress: g.Status.includes('SUCCESS') ? "100.0" : "0.0", status: g.Status, clientName: client.name, size: g.FileSizeMB + " MB"
                    })));
                }
            } catch (e) { }
        }
      } catch (err) { }
    }
    return allDownloads;
  }
};