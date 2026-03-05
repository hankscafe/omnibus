import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';

// @ts-ignore
import { createExtractorFromData } from 'node-unrar-js/esm';

const CACHE_DIR = process.env.OMNIBUS_CACHE_DIR || path.join(process.cwd(), '.cache', 'reader');

async function cleanupOldCaches() {
    try {
        if (!fs.existsSync(CACHE_DIR)) return;
        const folders = await fs.promises.readdir(CACHE_DIR);
        const now = Date.now();
        for (const folder of folders) {
            const folderPath = path.join(CACHE_DIR, folder);
            const stats = await fs.promises.stat(folderPath);
            if (now - stats.mtimeMs > 7200000) {
                await fs.promises.rm(folderPath, { recursive: true, force: true });
            }
        }
    } catch(e) {}
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');

  if (!filePath || !fs.existsSync(filePath)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  // Fire-and-forget background cleanup
  cleanupOldCaches();

  try {
    const fileBuffer = await fs.promises.readFile(filePath);

    // MAGIC NUMBER DETECTION
    const isZipSignature = fileBuffer.length > 4 && fileBuffer[0] === 0x50 && fileBuffer[1] === 0x4B;
    const isRarSignature = fileBuffer.length > 4 && fileBuffer[0] === 0x52 && fileBuffer[1] === 0x61 && fileBuffer[2] === 0x72 && fileBuffer[3] === 0x21;

    const isZip = isZipSignature || (filePath.toLowerCase().endsWith('.cbz') && !isRarSignature);
    const isRar = isRarSignature || (filePath.toLowerCase().endsWith('.cbr') && !isZipSignature);

    if (!isZip && !isRar) {
        return NextResponse.json({ error: "Unsupported file format." }, { status: 400 });
    }

    let pages: string[] = [];

    if (isZip) {
        const zip = new AdmZip(fileBuffer);
        const zipEntries = zip.getEntries();

        pages = zipEntries
          .filter(entry => {
            const name = entry.entryName.toLowerCase();
            return !entry.isDirectory && !name.includes('__macosx') && 
                   (name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.webp'));
          })
          .map(entry => entry.entryName.replace(/\\/g, '/'));
          
    } else if (isRar) {
        const fileHash = crypto.createHash('md5').update(filePath).digest('hex');
        const extractDir = path.join(CACHE_DIR, fileHash);

        // FAILSAFE: If the directory exists but is empty (poisoned cache), delete it!
        let needsExtraction = true;
        if (fs.existsSync(extractDir)) {
            const existingFiles = fs.readdirSync(extractDir);
            if (existingFiles.length === 0) {
                await fs.promises.rm(extractDir, { recursive: true, force: true });
            } else {
                needsExtraction = false; // We have a healthy cache
            }
        }

        if (needsExtraction) {
            await fs.promises.mkdir(extractDir, { recursive: true });
            
            const uint8Array = new Uint8Array(fileBuffer);
            let options: any = { data: uint8Array };
            
            try {
                const wasmPath = path.join(process.cwd(), 'node_modules', 'node-unrar-js', 'esm', 'js', 'unrar.wasm');
                if (fs.existsSync(wasmPath)) {
                    const wasmBuf = fs.readFileSync(wasmPath);
                    options.wasmBinary = new Uint8Array(wasmBuf).buffer;
                }
            } catch(e) {}

            const extractor = await createExtractorFromData(options);
            const extracted = extractor.extract();
            
            let extractedCount = 0;
            for (const file of extracted.files) {
                const name = (file.fileHeader.name || '').toLowerCase();
                if (!file.fileHeader.flags.directory && !name.includes('__macosx') &&
                   (name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.webp'))) {
                    
                    if (file.extraction) {
                        const safeName = file.fileHeader.name.replace(/\\/g, '/');
                        const outPath = path.join(extractDir, safeName);
                        await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
                        await fs.promises.writeFile(outPath, file.extraction);
                        extractedCount++;
                    }
                }
            }
            if (extractedCount === 0) console.warn("RAR extraction yielded 0 valid images.");
        }

        const getAllFiles = (dirPath: string, arrayOfFiles: string[] = []) => {
            if (!fs.existsSync(dirPath)) return arrayOfFiles;
            const files = fs.readdirSync(dirPath);
            files.forEach((file) => {
                const fullPath = path.join(dirPath, file);
                if (fs.statSync(fullPath).isDirectory()) {
                    arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
                } else {
                    const relPath = path.relative(extractDir, fullPath).replace(/\\/g, '/');
                    const lower = relPath.toLowerCase();
                    if (!lower.includes('__macosx') && (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.webp'))) {
                        arrayOfFiles.push(relPath);
                    }
                }
            });
            return arrayOfFiles;
        };

        pages = getAllFiles(extractDir);
    }

    pages.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    return NextResponse.json({ pages });
  } catch (error: any) {
    console.error("Archive Read Error:", error);
    return NextResponse.json({ error: "Failed to read archive" }, { status: 500 });
  }
}