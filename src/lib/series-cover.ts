// src/lib/series-cover.ts
//
// The two halves of "this comic's own art as the cover", shared by the archive-cover preview, the
// custom series cover upload and (#257) the collected-edition attach, which can give a series the
// first book's own cover in the same request — BEFORE the provider sync it queues, so that sync sees
// the lock and never replaces the art with the provider's.
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';
import { prisma } from '@/lib/db';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';

export type ArchiveCover = { ok: true; body: Buffer; contentType: string } | { ok: false; status: number };

/**
 * The FIRST page of a comic archive as a cover-sized JPEG. The engine extracts it (the scanner's
 * multi-format extract_first_image, so CBZ and CBR/RAR/CB7 alike) and it is downscaled here; a page
 * sharp can't decode is served raw. `status` 404 = no readable page, 502 = the engine failed.
 */
export async function archiveCoverJpeg(filePath: string): Promise<ArchiveCover> {
    const engineRes = await fetch(`${ENGINE_URL}/api/converter/extract-cover`, {
        method: 'POST',
        headers: engineHeaders({ 'Content-Type': 'application/json' }),
        // The engine runs as its own process (own cwd/container): always an absolute path.
        body: JSON.stringify({ path: path.resolve(filePath) }),
    });
    if (!engineRes.ok) return { ok: false, status: engineRes.status === 404 ? 404 : 502 };
    const raw = Buffer.from(await engineRes.arrayBuffer());
    if (raw.length === 0) return { ok: false, status: 404 };
    try {
        return { ok: true, body: await sharp(raw).resize({ width: 500, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer(), contentType: 'image/jpeg' };
    } catch {
        return { ok: true, body: raw, contentType: engineRes.headers.get('content-type') || 'image/jpeg' };
    }
}

/**
 * Saves `image` as the series' locked custom cover: <folder>/cover.jpg, with the other cover.*
 * variants removed so the choice is unambiguous to the cover route and external tools, and
 * hasCustomCover set so neither the archive-cover backfill nor a provider sync overwrites it.
 * Returns the new coverUrl.
 */
export async function saveCustomSeriesCover(seriesId: string, folderPath: string, image: Buffer): Promise<string> {
    const coverPath = path.join(folderPath, 'cover.jpg');
    for (const variant of ['cover.jpeg', 'cover.png', 'cover.webp', 'Cover.jpg', 'Cover.png', 'folder.jpg', 'folder.png']) {
        const vp = path.join(folderPath, variant);
        if (await fs.pathExists(vp)) { try { await fs.remove(vp); } catch { /* best effort */ } }
    }
    await fs.writeFile(coverPath, image);
    const coverUrl = `/api/library/cover?path=${encodeURIComponent(coverPath)}&v=${Date.now()}`;
    await prisma.series.update({ where: { id: seriesId }, data: { coverUrl, hasCustomCover: true } });
    return coverUrl;
}
