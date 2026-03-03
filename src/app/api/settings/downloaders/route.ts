import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { DownloadService } from '@/lib/download-clients';

export async function GET() {
  const configs = await prisma.systemConfig.findMany({
    where: {
      key: { in: ['qbit_url', 'qbit_username', 'sab_url', 'sab_apikey'] }
    }
  });

  const settings: any = {};
  configs.forEach(c => settings[c.key] = c.value);

  return NextResponse.json(settings);
}

export async function POST(req: Request) {
  const body = await req.json();
  const { type, testOnly, ...data } = body;

  try {
    if (type === 'qbit') {
      let { url, username, password } = data;
      
      // AUTO-FIX: Remove trailing slash if present
      if (url) url = url.replace(/\/$/, "");

      // Test First
      if (testOnly) {
        const success = await DownloadService.testQBit(url, username, password);
        return NextResponse.json({ success });
      }

      // Save
      await prisma.systemConfig.upsert({ where: { key: 'qbit_url' }, update: { value: url }, create: { key: 'qbit_url', value: url } });
      await prisma.systemConfig.upsert({ where: { key: 'qbit_username' }, update: { value: username }, create: { key: 'qbit_username', value: username } });
      if (password) { 
        await prisma.systemConfig.upsert({ where: { key: 'qbit_password' }, update: { value: password }, create: { key: 'qbit_password', value: password } });
      }
    } 
    
    else if (type === 'sab') {
      let { url, apiKey } = data;
      
      // AUTO-FIX: Remove trailing slash
      if (url) url = url.replace(/\/$/, "");

      if (testOnly) {
        const success = await DownloadService.testSab(url, apiKey);
        return NextResponse.json({ success });
      }

      await prisma.systemConfig.upsert({ where: { key: 'sab_url' }, update: { value: url }, create: { key: 'sab_url', value: url } });
      await prisma.systemConfig.upsert({ where: { key: 'sab_apikey' }, update: { value: apiKey }, create: { key: 'sab_apikey', value: apiKey } });
    }

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ success: false, error: 'Operation failed' }, { status: 500 });
  }
}