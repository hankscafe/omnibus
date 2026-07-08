// src/app/api/reader/preferences/route.ts
//
// Per-user, per-series reader preferences. GET returns the saved settings blob for a series (or null);
// POST upserts it. Keyed by the authenticated user + the series id (resolved client-side from the
// series the reader already loaded). The settings shape is owned by the reader UI and stored as JSON
// so adding a new reader setting needs no migration.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

async function resolveUserId(): Promise<string | undefined> {
  const authOptions = await getAuthOptions();
  const session = await getServerSession(authOptions);
  let userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId && session?.user?.email) {
    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    userId = user?.id;
  }
  return userId;
}

export async function GET(request: Request) {
  try {
    const userId = await resolveUserId();
    if (!userId) return NextResponse.json({ settings: null });

    const seriesId = new URL(request.url).searchParams.get('seriesId');
    if (!seriesId) return NextResponse.json({ settings: null });

    const pref = await prisma.readerPreference.findUnique({
      where: { userId_seriesId: { userId, seriesId } },
    });
    // settings is stored as a JSON string (SQLite has no Json type) — parse back to an object for the client.
    let settings: unknown = null;
    if (pref?.settings) {
      try { settings = JSON.parse(pref.settings); } catch { settings = null; }
    }
    return NextResponse.json({ settings });
  } catch (error: unknown) {
    Logger.log(`[Reader Prefs] GET Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ settings: null });
  }
}

export async function POST(request: Request) {
  try {
    const userId = await resolveUserId();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { seriesId, settings } = await request.json();
    if (!seriesId || typeof seriesId !== 'string' || typeof settings !== 'object' || settings === null) {
      return NextResponse.json({ error: 'Missing seriesId or settings' }, { status: 400 });
    }

    // Store as a JSON string (SQLite has no Json type); GET parses it back. FK to Series rejects an unknown seriesId.
    const serialized = JSON.stringify(settings);
    await prisma.readerPreference.upsert({
      where: { userId_seriesId: { userId, seriesId } },
      update: { settings: serialized },
      create: { userId, seriesId, settings: serialized },
    });
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    Logger.log(`[Reader Prefs] POST Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
