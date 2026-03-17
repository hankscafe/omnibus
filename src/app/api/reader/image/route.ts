import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { prisma } from '@/lib/db'; 

// @ts-ignore
import { createExtractorFromFile } from 'node-unrar-js/esm';

const zipCache = new Map<string, { zip: AdmZip, lastAccessed: number }>();

// OPTIMIZATION: Standalone interval to prevent memory leaks from abandoned AdmZip instances
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of zipCache.entries()) {
        if (now - data.lastAccessed > 5 * 60 * 1000) {
            zipCache.delete(key);
        }
    }
}, 60000); // Runs every 60 seconds independently

function getZipInstance(filePath: string) {
    const now = Date.now();
    let cached = zipCache.get(filePath);
    if (!cached) {
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
    // --- PATH TRAVERSAL FIX: Authorize against known libraries ---
    const libraries = await prisma.library.findMany();
    const authorizedRoots = libraries.map(l => path.normalize(l.path).toLowerCase());
    const targetPath = path.normalize(filePath).toLowerCase();

    const isAuthorized = authorizedRoots.some(root => targetPath.startsWith(root));

    if (!isAuthorized) {
      return new NextResponse("Unauthorized path access", { status: 403 });
    }
    // -------------------------------------------------------------

    const fd = fs.openSync(filePath, 'r');
    const magicBuffer = Buffer.alloc(4);
    fs.readSync(fd, magicBuffer, 0, 4, 0);
    fs.closeSync(fd);

    const isZipSignature = magicBuffer[0] === 0x50 && magicBuffer[1] === 0x4B;
    const isRarSignature = magicBuffer[0] === 0x52 && magicBuffer[1] === 0x61 && magicBuffer[2] === 0x72 && magicBuffer[3] === 0x21;

    const isZip = isZipSignature || (filePath.toLowerCase().match(/\.(cbz|epub|zip)$/) && !isRarSignature);
    const isRar = isRarSignature || (filePath.toLowerCase().match(/\.(cbr|rar)$/) && !isZipSignature);

    if (!isZip && !isRar) return new NextResponse("Format Not Supported", { status: 400 });

    let buffer: Buffer | null = null;

    if (isZip) {
        const zipInstance = getZipInstance(filePath);
        const zipEntry = zipInstance.getEntry(pageName) || zipInstance.getEntry(pageName.replace(/\//g, '\\'));
        if (!zipEntry) return new NextResponse("Page Not Found", { status: 404 });
        
        buffer = zipEntry.getData();

    } else if (isRar) {
        let options: any = { filepath: filePath };
        
        try {
            const wasmPath = path.join(process.cwd(), 'node_modules', 'node-unrar-js', 'esm', 'js', 'unrar.wasm');
            if (fs.existsSync(wasmPath)) {
                const wasmBuf = fs.readFileSync(wasmPath);
                options.wasmBinary = new Uint8Array(wasmBuf).buffer;
            }
        } catch(e) {}

        let extractor = await createExtractorFromFile(options);
        
        const list = extractor.getFileList();
        const headersArray = Array.from((list.fileHeaders as any) || []);
        
        const normalizedPageName = pageName.replace(/\\/g, '/');
        const targetHeader = headersArray.find((h: any) => h.name.replace(/\\/g, '/') === normalizedPageName);

        if (!targetHeader) return new NextResponse("Page Not Found in RAR", { status: 404 });

        // Reset pointer stream by re-initializing before extracting the single matched file
        extractor = await createExtractorFromFile(options);
        const extracted = extractor.extract({ files: [targetHeader.name] });
        
        let fileData = extracted.files[0]?.extraction;

        if (!fileData) {
            extractor = await createExtractorFromFile(options);
            const fullExtraction = extractor.extract();
            const matchedFile = fullExtraction.files.find((f: any) => f.fileHeader.name === targetHeader.name);
            fileData = matchedFile?.extraction;
        }
        
        if (!fileData) return new NextResponse("Extraction Failed", { status: 404 });
        
        buffer = Buffer.from(fileData);
    }

    if (!buffer) return new NextResponse("Page Not Found", { status: 404 });

    let finalBuffer = buffer;
    let contentType = 'image/jpeg';

    try {
        finalBuffer = await sharp(buffer)
            .resize({ width: 1600, withoutEnlargement: true }) 
            .webp({ quality: 80 })
            .toBuffer();
        contentType = 'image/webp';
    } catch (imgErr) {
        console.error("Sharp processing failed, serving original", imgErr);
        if (pageName.toLowerCase().endsWith('.png')) contentType = 'image/png';
        if (pageName.toLowerCase().endsWith('.webp')) contentType = 'image/webp';
    }

    return new NextResponse(finalBuffer, {
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