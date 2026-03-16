export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import axios from 'axios';

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
                    timeout: 10000 
                });

                if (authRes.data !== 'Ok.') throw new Error("qBittorrent Authentication Failed");

                const cookie = authRes.headers['set-cookie'];

                const { data: torrents } = await axios.get(`${cleanUrl}/api/v2/torrents/info`, {
                    params: { filter: 'all' }, 
                    headers: { ...headers, Cookie: cookie },
                    timeout: 10000
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
                    timeout: 10000
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
        } catch (e: any) {
            console.warn(`[Active Downloads] ${client.name} failed to respond or timed out. Skipping.`);
            continue; 
        }
    }

    const ignoredSetting = await prisma.systemSetting.findUnique({ where: { key: 'ignored_downloads' } });
    let ignoredIds: string[] = [];
    if (ignoredSetting?.value) {
        try { ignoredIds = JSON.parse(ignoredSetting.value); } catch (e) {}
    }

    const filteredDownloads = allDownloads.filter(d => !ignoredIds.includes(d.id));

    return NextResponse.json({ success: true, activeDownloads: filteredDownloads });

  } catch (error: any) {
    return NextResponse.json({ 
        success: false, 
        error: "Failed to process download clients.", 
        activeDownloads: [] 
    }, { status: 500 });
  }
}