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

// Respect the Omnibus system cache directory mapping
const baseCacheDir = process.env.OMNIBUS_CACHE_DIR || '/cache';
const CACHE_DIR = path.join(baseCacheDir, 'reader_images');

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

  if (!filePath || !pageName || !fs.existsSync(filePath)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  try {
    const libraries = await prisma.library.findMany();
    
    // BULLETPROOF PATH CHECK
    const cleanTarget = filePath.replace(/\\/g, '/').toLowerCase();
    const isAuthorized = libraries.some(lib => {
        let cleanRoot = lib.path.replace(/\\/g, '/').toLowerCase();
        if (!cleanRoot.endsWith('/')) cleanRoot += '/';
        return cleanTarget === cleanRoot || cleanTarget.startsWith(cleanRoot);
    });

    if (!isAuthorized) {
      return new NextResponse("Unauthorized path access", { status: 403 });
    }

    const isZip = filePath.toLowerCase().match(/\.(cbz|epub|zip)$/);
    if (!isZip) return new NextResponse("Format Not Supported (Likely awaiting CBZ conversion)", { status: 400 });

    // --- DISK CACHE CHECK ---
    // Grab the physical file's modified time to prevent serving stale cache if the file is replaced
    const fileStats = fs.statSync(filePath);
    const fileMtime = fileStats.mtimeMs;

    const cacheKey = crypto.createHash('md5').update(`${filePath}-${pageName}-${shouldCrop}-${fileMtime}`).digest('hex') + '.webp';
    const cacheFilePath = path.join(CACHE_DIR, cacheKey);

    if (fs.existsSync(cacheFilePath)) {
        try {
            const cachedBuffer = fs.readFileSync(cacheFilePath);
            // Touch the file to update its modified time (keeps it alive in the cache)
            fs.utimesSync(cacheFilePath, new Date(), new Date()); 
            
            return new NextResponse(cachedBuffer as unknown as BodyInit, {
                headers: {
                    'Content-Type': 'image/webp',
                    'Cache-Control': 'public, max-age=86400', 
                },
            });
        } catch (e) {
            Logger.log(`[Reader] Failed to read image cache: ${getErrorMessage(e)}`, 'warn');
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

        // --- SAVE TO DISK CACHE (ATOMIC WRITE) ---
        // Write to a temporary randomized file first, then rename it. 
        // This prevents corrupted images if two requests try to write the same page simultaneously.
        const tempFilePath = `${cacheFilePath}.${Date.now()}.${Math.random().toString(36).substring(7)}.tmp`;
        
        fs.promises.writeFile(tempFilePath, finalBuffer)
            .then(() => fs.promises.rename(tempFilePath, cacheFilePath))
            .catch((err: any) => {
                Logger.log(`[Reader] Failed to write image cache: ${err.message}`, 'warn');
                // Attempt to clean up the orphaned temp file
                fs.promises.unlink(tempFilePath).catch(() => {});
            });

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