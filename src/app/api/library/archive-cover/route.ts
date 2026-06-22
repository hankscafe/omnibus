// src/app/api/library/archive-cover/route.ts
//
// Admin-only, read-only: returns the FIRST page of a comic archive as a small cover-sized JPEG.
// The Smart Matcher metadata editor calls this to preview a loose file's OWN cover art, so an admin
// can opt to use it as the issue cover instead of waiting on the metadata provider.
//
// Hybrid design (single source of truth for extraction): the Rust engine extracts the first page —
// reusing the same multi-format extract_first_image the scanner uses, so CBZ AND CBR/RAR/CB7 work —
// and this route resizes/re-encodes the returned bytes with sharp. Locked to library roots + the
// unmatched dir (where loose files live). If the engine is unreachable or finds no page, the UI
// falls back to an upload or the provider's cover.
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { getToken } from 'next-auth/jwt';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { isPathWithinRoots, UNMATCHED_DIR } from '@/lib/utils/paths';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';

export async function GET(req: NextRequest) {
  const token = await getToken({ req });
  if (!token || token.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const filePath = new URL(req.url).searchParams.get('path');
  if (!filePath || !fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  try {
    // Range-check before involving the engine; the engine repeats this check as defense-in-depth.
    const libraries = await prisma.library.findMany();
    if (!isPathWithinRoots(filePath, [...libraries.map(l => l.path), UNMATCHED_DIR])) {
      return NextResponse.json({ error: 'Unauthorized path access' }, { status: 403 });
    }

    // The engine runs as a separate process (its own cwd/container), so it can't resolve a relative
    // path the way this route can. Send an absolute path — the file exists (checked above) and lives on
    // the same filesystem the engine sees (shared /data mount in prod; same disk in dev).
    const absolutePath = path.resolve(filePath);

    // Ask the engine for the raw first page (handles every comic format the scanner does).
    const engineRes = await fetch(`${ENGINE_URL}/api/converter/extract-cover`, {
      method: 'POST',
      headers: engineHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path: absolutePath }),
    });

    if (!engineRes.ok) {
      // 404 = archive has no readable page; anything else = engine error/unreachable. Either way the
      // dialog treats a non-OK response as "no archive cover" and falls back to upload/provider.
      Logger.log(`[Archive Cover] Engine returned ${engineRes.status} for ${filePath}`, 'debug');
      return new NextResponse('No archive cover', { status: engineRes.status === 404 ? 404 : 502 });
    }

    const raw = Buffer.from(await engineRes.arrayBuffer());
    if (raw.length === 0) return new NextResponse('No archive cover', { status: 404 });

    // Downscale to a cover thumbnail and re-encode to JPEG — it's both the preview and the bytes that
    // get saved to <issueId>.jpg if the admin keeps it, so JPEG matches the stored extension.
    let body: Buffer = raw;
    let contentType = 'image/jpeg';
    try {
      body = await sharp(raw).resize({ width: 500, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    } catch {
      // sharp couldn't decode it — serve the engine's raw page so the admin at least sees something.
      contentType = engineRes.headers.get('content-type') || 'image/jpeg';
    }

    return new NextResponse(body as unknown as BodyInit, {
      headers: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=300' },
    });
  } catch (error: unknown) {
    Logger.log(`[Archive Cover] Failed to extract first page for ${filePath}: ${getErrorMessage(error)}`, 'warn');
    return new NextResponse('Failed to read archive', { status: 500 });
  }
}
