import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import crypto from 'crypto';

const CACHE_DIR = process.env.OMNIBUS_CACHE_DIR || path.join(process.cwd(), '.cache', 'reader');
const zipCache = new Map<string, { zip: AdmZip, lastAccessed: number }>();

setInterval(() => {
    const now = Date.now();
    for (const [key, data] of Array.from(zipCache.entries())) {
        if (now - data.lastAccessed > 5 * 60 * 1000) {
            zipCache.delete(key);
        }
    }
}, 60000);

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');
  const pageName = searchParams.get('page');

  if (!filePath || !pageName || !fs.existsSync(filePath)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  try {
    // Read just the first 4 bytes of the file for instant Signature Detection
    const fd = fs.openSync(filePath, 'r');
    const magicBuffer = Buffer.alloc(4);
    fs.readSync(fd, magicBuffer, 0, 4, 0);
    fs.closeSync(fd);

    const isZipSignature = magicBuffer[0] === 0x50 && magicBuffer[1] === 0x4B;
    const isRarSignature = magicBuffer[0] === 0x52 && magicBuffer[1] === 0x61 && magicBuffer[2] === 0x72 && magicBuffer[3] === 0x21;

    const isZip = isZipSignature || (filePath.toLowerCase().match(/\.(cbz|epub|zip)$/) && !isRarSignature);
    const isRar = isRarSignature || (filePath.toLowerCase().match(/\.(cbr|rar)$/) && !isZipSignature);

    if (!isZip && !isRar) return new NextResponse("Format Not Supported", { status: 400 });

    let buffer: Buffer;
    let contentType = 'image/jpeg';
    if (pageName.toLowerCase().endsWith('.png')) contentType = 'image/png';
    if (pageName.toLowerCase().endsWith('.webp')) contentType = 'image/webp';

    if (isZip) {
        let zipInstance = zipCache.get(filePath)?.zip;
        if (!zipInstance) {
            zipInstance = new AdmZip(filePath);
            zipCache.set(filePath, { zip: zipInstance, lastAccessed: Date.now() });
        } else {
            zipCache.set(filePath, { zip: zipInstance, lastAccessed: Date.now() });
        }

        const zipEntry = zipInstance.getEntry(pageName) || zipInstance.getEntry(pageName.replace(/\//g, '\\'));
        if (!zipEntry) return new NextResponse("Page Not Found", { status: 404 });
        
        buffer = zipEntry.getData();

    } else if (isRar) {
        const fileHash = crypto.createHash('md5').update(filePath).digest('hex');
        const extractDir = path.join(CACHE_DIR, fileHash);
        
        const safePageName = pageName.split('/').join(path.sep);
        const targetFile = path.resolve(extractDir, safePageName);
        
        if (!targetFile.startsWith(path.resolve(extractDir))) return new NextResponse("Invalid Path", { status: 403 });
        if (!fs.existsSync(targetFile)) return new NextResponse("Page Not Found", { status: 404 });

        const now = new Date();
        fs.promises.utimes(extractDir, now, now).catch(() => {});

        buffer = await fs.promises.readFile(targetFile);
    }

    return new NextResponse(buffer!, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400', 
      },
    });
  } catch (error) {
    console.error("Image Extraction Error:", error);
    return new NextResponse("Server Error", { status: 500 });
  }
}