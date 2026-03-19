import { NextResponse } from 'next/server';
import axios from 'axios';
import { Logger } from '@/lib/logger'; // <-- IMPORT LOGGER

export async function POST(request: Request) {
  try {
    const { url, apiKey, headers } = await request.json();
    const cleanUrl = url.replace(/\/$/, '');

    let extraHeaders = {};
    if (headers && Array.isArray(headers)) {
        headers.forEach((h: any) => { if (h.key && h.value) extraHeaders[h.key] = h.value; });
    }

    Logger.log(`[Prowlarr] Fetching indexers from: ${cleanUrl}`, 'info'); // <-- FIXED

    const res = await axios.get(`${cleanUrl}/api/v1/indexer`, {
      headers: { 'X-Api-Key': apiKey, ...extraHeaders },
      timeout: 10000
    });

    if (!Array.isArray(res.data)) {
        Logger.log(`[Prowlarr] Response was not an array: ${JSON.stringify(res.data).substring(0, 100)}`, 'error'); // <-- FIXED
        throw new Error("Prowlarr returned invalid data format.");
    }

    Logger.log(`[Prowlarr] Raw count: ${res.data.length}`, 'info'); // <-- FIXED

    const mapped = res.data
        .filter((idx: any) => idx.id && idx.name) 
        .map((idx: any) => ({
            id: idx.id,
            name: idx.name,
            protocol: idx.protocol, 
            priority: idx.priority || 25,
            rss: idx.enableRss || false,
            seedTime: 0 
        }));

    Logger.log(`[Prowlarr] Mapped count: ${mapped.length}`, 'success'); // <-- FIXED

    return NextResponse.json(mapped);
  } catch (error: any) {
    Logger.log(`[Prowlarr] Refresh Error: ${error.message}`, 'error'); // <-- FIXED
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}