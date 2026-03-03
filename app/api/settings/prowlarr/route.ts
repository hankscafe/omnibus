import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { ProwlarrService } from '@/lib/prowlarr';

// GET: Retrieve current settings
export async function GET() {
  const url = await prisma.systemConfig.findUnique({ where: { key: 'prowlarr_url' } });
  const indexers = await prisma.systemConfig.findUnique({ where: { key: 'prowlarr_indexers' } });
  
  // Note: We never send the API Key back to the frontend for security.
  // We just send a boolean "configured: true"
  const isConfigured = await prisma.systemConfig.count({ where: { key: 'prowlarr_key' } });

  return NextResponse.json({
    url: url?.value || '',
    configured: isConfigured > 0,
    selectedIndexers: indexers ? JSON.parse(indexers.value) : []
  });
}

// POST: Save settings & Test
export async function POST(req: Request) {
  const body = await req.json();
  const { url, apiKey, indexerIds, testOnly } = body;

  // 1. Test the connection first
  const isConnected = await ProwlarrService.testConnection(url, apiKey);
  
  if (!isConnected) {
    return NextResponse.json({ success: false, error: 'Connection failed' }, { status: 400 });
  }

  if (testOnly) {
    // If just testing, return success and the list of indexers found
    const indexers = await ProwlarrService.getIndexers(url, apiKey);
    return NextResponse.json({ success: true, indexers });
  }

  // 2. Save to Database
  await prisma.systemConfig.upsert({
    where: { key: 'prowlarr_url' },
    update: { value: url },
    create: { key: 'prowlarr_url', value: url }
  });

  await prisma.systemConfig.upsert({
    where: { key: 'prowlarr_key' },
    update: { value: apiKey },
    create: { key: 'prowlarr_key', value: apiKey }
  });
  
  await prisma.systemConfig.upsert({
    where: { key: 'prowlarr_indexers' },
    update: { value: JSON.stringify(indexerIds || []) },
    create: { key: 'prowlarr_indexers', value: JSON.stringify(indexerIds || []) }
  });

  return NextResponse.json({ success: true });
}