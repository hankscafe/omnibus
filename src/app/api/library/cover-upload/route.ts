// src/app/api/library/cover-upload/route.ts
//
// Admin-only custom series cover. POST writes the uploaded image to <folder>/cover.jpg and locks it
// (hasCustomCover=true) so neither the archive-cover backfill nor the provider sync overwrites it.
// DELETE reverts: drops the flag + removes cover.jpg so the next scan/sync re-resolves the cover.
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';
import { getToken } from 'next-auth/jwt';
import { revalidatePath, revalidateTag } from 'next/cache';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { UNMATCHED_DIR, isPathWithinRoots } from '@/lib/utils/paths';

const MAX_BYTES = 15 * 1024 * 1024; // 15MB

// Admin gate + path authorization (the folder must live inside a library / the unmatched dir) +
// resolve the owning series. Returns a discriminated result so callers stay type-safe.
async function authorize(req: NextRequest, currentPath: unknown) {
  const token = await getToken({ req });
  if (!token || token.role !== 'ADMIN') return { ok: false as const, error: 'Unauthorized', status: 403 };
  if (!currentPath || typeof currentPath !== 'string') return { ok: false as const, error: 'Missing path', status: 400 };

  const libraries = await prisma.library.findMany();
  // Separator-safe containment (consistency with cover/reader/match-series).
  if (!isPathWithinRoots(currentPath, [...libraries.map(l => l.path), UNMATCHED_DIR])) {
    return { ok: false as const, error: 'Unauthorized path access', status: 403 };
  }
  if (!fs.existsSync(currentPath)) return { ok: false as const, error: 'Folder not found', status: 404 };

  const series = await prisma.series.findFirst({ where: { folderPath: currentPath } });
  if (!series) return { ok: false as const, error: 'No series found for this folder', status: 404 };

  return { ok: true as const, token, series, currentPath };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const auth = await authorize(req, body?.currentPath);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { token, series, currentPath } = auth;

    const imageBase64 = body?.imageBase64;
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return NextResponse.json({ error: 'No image provided' }, { status: 400 });
    }
    const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    if (buffer.length === 0) return NextResponse.json({ error: 'Invalid image data' }, { status: 400 });
    if (buffer.length > MAX_BYTES) return NextResponse.json({ error: 'Image too large (max 15MB)' }, { status: 413 });

    // The custom cover always lives at cover.jpg; remove other cover.* variants (e.g. an extracted
    // cover.webp) so the chosen image is unambiguous to the cover route + external tools.
    const coverPath = path.join(currentPath, 'cover.jpg');
    for (const variant of ['cover.jpeg', 'cover.png', 'cover.webp', 'Cover.jpg', 'Cover.png', 'folder.jpg', 'folder.png']) {
      const vp = path.join(currentPath, variant);
      if (await fs.pathExists(vp)) { try { await fs.remove(vp); } catch { /* best effort */ } }
    }
    await fs.writeFile(coverPath, buffer);

    const coverUrl = `/api/library/cover?path=${encodeURIComponent(coverPath)}&v=${Date.now()}`;
    await prisma.series.update({ where: { id: series.id }, data: { coverUrl, hasCustomCover: true } });

    await AuditLogger.log('UPLOAD_SERIES_COVER', { seriesName: series.name, path: currentPath }, (token.id || token.sub) as string);
    revalidateTag('library'); revalidatePath('/library'); revalidatePath('/library/series');
    Logger.log(`[Cover] Custom cover uploaded for ${series.name}`, 'info');
    return NextResponse.json({ success: true, coverUrl });
  } catch (error: unknown) {
    Logger.log(`[Cover Upload] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    const auth = await authorize(req, body?.currentPath);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { token, series, currentPath } = auth;

    // Revert to automatic: remove the custom cover so the next scan extracts an archive cover (or the
    // provider sync downloads one), and clear coverUrl so nothing points at the now-deleted file.
    const coverPath = path.join(currentPath, 'cover.jpg');
    if (await fs.pathExists(coverPath)) { try { await fs.remove(coverPath); } catch { /* best effort */ } }
    await prisma.series.update({ where: { id: series.id }, data: { coverUrl: null, hasCustomCover: false } });

    await AuditLogger.log('REVERT_SERIES_COVER', { seriesName: series.name, path: currentPath }, (token.id || token.sub) as string);
    revalidateTag('library'); revalidatePath('/library'); revalidatePath('/library/series');
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    Logger.log(`[Cover Revert] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
