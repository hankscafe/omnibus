import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// GET: Retrieve the API Key
export async function GET() {
  try {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: 'cv_api_key' }
    });
    return NextResponse.json({ apiKey: setting?.value || '' });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
}

// POST: Save the API Key
export async function POST(request: Request) {
  try {
    const { apiKey } = await request.json();

    // Upsert: Update if exists, Create if not
    await prisma.systemSetting.upsert({
      where: { key: 'cv_api_key' },
      update: { value: apiKey },
      create: { key: 'cv_api_key', value: apiKey }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}