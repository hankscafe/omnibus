import axios from 'axios';
import FormData from 'form-data';
import { prisma } from '@/lib/db';
import { Logger } from './logger';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { DiscordNotifier } from './discord';

async function getNetworkHeaders() {
    const settings = await prisma.systemSetting.findUnique({ where: { key: 'custom_headers' } });
    const headers: Record<string, string> = {};
    if (settings?.value) {
        try {
            const parsed = JSON.parse(settings.value);
            parsed.forEach((h: { key: string, value: string }) => {
                if (h.key && h.value) headers[h.key.trim()] = h.value.trim();
            });
        } catch (e) { Logger.log("Header parse error", "error"); }
    }
    return headers;
}

export const DownloadService = {
  // -------------------------------------------------------------------------
  // 1. ADD DOWNLOAD (Clients like qBit, Deluge, SAB, NZBGet)
  // -------------------------------------------------------------------------
  async addDownload(client: any, downloadUrl: string, title: string, seedTimeLimit: number, seedRatio: number = 0) {
    const cleanUrl = client.url.replace(/\/$/, '');
    const category = client.category || 'comics';
    const networkHeaders = await getNetworkHeaders();

    const baseConfig = {
      headers: { 'User-Agent': 'Omnibus/1.0', ...networkHeaders },
      timeout: 30000 
    };

    try {
      let fileBuffer: Buffer | null = null;
      if (!downloadUrl.startsWith('magnet:') && !client.type.includes('nzb')) {
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
        form.append('category', category);
        
        if (seedTimeLimit > 0) form.append('seeding_time_limit', seedTimeLimit.toString());
        if (seedRatio > 0) form.append('ratio_limit', seedRatio.toString()); 
        
        await axios.post(`${cleanUrl}/api/v2/torrents/add`, form, {
          ...baseConfig, headers: { ...baseConfig.headers, Cookie: cookie, ...form.getHeaders() }
        });
      }
      else if (client.type === 'deluge') {
        const authRes = await axios.post(`${cleanUrl}/json`, { method: "auth.login", params: [client.pass], id: 1 }, baseConfig);
        const cookie = authRes.headers['set-cookie'];
        const options: any = { download_location: category };
        if (seedRatio > 0) { options.stop_at_ratio = true; options.stop_ratio = seedRatio; }
        const method = downloadUrl.startsWith('magnet:') ? "core.add_torrent_magents" : "core.add_torrent_url";
        await axios.post(`${cleanUrl}/json`, { method: method, params: [[downloadUrl], options], id: 2 }, { ...baseConfig, headers: { ...baseConfig.headers, Cookie: cookie } });
      }
      else if (client.type === 'sab') {
          await axios.get(`${cleanUrl}/api`, { params: { mode: 'addurl', name: downloadUrl, nzbname: title, cat: category, apikey: client.apiKey, output: 'json' }, ...baseConfig });
      }
      else if (client.type === 'nzbget') {
          const auth = Buffer.from(`${client.user}:${client.pass}`).toString('base64');
          await axios.post(`${cleanUrl}/jsonrpc`, { method: "append", params: [title, downloadUrl, category, 0, false, false, "", 0, "SCORE", []] }, { ...baseConfig, headers: { ...baseConfig.headers, Authorization: `Basic ${auth}` } });
      }

      Logger.log(`[${client.type.toUpperCase()}] SUCCESS: Added ${title}`, 'success');
      return { success: true };
    } catch (error: any) {
      Logger.log(`[Download Service] Failed: ${error.message}`, 'error');
      throw error;
    }
  },

  // -------------------------------------------------------------------------
  // 2. INTERNAL DOWNLOADER (HTTP/GetComics Direct Downloads)
  // -------------------------------------------------------------------------
  async downloadDirectFile(url: string, filename: string, targetPath: string, requestId: string) {
      const { Importer } = await import('./importer');
      
      const extMatch = url.split(/[#?]/)[0].split('.').pop();
      const ext = (extMatch && extMatch.length <= 4) ? extMatch : 'cbz';
      const finalFilename = filename.toLowerCase().endsWith(`.${ext}`) ? filename : `${filename}.${ext}`;
      
      // UPDATED: Route GetComics downloads into a dedicated subfolder
      const getComicsFolder = path.join(targetPath, 'GetComics');
      const filePath = path.join(getComicsFolder, finalFilename);

      try {
          try {
              // Ensure the new GetComics subfolder exists
              if (!fs.existsSync(getComicsFolder)) {
                  fs.mkdirSync(getComicsFolder, { recursive: true });
                  Logger.log(`[Storage] Created dedicated GetComics download folder at: ${getComicsFolder}`, 'info');
              }
          } catch (mkdirErr: any) {
              Logger.log(`[Internal DL] Folder check warning: ${mkdirErr.message}`, 'warn');
          }

          if (fs.existsSync(filePath)) {
              try { fs.unlinkSync(filePath); } catch (e) {}
          }

          await prisma.request.update({
            where: { id: requestId },
            data: { 
                activeDownloadName: finalFilename, 
                status: 'DOWNLOADING', 
                progress: 0, 
                downloadLink: url
            }
          });

          Logger.log(`[Internal DL] Starting download: ${finalFilename}`, 'info');

          const response = await axios({ 
              method: 'get', url, responseType: 'stream', 
              headers: { 
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                  'Referer': 'https://getcomics.org/' 
              },
              timeout: 60000 
          });

          const writer = fs.createWriteStream(filePath);
          const totalLength = response.headers['content-length'];
          let downloadedBytes = 0;
          let lastUpdate = 0;

          response.data.on('data', (chunk: Buffer) => {
              downloadedBytes += chunk.length;
              if (totalLength) {
                  const percent = Math.round((downloadedBytes / parseInt(totalLength)) * 100);
                  const now = Date.now();
                  // Report progress to DB every 5% or 2 seconds
                  if (percent % 5 === 0 && now - lastUpdate > 2000) {
                      lastUpdate = now;
                      prisma.request.update({ where: { id: requestId }, data: { progress: percent } }).catch(() => {});
                  }
              }
          });

          await pipeline(response.data, writer);
          Logger.log(`[Internal DL] Download complete. Handing off to Importer...`, 'success');
          return true;
      } catch (error: any) {
          if (fs.existsSync(filePath)) try { fs.unlinkSync(filePath); } catch (e) {}
          
          Logger.log(`[Internal DL] Download Failed: ${error.message}`, 'error');
          
          await prisma.request.update({
            where: { id: requestId },
            data: { status: 'STALLED', progress: 0 }
          }).catch(() => {});

          // FIXED: Look up the rich data before firing the failure alert
          const failedReq = await prisma.request.findUnique({ where: { id: requestId }, include: { user: true } });
          const failedSeries = failedReq?.volumeId ? await prisma.series.findFirst({ where: { cvId: parseInt(failedReq.volumeId) } }) : null;

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

  // -------------------------------------------------------------------------
  // 3. GET STATUS (Aggregates active transfers from all clients)
  // -------------------------------------------------------------------------
  async getAllActiveDownloads() {
    const clientSetting = await prisma.systemSetting.findUnique({ where: { key: 'download_clients_config' } });
    if (!clientSetting?.value) return [];
    
    const networkHeaders = await getNetworkHeaders();
    const baseHeaders = { 'User-Agent': 'Omnibus/1.0', ...networkHeaders };

    let clients = [];
    try { clients = JSON.parse(clientSetting.value); } catch (e) { return []; }

    let allDownloads: any[] = [];

    for (const client of clients) {
      try {
        const cleanUrl = client.url?.replace(/\/$/, '');
        if (!cleanUrl) continue;

        if (client.type === 'qbit') {
          const loginRes = await axios.post(`${cleanUrl}/api/v2/auth/login`, 
            new URLSearchParams({ username: client.user || '', password: client.pass || '' }),
            { headers: { ...baseHeaders, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 5000 }
          );
          const cookie = loginRes.headers['set-cookie'];
          const listRes = await axios.get(`${cleanUrl}/api/v2/torrents/info`, {
            params: { filter: 'all', category: client.category || 'comics' },
            headers: { Cookie: cookie, ...baseHeaders },
            timeout: 5000
          });
          if (Array.isArray(listRes.data)) {
            allDownloads.push(...listRes.data.map((t: any) => ({
              id: t.hash, name: t.name, progress: (t.progress * 100).toFixed(1),
              status: t.state, clientName: client.name, size: (t.size / 1024 / 1024).toFixed(2) + " MB"
            })));
          }
        }
        else if (client.type === 'deluge') {
            const authRes = await axios.post(`${cleanUrl}/json`, { method: "auth.login", params: [client.pass], id: 1 }, { headers: baseHeaders });
            const cookie = authRes.headers['set-cookie'];
            const listRes = await axios.post(`${cleanUrl}/json`, { method: "web.update_ui", params: [["name", "progress", "state", "total_size"], {}], id: 2 }, { headers: { ...baseHeaders, Cookie: cookie } });
            if (listRes.data.result?.torrents) {
                const torrents = listRes.data.result.torrents;
                allDownloads.push(...Object.keys(torrents).map(hash => ({
                    id: hash, name: torrents[hash].name, progress: torrents[hash].progress.toFixed(1),
                    status: torrents[hash].state, clientName: client.name, size: (torrents[hash].total_size / 1024 / 1024).toFixed(2) + " MB"
                })));
            }
        }
        else if (client.type === 'sab') {
            const queueRes = await axios.get(`${cleanUrl}/api`, { params: { mode: 'queue', apikey: client.apiKey, output: 'json' }, headers: baseHeaders, timeout: 5000 });
            if (queueRes.data.queue?.slots) {
                allDownloads.push(...queueRes.data.queue.slots.map((s: any) => ({ id: s.nzo_id, name: s.filename, progress: s.percentage, status: s.status, clientName: client.name, size: s.size })));
            }
        }
        else if (client.type === 'nzbget') {
            const auth = Buffer.from(`${client.user}:${client.pass}`).toString('base64');
            const listRes = await axios.post(`${cleanUrl}/jsonrpc`, { method: "listgroups", params: [] }, { headers: { ...baseHeaders, Authorization: `Basic ${auth}` } });
            if (Array.isArray(listRes.data.result)) {
                allDownloads.push(...listRes.data.result.map((g: any) => ({ id: String(g.NZBID), name: g.NZBName, progress: ((g.DownloadedSizeMB / g.FileSizeMB) * 100).toFixed(1), status: g.Status, clientName: client.name, size: g.FileSizeMB + " MB" })));
            }
        }
      } catch (err) { /* Silent fail for individual client timeout */ }
    }
    return allDownloads;
  }
};