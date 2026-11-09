import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import crypto from 'crypto';
import { prisma } from '@/lib/db'; 
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { CACHE_DIR as BASE_CACHE_DIR, isPathWithinRoots } from '@/lib/utils/paths';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getAccessibleLibraryPaths, canAccessPath } from '@/lib/library-access';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';
import { readArchivePage } from '@/lib/utils/archive-pages';

// Atomic disk-cache write: temp file → rename, so concurrent requests for the same page can't serve a
// half-written image. Best-effort + non-blocking (fire-and-forget).
function writePageCacheAtomic(cacheFilePath: string, buffer: Buffer) {
    const tempFilePath = `${cacheFilePath}.${Date.now()}.${Math.random().toString(36).substring(7)}.tmp`;
    fs.promises.writeFile(tempFilePath, buffer)
        .then(() => fs.promises.rename(tempFilePath, cacheFilePath))
        .catch((err: any) => {
            Logger.log(`[Reader] Failed to write image cache: ${err.message}`, 'warn');
            fs.promises.unlink(tempFilePath).catch(() => {});
        });
}

// Reader page cache lives in a subfolder of the system cache directory
const CACHE_DIR = path.join(BASE_CACHE_DIR, 'reader_images');

// Disk Cache Cleanup (Runs every hour)
// Prevents the disk from filling up by deleting pages unaccessed for 24 hours.
setInterval(() => {
    try {
        if (!fs.existsSync(CACHE_DIR)) return;
        const files = fs.readdirSync(CACHE_DIR);
        const now = Date.now();
        for (const file of files) {
            const filePath = path.join(CACHE_DIR, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > 24 * 60 * 60 * 1000) {
                fs.unlinkSync(filePath);
            }
        }
    } catch (e) {
        // Silently ignore cleanup errors
    }
}, 60 * 60 * 1000); 

// The reader's page width. Crop mode asks the engine for a wider page, trims the margins here, then
// fits the result to READER_WIDTH - the same output as trimming the original (the engine never
// enlarges a page, so a small page stays its own size).
const READER_WIDTH = 1600;
const CROP_SOURCE_WIDTH = 2400;

// Crop mode: trim the uniform margins, then fit the reader's width. A page sharp can't trim (one
// solid colour) is served untrimmed rather than failing the request.
async function trimToReaderWidth(buffer: Buffer): Promise<Buffer> {
    try {
        return await sharp(buffer).trim().resize({ width: READER_WIDTH, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    } catch {
        return await sharp(buffer).resize({ width: READER_WIDTH, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    }
}

export async function GET(request: Request) {
  // Ensure the cache directory exists lazily at runtime, skipping the build phase
  if (!fs.existsSync(CACHE_DIR)) {
      try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) {}
  }

  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');
  const pageName = searchParams.get('page');
  const shouldCrop = searchParams.get('crop') === 'true';

  if (!filePath || !pageName) {
    return new NextResponse("Not Found", { status: 404 });
  }

  try {
    const libraries = await prisma.library.findMany();

    // Normalize before the containment check so `..` segments can't escape a library root.
    if (!isPathWithinRoots(filePath, libraries.map(lib => lib.path))) {
      return new NextResponse("Unauthorized path access", { status: 403 });
    }

    // Per-library access: the file must live under a library the user has been granted (admins bypass).
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const accessiblePaths = await getAccessibleLibraryPaths((session?.user as any)?.id, (session?.user as any)?.role);
    if (!canAccessPath(accessiblePaths, filePath)) {
      return new NextResponse("You don't have access to this library.", { status: 403 });
    }

    const isZip = filePath.toLowerCase().match(/\.(cbz|epub|zip)$/);
    // RAR (via unrar) and 7z/.cb7 (via the pure-Rust decoder) both read natively in the engine.
    const isEngineFormat = filePath.toLowerCase().match(/\.(cbr|rar|cb7)$/);
    if (!isZip && !isEngineFormat) return new NextResponse("Format Not Supported (Likely awaiting CBZ conversion)", { status: 400 });

    // --- DISK CACHE CHECK ---
    // Grab the physical file's modified time to prevent serving stale cache if the file is replaced.
    // The async stat doubles as the existence check (throws → 404), keeping sync fs off the event loop.
    let fileStats;
    try {
        fileStats = await fs.promises.stat(filePath);
    } catch {
        return new NextResponse("Not Found", { status: 404 });
    }
    const fileMtime = fileStats.mtimeMs;

    const cacheKey = crypto.createHash('md5').update(`${filePath}-${pageName}-${shouldCrop}-${fileMtime}`).digest('hex') + '.webp';
    const cacheFilePath = path.join(CACHE_DIR, cacheKey);

    // Async cache read (one syscall instead of a blocking existsSync + readFileSync): a miss throws
    // ENOENT → fall through to extraction. This is the reader's hot path on re-reads.
    try {
        const cachedBuffer = await fs.promises.readFile(cacheFilePath);
        // Touch the file to keep it alive in the cache (best-effort, non-blocking).
        fs.promises.utimes(cacheFilePath, new Date(), new Date()).catch(() => {});
        return new NextResponse(cachedBuffer as unknown as BodyInit, {
            headers: {
                'Content-Type': 'image/webp',
                'Cache-Control': 'public, max-age=86400',
            },
        });
    } catch (e: any) {
        if (e?.code !== 'ENOENT') Logger.log(`[Reader] Failed to read image cache: ${getErrorMessage(e)}`, 'warn');
    }

    // --- ENGINE OFFLOAD ---
    // Hand the extract + resize + WebP encode to the Rust engine for every archive type, so no archive
    // is ever loaded into Node's memory and sharp stays off the event loop (which serves every
    // request). Crop mode included: the engine returns a wider page and it's trimmed here. Any
    // failure (engine down, older engine without the route, unreadable page) falls through to the
    // local path below.
    try {
        const engineRes = await fetch(ENGINE_URL + '/api/reader/page', {
            method: 'POST',
            headers: engineHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ path: filePath, entry: pageName, width: shouldCrop ? CROP_SOURCE_WIDTH : READER_WIDTH, quality: 80 }),
        });
        if (engineRes.ok) {
            let engineBuffer: Buffer = Buffer.from(await engineRes.arrayBuffer());
            if (engineBuffer.length > 0) {
                if (shouldCrop) engineBuffer = await trimToReaderWidth(engineBuffer);
                writePageCacheAtomic(cacheFilePath, engineBuffer);
                return new NextResponse(engineBuffer as unknown as BodyInit, {
                    headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' },
                });
            }
        }
        // Non-OK (e.g. 404 page-not-found, or an older engine) → fall through to the local path.
    } catch (e) {
        Logger.log(`[Reader] Engine page offload unavailable, using local extraction: ${getErrorMessage(e)}`, 'debug');
    }

    // No local fallback exists for RAR/7z — Node has no reader for them.
    if (isEngineFormat) {
        return new NextResponse("Native page extraction requires the engine. Check that the engine container is running, or wait for the CBZ auto-conversion.", { status: 502 });
    }

    // Engine unavailable: read just this page through the zip's index (lib/utils/archive-pages) - the
    // whole archive is never loaded, whatever its size.
    const buffer = await readArchivePage(filePath, pageName);
    if (!buffer) return new NextResponse("Page Not Found", { status: 404 });

    let finalBuffer = buffer;
    let contentType = 'image/jpeg';

    try {
        let imagePipeline = sharp(buffer);
        
        // Auto-Margin Cropping
        if (shouldCrop) {
            imagePipeline = imagePipeline.trim();
        }

        finalBuffer = await imagePipeline
            .resize({ width: 1600, withoutEnlargement: true }) 
            .webp({ quality: 80 })
            .toBuffer();
            
        contentType = 'image/webp';

        // Save to the disk cache (atomic temp→rename write).
        writePageCacheAtomic(cacheFilePath, finalBuffer);

    } catch (imgErr) {
        if (pageName.toLowerCase().endsWith('.png')) contentType = 'image/png';
        if (pageName.toLowerCase().endsWith('.webp')) contentType = 'image/webp';
    }

    return new NextResponse(finalBuffer as unknown as BodyInit, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400', 
      },
    });
  } catch (error: unknown) {
    Logger.log(`Image Extraction Error: ${getErrorMessage(error)}`, 'error');
    return new NextResponse("Server Error", { status: 500 });
  }
}