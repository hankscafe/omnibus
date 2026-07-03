import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import crypto from 'crypto';
import os from 'os';
import { prisma } from '@/lib/db'; 
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { CACHE_DIR as BASE_CACHE_DIR, isPathWithinRoots } from '@/lib/utils/paths';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getAccessibleLibraryPaths, canAccessPath } from '@/lib/library-access';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';

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

const zipCache = new Map<string, { zip: AdmZip, lastAccessed: number }>();
const MAX_CACHE_SIZE = 6; // Optimized for high-RAM (64GB+) environments

// Aggressive cache cleanup (runs every 30 seconds)
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of zipCache.entries()) {
        // Reduced TTL: Drop cache if untouched for 60 seconds
        if (now - data.lastAccessed > 60 * 1000) {
            zipCache.delete(key);
        }
    }
}, 30000); 

function getZipInstance(filePath: string) {
    const now = Date.now();
    
    // Size-based bypass: Since the host has ample RAM, we can safely increase this bypass limit to 1GB.
    // Files over 1GB will bypass the cache to prevent extreme spikes.
    const stats = fs.statSync(filePath);
    const isMassiveFile = stats.size > 1024 * 1024 * 1024; // 1GB

    if (isMassiveFile) {
        Logger.log(`[Reader] Bypassing cache for massive file (>1GB): ${filePath}`, 'debug');
        return new AdmZip(filePath);
    }

    let cached = zipCache.get(filePath);
    
    if (!cached) {
        if (zipCache.size >= MAX_CACHE_SIZE) {
            let oldestKey = null;
            let oldestTime = Infinity;
            for (const [key, data] of zipCache.entries()) {
                if (data.lastAccessed < oldestTime) {
                    oldestTime = data.lastAccessed;
                    oldestKey = key;
                }
            }
            if (oldestKey) zipCache.delete(oldestKey);
        }
        cached = { zip: new AdmZip(filePath), lastAccessed: now };
        zipCache.set(filePath, cached);
    } else {
        cached.lastAccessed = now;
    }
    return cached.zip;
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
    if (!isZip) return new NextResponse("Format Not Supported (Likely awaiting CBZ conversion)", { status: 400 });

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

    // --- ENGINE OFFLOAD (non-crop pages) ---
    // Hand the extract + resize + WebP encode to the Rust engine so the whole-archive AdmZip buffer and
    // sharp don't run on the Node event loop (which serves every request). The auto-crop path has no
    // clean engine equivalent, so it stays local. Any failure (engine down, older engine without the
    // route, unreadable page) falls through to the local sharp path below — the reader never breaks.
    if (!shouldCrop) {
        try {
            const engineRes = await fetch(ENGINE_URL + '/api/reader/page', {
                method: 'POST',
                headers: engineHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ path: filePath, entry: pageName, width: 1600, quality: 80 }),
            });
            if (engineRes.ok) {
                const engineBuffer = Buffer.from(await engineRes.arrayBuffer());
                if (engineBuffer.length > 0) {
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
    }

    const zipInstance = getZipInstance(filePath);
    
    let zipEntry = zipInstance.getEntry(pageName) || zipInstance.getEntry(pageName.replace(/\//g, '\\'));
    
    if (!zipEntry) {
        const getBaseName = (p: string) => p.split(/[/\\]/).pop() || p;
        const targetFile = getBaseName(pageName);
        zipEntry = zipInstance.getEntries().find(e => getBaseName(e.entryName) === targetFile) || null;
    }

    if (!zipEntry) return new NextResponse("Page Not Found", { status: 404 });
    
    const buffer = zipEntry.getData();
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