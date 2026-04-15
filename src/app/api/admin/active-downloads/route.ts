export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import axios from 'axios';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function GET() {
  try {
    const clients = await prisma.downloadClient.findMany();
    if (clients.length === 0) {
        return NextResponse.json({ success: true, activeDownloads: [] });
    }

    let allDownloads: any[] = [];
    
    const customHeaders = await prisma.customHeader.findMany();
    let headers: any = { 'User-Agent': 'Omnibus/1.0' };
    customHeaders.forEach((h: any) => {
        if (h.key && h.value) headers[h.key.trim()] = h.value.trim();
    });

    for (const client of clients) {
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
                const loginParams = new URLSearchParams();
                loginParams.append('username', client.user || '');
                loginParams.append('password', client.pass || '');

                const authRes = await axios.post(`${cleanUrl}/api/v2/auth/login`, loginParams, {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
                    timeout: 15000 
                });

                if (authRes.data !== 'Ok.') throw new Error("qBittorrent Authentication Failed");

                const cookie = authRes.headers['set-cookie'];

                const { data: torrents } = await axios.get(`${cleanUrl}/api/v2/torrents/info`, {
                    params: { filter: 'all' }, 
                    headers: { ...headers, Cookie: cookie },
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
            else if (client.type === 'sab') {
                const res = await axios.get(`${cleanUrl}/api`, {
                    params: { mode: 'queue', apikey: client.apiKey, output: 'json' },
                    headers,
                    timeout: 15000
                });

                if (res.data?.queue?.slots) {
                    const validSlots = res.data.queue.slots.filter((s: any) => isAllowedCategory(s.cat));
                    const mapped = validSlots.map((t: any) => ({
                        id: t.nzo_id,
                        name: t.filename,
                        progress: t.percentage,
                        status: t.status.toLowerCase(),
                        size: t.size,
                        clientName: client.name
                    }));
                    allDownloads.push(...mapped);
                } else {
                    throw new Error("SABnzbd returned invalid data");
                }
            }
            else if (client.type === 'deluge') {
                const authRes = await axios.post(`${cleanUrl}/json`, { method: "auth.login", params: [client.pass], id: 1 }, { headers, timeout: 15000 });
                const cookie = authRes.headers['set-cookie'];
                const listRes = await axios.post(`${cleanUrl}/json`, { method: "web.update_ui", params: [["name", "progress", "state", "total_size"], {}], id: 2 }, { headers: { ...headers, Cookie: cookie }, timeout: 15000 });
                if (listRes.data.result?.torrents) {
                    const torrents = listRes.data.result.torrents;
                    allDownloads.push(...Object.keys(torrents).map(hash => ({
                        id: hash, name: torrents[hash].name, progress: torrents[hash].progress.toFixed(1),
                        status: torrents[hash].state, clientName: client.name, size: (torrents[hash].total_size / 1024 / 1024).toFixed(2) + " MB"
                    })));
                }
            }
            else if (client.type === 'nzbget') {
                const auth = Buffer.from(`${client.user}:${client.pass}`).toString('base64');
                const listRes = await axios.post(`${cleanUrl}/jsonrpc`, { method: "listgroups", params: [] }, { headers: { ...headers, Authorization: `Basic ${auth}` }, timeout: 15000 });
                if (Array.isArray(listRes.data.result)) {
                    const validGroups = listRes.data.result.filter((g: any) => isAllowedCategory(g.Category));
                    allDownloads.push(...validGroups.map((g: any) => ({ id: String(g.NZBID), name: g.NZBName, progress: ((g.DownloadedSizeMB / g.FileSizeMB) * 100).toFixed(1), status: g.Status, clientName: client.name, size: g.FileSizeMB + " MB" })));
                }
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