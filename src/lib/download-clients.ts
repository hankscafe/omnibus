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
import { assertSafeFetchUrl, assertSafeRedirect } from './utils/ssrf';
import { ENGINE_URL, engineHeaders, engineFetchLong } from '@/lib/engine';

async function getNetworkHeaders() {
    const customHeaders = await prisma.customHeader.findMany();
    const headers: Record<string, string> = {};
    customHeaders.forEach((h: any) => {
        if (h.key && h.value) headers[h.key.trim()] = h.value.trim();
    });
    return headers;
}

// ---------------------------------------------------------------------------
// qBittorrent auth (issue #193) — ONE helper for every qbit call site.
//
// Two modes, decided by whether an API key is configured:
//  - API key (qBittorrent >= 5.2): stateless `Authorization: Bearer qbt_...`. No login call is
//    made at all, so it can never trip qBittorrent's failed-login IP ban (the opaque 403 that
//    made #193 undiagnosable).
//  - Username/password (older qBittorrent): POST /auth/login for a SID cookie. Three fixes over
//    the old inline copies of this flow:
//      1. The login carries Referer+Origin — strict qBittorrent CSRF configs 403 without them.
//      2. The response BODY is checked: qbit answers WRONG credentials with HTTP 200 "Fails."
//         and no cookie, which previously sailed through and surfaced later as a misleading 403
//         on the next API call.
//      3. A hard 403 on the login itself is translated into the real story — qBittorrent bans
//         the caller's IP after consecutive failed logins, and every attempt during the ban
//         returns 403 regardless of credentials.
//    The SID is extracted cleanly instead of forwarding the raw set-cookie array (attributes
//    and all) as the Cookie header.
// ---------------------------------------------------------------------------
export async function qbitAuthHeaders(
    client: { user?: string | null; pass?: string | null; apiKey?: string | null },
    cleanUrl: string,
    baseHeaders: Record<string, string>,
    timeoutMs: number,
): Promise<Record<string, string>> {
    const apiKey = (client.apiKey || '').trim();
    if (apiKey) {
        return { ...baseHeaders, Authorization: `Bearer ${apiKey}` };
    }

    let loginRes;
    try {
        loginRes = await axios.post(`${cleanUrl}/api/v2/auth/login`,
            new URLSearchParams({ username: client.user || '', password: client.pass || '' }),
            { headers: { ...baseHeaders, 'Content-Type': 'application/x-www-form-urlencoded', Referer: cleanUrl, Origin: cleanUrl }, timeout: timeoutMs }
        );
    } catch (e: any) {
        // qBittorrent 5.2 rewrote the login responses (measured against 5.2.3): wrong credentials
        // are now HTTP 401 (older versions answered 200 + "Fails."), and the failed-login IP ban
        // stays 403 (now with an explicit body). Both are axios throws — name each.
        if (e?.response?.status === 401) {
            throw new Error('qBittorrent rejected the username/password (HTTP 401). Check the WebUI credentials in qBittorrent under Tools → Options → Web UI — and note qBittorrent uses a TEMPORARY password (printed in its startup log) that changes on every restart until a permanent one is set. Repeated failed attempts will get this IP temporarily banned.');
        }
        if (e?.response?.status === 403) {
            throw new Error('qBittorrent refused the login (HTTP 403) — it has banned this IP after failed login attempts. Restart qBittorrent (or wait ~1 hour), verify the credentials, then try again. Tip: with qBittorrent 5.2+ an API key (Preferences → WebUI → API Key) avoids login bans entirely.');
        }
        throw e;
    }

    // Success detection must be COOKIE-FIRST, not body-first: qBittorrent ≤5.1 answers a login
    // with 200 + "Ok." + an `SID` cookie, while 5.2+ answers 204 + EMPTY body + a renamed
    // `QBT_SID_<port>` cookie. Matching the body against "Ok." (the old check) reads 5.2's empty
    // body as a credential failure — the issue #193 "Authentication failed" with correct
    // credentials. A session cookie of either shape IS the success signal.
    const setCookies: string[] = ([] as string[]).concat(loginRes.headers['set-cookie'] || []);
    const sid = setCookies.map(c => c.split(';')[0].trim()).find(c => /^(SID|QBT_SID[^=]*)=/.test(c));
    if (sid) {
        return { ...baseHeaders, Cookie: sid };
    }

    if (String(loginRes.data).trim() === 'Fails.') {
        // Pre-5.2 wrong-credentials shape: HTTP 200, body "Fails.", no cookie.
        throw new Error('qBittorrent rejected the username/password (login returned "Fails."). Check the WebUI credentials in qBittorrent under Tools → Options → Web UI. Repeated failed attempts will get this IP temporarily banned.');
    }
    throw new Error('qBittorrent answered the login but returned no session cookie — a reverse proxy in front of qBittorrent may be stripping cookies.');
}

export const DownloadService = {
  async addDownload(rawClient: any, downloadUrl: string, title: string, seedTimeLimit: number, seedRatio: number = 0, isManga: boolean = false) {
    // Credentials are encrypted at rest; decrypt into a local copy before use.
    const client = { ...rawClient, pass: await decryptSecret(rawClient.pass), apiKey: await decryptSecret(rawClient.apiKey) };
    const cleanUrl = client.url.replace(/\/$/, '');
    const categoryString = client.category || 'comics';
    // The category field is an ordered list: first = comics, optional second = manga. Route manga to the
    // second entry when present so comics and manga land in their own category/label in the download client;
    // everything else (and manga when only one category is configured) uses the first. The active-downloads
    // filter still accepts the whole list, so both categories remain visible.
    const categoryList = categoryString.split(',').map((c: string) => c.trim()).filter(Boolean);
    const primaryCategory = (isManga && categoryList[1]) ? categoryList[1] : (categoryList[0] || 'comics');
    const networkHeaders = await getNetworkHeaders();

    Logger.log(`[Download Service Debug] Preparing to add download to ${client.name} (${client.type}): Title: "${title}", URL: "${downloadUrl.substring(0, 60)}...", Category: ${primaryCategory}`, 'debug');

    const baseConfig = {
      headers: { 'User-Agent': 'Omnibus/1.0', ...networkHeaders },
      timeout: 30000 
    };

    try {
      let fileBuffer: Buffer | null = null;
      
      // --- THE FIX: Let Omnibus fetch the file into memory for ALL clients except magnets, so the
      // download client receives the .nzb/.torrent bytes instead of a URL it may not be able to reach.
      // NOTE: this is a plain fetch — it does NOT route through FlareSolverr (only the engine's
      // GetComics/Anna's fetch+stream paths do). A Cloudflare-fronted indexer link falls through to
      // the raw-URL hand-off below.
      if (!downloadUrl.startsWith('magnet:')) {
        try {
            // SSRF guard: indexer/scraped URLs are untrusted — never let Omnibus fetch an internal host, and
            // re-validate each redirect hop. On block/failure we fall through to handing the raw URL to the
            // download client (whose own fetch happens outside Omnibus's network).
            assertSafeFetchUrl(downloadUrl);
            const fileRes = await axios.get(downloadUrl, { responseType: 'arraybuffer', ...baseConfig, maxRedirects: 5, beforeRedirect: assertSafeRedirect });
            fileBuffer = Buffer.from(fileRes.data);
        } catch (err) { Logger.log(`[Proxy] File fetch skipped/failed (${getErrorMessage(err)}), using URL instead.`, 'info'); }
      }

      if (client.type === 'qbit') {
        // API key (Bearer) or username/password (SID cookie) — see qbitAuthHeaders.
        const authHeaders = await qbitAuthHeaders(client, cleanUrl, baseConfig.headers, baseConfig.timeout);
        const form = new FormData();
        if (fileBuffer) form.append('torrents', fileBuffer, 'comic.torrent');
        else form.append('urls', downloadUrl);
        form.append('category', primaryCategory);
        if (seedTimeLimit > 0) form.append('seeding_time_limit', seedTimeLimit.toString());
        if (seedRatio > 0) form.append('ratio_limit', seedRatio.toString());

        await axios.post(`${cleanUrl}/api/v2/torrents/add`, form, {
          ...baseConfig, headers: { ...authHeaders, ...form.getHeaders() }
        });
      }
      else if (client.type === 'deluge') {
        const authRes = await axios.post(`${cleanUrl}/json`, { method: "auth.login", params: [client.pass], id: 1 }, baseConfig);
        const cookie = authRes.headers['set-cookie'];
        // Don't force download_location to the category string (it previously set the save path to e.g.
        // "comics", a stray relative folder). Let Deluge use its configured default — or its per-label
        // download location, now that we tag the torrent with the category as a label below.
        const options: any = {};
        if (seedRatio > 0) { options.stop_at_ratio = true; options.stop_ratio = seedRatio; }
        // Deluge's magnet method is core.add_torrent_magnet — "add_torrent_magents" was a typo, so every
        // magnet add hit an unknown method, and Deluge returns JSON-RPC errors with HTTP 200 (axios won't
        // throw), so the request was logged as success and wedged in DOWNLOADING with no recovery.
        const method = downloadUrl.startsWith('magnet:') ? "core.add_torrent_magnet" : "core.add_torrent_url";
        const addRes = await axios.post(`${cleanUrl}/json`, { method: method, params: [[downloadUrl], options], id: 2 }, { ...baseConfig, headers: { ...baseConfig.headers, Cookie: cookie } });
        // Surface HTTP-200 JSON-RPC errors explicitly so a failed add doesn't masquerade as success.
        if (addRes.data?.error) throw new Error(`Deluge add failed: ${JSON.stringify(addRes.data.error)}`);

        // Tag the torrent with the configured category as a Deluge *label* (Label plugin), so the
        // active-downloads view can filter a shared Deluge instance by category the same way qBit/SAB/NZBGet
        // do with their native categories. Best-effort: if the Label plugin is disabled, Deluge returns the
        // error in a 200 body (axios won't throw) and the torrent is simply left unlabeled — no add failure.
        const delugeTorrentId = addRes.data?.result;
        const delugeLabel = primaryCategory.toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (delugeTorrentId && typeof delugeTorrentId === 'string' && delugeLabel) {
            const labelHeaders = { ...baseConfig.headers, Cookie: cookie };
            try { await axios.post(`${cleanUrl}/json`, { method: "label.add", params: [delugeLabel], id: 3 }, { ...baseConfig, headers: labelHeaders }); } catch (e) {}
            try { await axios.post(`${cleanUrl}/json`, { method: "label.set_torrent", params: [delugeTorrentId, delugeLabel], id: 4 }, { ...baseConfig, headers: labelHeaders }); } catch (e) {}
        }
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
              const authHeaders = await qbitAuthHeaders(client, cleanUrl, baseConfig.headers, baseConfig.timeout);
              await axios.get(`${cleanUrl}/api/v2/torrents/delete`, {
                  params: { hashes: downloadId, deleteFiles: true },
                  headers: authHeaders
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
              // SSRF guard on the (possibly hoster-resolved) URL before streaming it. Mega uses its own SDK,
              // not a URL fetch. The Rust engine re-validates internally, but block here too so a poisoned
              // scrape never even reaches the engine call.
              assertSafeFetchUrl(finalDownloadUrl);
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

          // Only Mega reaches here — every other hoster is streamed by the engine above (which returns
          // or throws before this point). The Mega SDK stream stays in Node because its JS-only SDK
          // can't be driven from the Rust engine.
          const megaFileNode = resolvedHoster?.megaFileNode;
          if (!megaFileNode) throw new Error("Mega stream requested but no file node was resolved.");

          const megaStream = megaFileNode.download();
          const writer = fs.createWriteStream(partFilePath);
          const totalLength = megaFileNode.size || 0;

          let downloadedBytes = 0;
          let lastUpdate = 0;

          let stallTimer: NodeJS.Timeout | null = null;
          const resetStallTimer = () => {
              if (stallTimer) clearTimeout(stallTimer);
              stallTimer = setTimeout(() => {
                  Logger.log(`[Internal DL] Data stream stalled for 45 seconds. Killing connection to trigger retry.`, 'error');
                  megaStream.destroy(new Error("Download stalled"));
              }, 45000);
          };

          resetStallTimer();

          const dataStream = megaStream;

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

    // Query every client concurrently — one dead/slow client (15s per-request timeouts) must not block
    // the others (the importer + the 15s dashboard poll both call this).
    const perClient = await Promise.allSettled(clients.map(async (rawClient) => {
      const downloads: any[] = [];
      // Credentials are encrypted at rest; decrypt into a local copy before use.
      const client = { ...rawClient, pass: await decryptSecret(rawClient.pass), apiKey: await decryptSecret(rawClient.apiKey) };
      try {
        const cleanUrl = client.url?.replace(/\/$/, '');
        if (!cleanUrl) return downloads;

        const categoryString = client.category || 'comics';
        const allowedCategories = categoryString.toLowerCase().split(',').map(c => c.trim());
        const isAllowedCategory = (cat: string) => {
            if (!cat) return false;
            return allowedCategories.includes(cat.toLowerCase());
        };

        if (client.type === 'qbit') {
          // This poll runs every 15s from the dashboard — during a qbit login ban the old inline
          // login turned every tick into an opaque 403; qbitAuthHeaders names the cause (and the
          // Bearer path never logs in at all).
          const authHeaders = await qbitAuthHeaders(client, cleanUrl, baseHeaders, 15000);

          const listRes = await axios.get(`${cleanUrl}/api/v2/torrents/info`, {
            params: { filter: 'all' },
            headers: authHeaders,
            timeout: 15000
          });

          if (Array.isArray(listRes.data)) {
            const validTorrents = listRes.data.filter((t: any) => isAllowedCategory(t.category));
            Logger.log(`[Download Service Debug] [qBit] Fetched ${listRes.data.length} total torrents. ${validTorrents.length} matched allowed categories (${allowedCategories.join(', ')}).`, 'debug');
            
            downloads.push(...validTorrents.map((t: any) => ({
              id: t.hash, name: t.name, progress: (t.progress * 100).toFixed(1),
              status: t.state, clientName: client.name, size: (t.size / 1024 / 1024).toFixed(2) + " MB"
            })));
          }
        }
        else if (client.type === 'deluge') {
            const authRes = await axios.post(`${cleanUrl}/json`, { method: "auth.login", params: [client.pass], id: 1 }, { headers: baseHeaders, timeout: 15000 });
            const cookie = authRes.headers['set-cookie'];
            // Request the Label-plugin `label` field so a shared Deluge can be filtered by category, like qBit/SAB.
            const listRes = await axios.post(`${cleanUrl}/json`, { method: "web.update_ui", params: [["name", "progress", "state", "total_size", "label"], {}], id: 2 }, { headers: { ...baseHeaders, Cookie: cookie }, timeout: 15000 });
            if (listRes.data.result?.torrents) {
                const torrents = listRes.data.result.torrents;
                const entries = Object.keys(torrents).map(hash => ({ hash, ...torrents[hash] }));
                // Deluge "categories" are Label-plugin labels. Only filter when labels are actually in use, so a
                // Deluge without the Label plugin (no torrent carries a label) still lists downloads instead of
                // showing nothing — while a shared instance (labels present) is correctly narrowed to the category.
                const labelsInUse = entries.some((t: any) => t.label && String(t.label).trim() !== '');
                const visible = labelsInUse ? entries.filter((t: any) => isAllowedCategory(t.label)) : entries;
                downloads.push(...visible.map((t: any) => ({
                    id: t.hash, name: t.name, progress: t.progress.toFixed(1),
                    status: t.state, clientName: client.name, size: (t.total_size / 1024 / 1024).toFixed(2) + " MB"
                })));
            }
        }
        else if (client.type === 'sab') {
            const queueRes = await axios.get(`${cleanUrl}/api`, { params: { mode: 'queue', apikey: client.apiKey, output: 'json' }, headers: baseHeaders, timeout: 15000 });
            if (queueRes.data.queue?.slots) {
                const validSlots = queueRes.data.queue.slots.filter((s: any) => isAllowedCategory(s.cat));
                Logger.log(`[Download Service Debug] [SABnzbd] Fetched ${queueRes.data.queue.slots.length} queue items. ${validSlots.length} matched allowed categories.`, 'debug');
                downloads.push(...validSlots.map((s: any) => ({ id: s.nzo_id, name: s.filename, progress: s.percentage, status: s.status, clientName: client.name, size: s.size })));
            }
            try {
                const historyRes = await axios.get(`${cleanUrl}/api`, { params: { mode: 'history', limit: 20, apikey: client.apiKey, output: 'json' }, headers: baseHeaders, timeout: 15000 });
                if (historyRes.data.history?.slots) {
                    const validHistory = historyRes.data.history.slots.filter((s: any) => isAllowedCategory(s.category));
                    Logger.log(`[Download Service Debug] [SABnzbd] Fetched ${historyRes.data.history.slots.length} history items. ${validHistory.length} matched allowed categories.`, 'debug');
                    downloads.push(...validHistory.map((s: any) => ({
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
                downloads.push(...validGroups.map((g: any) => ({ id: String(g.NZBID), name: g.NZBName, progress: ((g.DownloadedSizeMB / g.FileSizeMB) * 100).toFixed(1), status: g.Status, clientName: client.name, size: g.FileSizeMB + " MB" })));
            }
            try {
                const historyRes = await axios.post(`${cleanUrl}/jsonrpc`, { method: "history", params: [] }, { headers: { ...baseHeaders, Authorization: `Basic ${auth}` }, timeout: 15000 });
                if (Array.isArray(historyRes.data.result)) {
                    const validHistory = historyRes.data.result.filter((g: any) => isAllowedCategory(g.Category));
                    downloads.push(...validHistory.map((g: any) => ({
                        id: String(g.NZBID), name: g.Name, progress: g.Status.includes('SUCCESS') ? "100.0" : "0.0", status: g.Status, clientName: client.name, size: g.FileSizeMB + " MB"
                    })));
                }
            } catch (e) { }
        }
      } catch (err) {
          // Surface a broken/mis-authed client instead of silently contributing zero downloads — that made
          // the importer/cron lookup fail later as a generic "not found" rather than an auth problem.
          Logger.log(`[Download Service] Could not list active downloads from "${rawClient?.name || 'client'}": ${getErrorMessage(err)}`, 'warn');
      }
      return downloads;
    }));
    return perClient.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  }
};