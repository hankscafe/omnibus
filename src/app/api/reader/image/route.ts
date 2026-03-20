import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { prisma } from '@/lib/db'; 
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

const zipCache = new Map<string, { zip: AdmZip, lastAccessed: number }>();
const MAX_CACHE_SIZE = 10; 

setInterval(() => {
    const now = Date.now();
    for (const [key, data] of zipCache.entries()) {
        if (now - data.lastAccessed > 5 * 60 * 1000) {
            zipCache.delete(key);
        }
    }
}, 60000); 

function getZipInstance(filePath: string) {
    const now = Date.now();
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
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');
  const pageName = searchParams.get('page');

  if (!filePath || !pageName || !fs.existsSync(filePath)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  try {
    const libraries = await prisma.library.findMany();
    const authorizedRoots = libraries.map(l => path.normalize(l.path).toLowerCase());
    const targetPath = path.normalize(filePath).toLowerCase();

    if (!authorizedRoots.some(root => targetPath.startsWith(root))) {
      return new NextResponse("Unauthorized path access", { status: 403 });
    }

    const isZip = filePath.toLowerCase().match(/\.(cbz|epub|zip)$/);
    if (!isZip) return new NextResponse("Format Not Supported (Likely awaiting CBZ conversion)", { status: 400 });

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
        finalBuffer = await sharp(buffer)
            .resize({ width: 1600, withoutEnlargement: true }) 
            .webp({ quality: 80 })
            .toBuffer();
        contentType = 'image/webp';
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