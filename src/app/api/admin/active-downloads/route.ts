export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import axios from 'axios';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { decryptSecret } from '@/lib/encryption';
import { qbitAuthHeaders } from '@/lib/download-clients';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export async function GET() {
  // NOTE: the per-client polling below duplicates DownloadService.getAllActiveDownloads()
  // (src/lib/download-clients.ts); this route adds the ignored/pending-request UI filtering.
  // Consolidate onto the service method if the two implementations drift again.
  try {
    // Defense-in-depth behind the middleware /api/admin/* gate — enforce admin in-handler too.
    const session = await getServerSession(await getAuthOptions());
    if ((session?.user as any)?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

    const clients = await prisma.downloadClient.findMany();
    if (clients.length === 0) {
        return NextResponse.json({ success: true, activeDownloads: [] });
    }

    const allDownloads: any[] = [];
    
    const customHeaders = await prisma.customHeader.findMany();
    const headers: any = { 'User-Agent': 'Omnibus/1.0' };
    customHeaders.forEach((h: any) => {
        if (h.key && h.value) headers[h.key.trim()] = h.value.trim();
    });

    for (const rawClient of clients) {
        // Credentials are encrypted at rest; decrypt into a local copy before use.
        const client = { ...rawClient, pass: await decryptSecret(rawClient.pass), apiKey: await decryptSecret(rawClient.apiKey) };
        const cleanUrl = client.url?.replace(/\/$/, "");
        if (!cleanUrl) continue;

        // IN-MEMORY FILTER SETUP
        const categoryString = client.category || 'comics';
        const allowedCategories = categoryString.toLowerCase().split(',').map(c => c.trim());
        const isAllowedCategory = (cat: string) => {
            if (!cat) return false;
            return allowedCategories.includes(cat.toLowerCase());
        };

        try {
            if (client.type === 'qbit') {
                // API key (Bearer, qBittorrent >= 5.2) or username/password login — shared helper
                // handles both, checks the "Fails." body, and names a login-ban 403 (issue #193).
                const authHeaders = await qbitAuthHeaders(client, cleanUrl, headers, 15000);

                const { data: torrents } = await axios.get(`${cleanUrl}/api/v2/torrents/info`, {
                    params: { filter: 'all' },
                    headers: authHeaders,
                    timeout: 15000
                });

                const validTorrents = torrents.filter((t: any) => isAllowedCategory(t.category));

                const mapped = validTorrents.map((t: any) => ({
                    id: t.hash,
                    name: t.name,
                    progress: (t.progress * 100).toFixed(1),
                    status: t.state,
                    size: (t.total_size / 1024 / 1024).toFixed(1) + " MB",
                    clientName: client.name
                }));
                allDownloads.push(...mapped);
            }
            else if (client.type === 'deluge') {
                const authRes = await axios.post(`${cleanUrl}/json`, { method: "auth.login", params: [client.pass], id: 1 }, { headers, timeout: 15000 });
                const cookie = authRes.headers['set-cookie'];
                // Request the Label-plugin `label` field so a shared Deluge can be filtered by category, like qBit/SAB.
                const listRes = await axios.post(`${cleanUrl}/json`, { method: "web.update_ui", params: [["name", "progress", "state", "total_size", "label"], {}], id: 2 }, { headers: { ...headers, Cookie: cookie }, timeout: 15000 });
                if (listRes.data.result?.torrents) {
                    const torrents = listRes.data.result.torrents;
                    const entries = Object.keys(torrents).map(hash => ({ hash, ...torrents[hash] }));
                    // Deluge "categories" are Label-plugin labels. Only filter when labels are actually in use, so a
                    // Deluge without the Label plugin (no torrent carries a label) still lists downloads instead of
                    // showing nothing — while a shared instance (labels present) is correctly narrowed to the category.
                    const labelsInUse = entries.some((t: any) => t.label && String(t.label).trim() !== '');
                    const visible = labelsInUse ? entries.filter((t: any) => isAllowedCategory(t.label)) : entries;
                    allDownloads.push(...visible.map((t: any) => ({
                        id: t.hash, name: t.name, progress: t.progress.toFixed(1),
                        status: t.state, clientName: client.name, size: (t.total_size / 1024 / 1024).toFixed(2) + " MB"
                    })));
                }
            }
            else if (client.type === 'sab') {
                // 1. Fetch Active Queue
                const queueRes = await axios.get(`${cleanUrl}/api`, { params: { mode: 'queue', apikey: client.apiKey, output: 'json' }, headers, timeout: 15000 });
                if (queueRes.data.queue?.slots) {
                    const validSlots = queueRes.data.queue.slots.filter((s: any) => isAllowedCategory(s.cat));
                    allDownloads.push(...validSlots.map((s: any) => ({ id: s.nzo_id, name: s.filename, progress: s.percentage, status: s.status, clientName: client.name, size: s.size })));
                }
                
                // 2. Fetch Recent History to catch completed downloads
                try {
                    const historyRes = await axios.get(`${cleanUrl}/api`, { params: { mode: 'history', limit: 20, apikey: client.apiKey, output: 'json' }, headers, timeout: 15000 });
                    if (historyRes.data.history?.slots) {
                        const validHistory = historyRes.data.history.slots.filter((s: any) => isAllowedCategory(s.category));
                        allDownloads.push(...validHistory.map((s: any) => ({
                            id: s.nzo_id, name: s.name, progress: s.status === 'Completed' ? "100.0" : "0.0", status: s.status, clientName: client.name, size: s.size
                        })));
                    }
                } catch (e) { Logger.log(`[Active Downloads] Failed to fetch SABnzbd history`, 'warn'); }
            }
            else if (client.type === 'nzbget') {
                const auth = Buffer.from(`${client.user}:${client.pass}`).toString('base64');
                
                // 1. Fetch Active Queue
                const listRes = await axios.post(`${cleanUrl}/jsonrpc`, { method: "listgroups", params: [] }, { headers: { ...headers, Authorization: `Basic ${auth}` }, timeout: 15000 });
                if (Array.isArray(listRes.data.result)) {
                    const validGroups = listRes.data.result.filter((g: any) => isAllowedCategory(g.Category));
                    allDownloads.push(...validGroups.map((g: any) => ({ id: String(g.NZBID), name: g.NZBName, progress: ((g.DownloadedSizeMB / g.FileSizeMB) * 100).toFixed(1), status: g.Status, clientName: client.name, size: g.FileSizeMB + " MB" })));
                }
                
                // 2. Fetch Recent History
                try {
                    const historyRes = await axios.post(`${cleanUrl}/jsonrpc`, { method: "history", params: [] }, { headers: { ...headers, Authorization: `Basic ${auth}` }, timeout: 15000 });
                    if (Array.isArray(historyRes.data.result)) {
                        const validHistory = historyRes.data.result.filter((g: any) => isAllowedCategory(g.Category));
                        allDownloads.push(...validHistory.map((g: any) => ({
                            id: String(g.NZBID), name: g.Name, progress: g.Status.includes('SUCCESS') ? "100.0" : "0.0", status: g.Status, clientName: client.name, size: g.FileSizeMB + " MB"
                        })));
                    }
                } catch (e) { Logger.log(`[Active Downloads] Failed to fetch NZBGet history`, 'warn'); }
            }
        } catch (e: any) {
            Logger.log(`[Active Downloads] ${client.name} failed to respond or timed out. Skipping.`, 'warn');
            continue; 
        }
    }

    const ignoredSetting = await prisma.systemSetting.findUnique({ where: { key: 'ignored_downloads' } });
    let ignoredIds: string[] = [];
    if (ignoredSetting?.value) {
        try { ignoredIds = JSON.parse(ignoredSetting.value); } catch (e) {}
    }

    // NEW: Fetch pending requests to un-ignore them visually
    const pendingRequests = await prisma.request.findMany({
        where: { status: { in: ['DOWNLOADING', 'STALLED'] } },
        select: { downloadLink: true }
    });
    const linkedHashes = pendingRequests.map(r => r.downloadLink).filter(Boolean);

    const filteredDownloads = allDownloads.filter(d => !ignoredIds.includes(d.id) || linkedHashes.includes(d.id));

    return NextResponse.json({ success: true, activeDownloads: filteredDownloads });

  } catch (error: unknown) {
    Logger.log(`[Active Downloads API] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ success: false, error: "Failed to process download clients.", activeDownloads: [] }, { status: 500 });
  }
}