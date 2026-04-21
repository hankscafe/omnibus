import { NextResponse } from 'next/server';
import axios from 'axios';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger'; 
import { getErrorMessage } from '@/lib/utils/error';

export async function POST(request: Request) {
  try {
    // --- SECURITY ENFORCEMENT ---
    const setupStatus = await prisma.systemSetting.findUnique({ where: { key: 'setup_complete' } });
    if (setupStatus?.value === 'true') {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
    }

    const { url, apiKey, headers } = await request.json();
    const cleanUrl = url.replace(/\/$/, '');

    // FIXED: Explicitly typed the record
    const extraHeaders: Record<string, string> = {};
    if (headers && Array.isArray(headers)) {
        headers.forEach((h: any) => { if (h.key && h.value) extraHeaders[h.key] = h.value; });
    }

    Logger.log(`[Prowlarr] Fetching indexers from: ${cleanUrl}`, 'info'); 

    const res = await axios.get(`${cleanUrl}/api/v1/indexer`, {
      headers: { 'X-Api-Key': apiKey, ...extraHeaders },
      timeout: 10000
    });

    if (!Array.isArray(res.data)) {
        Logger.log(`[Prowlarr] Response was not an array: ${JSON.stringify(res.data).substring(0, 100)}`, 'error'); 
        throw new Error("Prowlarr returned invalid data format.");
    }

    Logger.log(`[Prowlarr] Raw count: ${res.data.length}`, 'info'); 

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

    Logger.log(`[Prowlarr] Mapped count: ${mapped.length}`, 'success'); 

    return NextResponse.json(mapped);
  } catch (error: unknown) {
    Logger.log(`[Prowlarr] Refresh Error: ${getErrorMessage(error)}`, 'error'); 
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}