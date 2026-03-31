// src/lib/converter.ts
import fs from 'fs-extra';
import path from 'path';
import AdmZip from 'adm-zip';
import { Logger } from '@/lib/logger';
import { prisma } from '@/lib/db';
import crypto from 'crypto';

// @ts-ignore
import { createExtractorFromFile } from 'node-unrar-js/esm';
import { getErrorMessage } from './utils/error';

export async function convertCbrToCbz(cbrPath: string): Promise<string | null> {
    if (!cbrPath || !cbrPath.toLowerCase().match(/\.(cbr|rar)$/)) return null;

    const cbzPath = cbrPath.replace(/\.(cbr|rar)$/i, '.cbz');
    
    // --- FIX: Defaults to /cache to align with standard Docker setups ---
    const baseTempDir = process.env.CACHE_DIR || '/cache';
    const tempDir = path.join(baseTempDir, `cbr_${crypto.randomBytes(8).toString('hex')}`);

    try {
        await fs.ensureDir(tempDir);
        Logger.log(`[Converter] Starting conversion for: ${path.basename(cbrPath)}`, 'info');

        // 1. Setup WASM Extractor
        const options: any = { 
            filepath: cbrPath,
            targetPath: tempDir // Extractor will now dump files into the mapped cache volume
        };
        
        const wasmPath = path.join(process.cwd(), 'node_modules', 'node-unrar-js', 'esm', 'js', 'unrar.wasm');
        if (fs.existsSync(wasmPath)) {
            const wasmBuf = fs.readFileSync(wasmPath);
            options.wasmBinary = wasmBuf.buffer.slice(wasmBuf.byteOffset, wasmBuf.byteOffset + wasmBuf.byteLength);
        }

        const extractor = await createExtractorFromFile(options);
        
        // 2. Extract ALL files to the temp directory
        const extracted = extractor.extract(); 
        
        // Consume the generator to physically write the files to the disk
        Array.from((extracted.files as any) || []);

        // 3. Find all extracted images recursively
        const allImages: string[] = [];

        async function findImages(currentDir: string) {
            const items = await fs.readdir(currentDir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(currentDir, item.name);
                if (item.isDirectory()) {
                    await findImages(fullPath);
                } else if (item.name.match(/\.(jpg|jpeg|png|webp|gif|bmp)$/i)) {
                    allImages.push(fullPath);
                }
            }
        }

        await findImages(tempDir);

        if (allImages.length === 0) {
            throw new Error("Archive contained no valid images after extraction.");
        }

        // Sort naturally (page 1, page 2, page 10)
        allImages.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

        // 4. Create a brand new, flat CBZ
        const zip = new AdmZip();
        let imageCount = 0;

        for (const imgPath of allImages) {
            const ext = path.extname(imgPath);
            // Rename files sequentially to avoid collisions from nested folders
            const newName = `page_${imageCount.toString().padStart(4, '0')}${ext}`;
            zip.addLocalFile(imgPath, "", newName);
            imageCount++;
        }

        // 5. Save the CBZ to disk
        zip.writeZip(cbzPath);

        // 6. Delete the old CBR to save space
        if (fs.existsSync(cbrPath)) {
            await fs.remove(cbrPath);
        }

        // 7. Update the Database seamlessly if it already exists in the library
        const existingIssue = await prisma.issue.findFirst({ where: { filePath: cbrPath } });
        if (existingIssue) {
            await prisma.issue.update({
                where: { id: existingIssue.id },
                data: { filePath: cbzPath }
            });
        }

        Logger.log(`[Converter] Success: Flattened ${imageCount} pages into ${path.basename(cbzPath)}`, 'success');
        return cbzPath;

    } catch (error: unknown) {
        Logger.log(`[Converter] Failed to convert ${path.basename(cbrPath)}: ${getErrorMessage(error)}`, 'error');
        return null;
    } finally {
        // ALWAYS clean up the temporary directory to prevent bloat on the mapped volume
        if (fs.existsSync(tempDir)) {
            await fs.remove(tempDir).catch(() => {});
        }
    }
}