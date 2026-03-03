import { NextResponse } from 'next/server';
import axios from 'axios';

export async function POST(request: Request) {
  try {
    const { url, apiKey, headers } = await request.json();
    const cleanUrl = url.replace(/\/$/, '');

    // Parse custom headers
    let extraHeaders = {};
    if (headers && Array.isArray(headers)) {
        headers.forEach((h: any) => { if (h.key && h.value) extraHeaders[h.key] = h.value; });
    }

    console.log(`[Prowlarr] Fetching indexers from: ${cleanUrl}`);

    // Fetch Configured Indexers
    const res = await axios.get(`${cleanUrl}/api/v1/indexer`, {
      headers: { 'X-Api-Key': apiKey, ...extraHeaders },
      timeout: 10000
    });

    if (!Array.isArray(res.data)) {
        console.error("[Prowlarr] Response was not an array:", res.data);
        throw new Error("Prowlarr returned invalid data format.");
    }

    console.log(`[Prowlarr] Raw count: ${res.data.length}`);

    // Map the raw Prowlarr data
    // We filter for 'id' to ensure we aren't picking up schema definitions
    const mapped = res.data
        .filter((idx: any) => idx.id && idx.name) 
        .map((idx: any) => ({
            id: idx.id,
            name: idx.name,
            protocol: idx.protocol, // 'torrent' or 'usenet'
            priority: idx.priority || 25,
            rss: idx.enableRss || false,
            seedTime: 0 
        }));

    console.log(`[Prowlarr] Mapped count: ${mapped.length}`);

    return NextResponse.json(mapped);
  } catch (error: any) {
    console.error("Prowlarr Refresh Error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}