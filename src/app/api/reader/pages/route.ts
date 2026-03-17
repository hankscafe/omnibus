import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { prisma } from '@/lib/db'; // Added prisma import

// @ts-ignore
import { createExtractorFromFile } from 'node-unrar-js/esm';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');

  if (!filePath || !fs.existsSync(filePath)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  try {
    // --- PATH TRAVERSAL FIX: Authorize against known libraries ---
    const libraries = await prisma.library.findMany();
    const authorizedRoots = libraries.map(l => path.normalize(l.path).toLowerCase());
    const targetPath = path.normalize(filePath).toLowerCase();

    const isAuthorized = authorizedRoots.some(root => targetPath.startsWith(root));

    if (!isAuthorized) {
      return NextResponse.json({ error: "Unauthorized path access" }, { status: 403 });
    }
    // -------------------------------------------------------------

    // OPTIMIZATION: Read only the first 4 bytes into memory to detect file type!
    const fd = await fs.promises.open(filePath, 'r');
    const magicBuffer = Buffer.alloc(4);
    await fd.read(magicBuffer, 0, 4, 0);
    await fd.close();

    const isZipSignature = magicBuffer[0] === 0x50 && magicBuffer[1] === 0x4B;
    const isRarSignature = magicBuffer[0] === 0x52 && magicBuffer[1] === 0x61 && magicBuffer[2] === 0x72 && magicBuffer[3] === 0x21;

    const isZip = isZipSignature || (filePath.toLowerCase().match(/\.(cbz|epub|zip)$/) && !isRarSignature);
    const isRar = isRarSignature || (filePath.toLowerCase().match(/\.(cbr|rar)$/) && !isZipSignature);

    if (!isZip && !isRar) {
        return NextResponse.json({ error: "Unsupported file format." }, { status: 400 });
    }

    let pages: string[] = [];

    if (isZip) {
        // Pass the PATH, not the buffer. AdmZip will lazily stream the table of contents from disk.
        const zip = new AdmZip(filePath);
        const zipEntries = zip.getEntries();

        pages = zipEntries
          .filter(entry => {
            const name = entry.entryName.toLowerCase();
            return !entry.isDirectory && !name.includes('__macosx') && 
                   (name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.webp'));
          })
          .map(entry => entry.entryName.replace(/\\/g, '/'));
          
    } else if (isRar) {
        // Pass the PATH to unrar-js so it reads in chunks from the hard drive
        let options: any = { filepath: filePath };
        
        try {
            const wasmPath = path.join(process.cwd(), 'node_modules', 'node-unrar-js', 'esm', 'js', 'unrar.wasm');
            if (fs.existsSync(wasmPath)) {
                const wasmBuf = fs.readFileSync(wasmPath);
                options.wasmBinary = new Uint8Array(wasmBuf).buffer;
            }
        } catch(e) {}

        const extractor = await createExtractorFromFile(options);
        const list = extractor.getFileList();
        
        const headersArray = Array.from((list.fileHeaders as any) || []);
        
        pages = headersArray
            .filter((header: any) => !header.flags.directory)
            .map((header: any) => header.name.replace(/\\/g, '/'))
            .filter((name: string) => {
                const lower = name.toLowerCase();
                return !lower.includes('__macosx') && (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.webp'));
            });
    }

    pages.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    return NextResponse.json({ pages });
  } catch (error: any) {
    console.error("Archive Read Error:", error);
    return NextResponse.json({ error: "Failed to read archive" }, { status: 500 });
  }
}