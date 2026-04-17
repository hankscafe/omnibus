// src/lib/converter.ts
import fs from 'fs-extra';
import path from 'path';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { Logger } from '@/lib/logger';
import { prisma } from '@/lib/db';
import crypto from 'crypto';

// @ts-ignore
import { createExtractorFromFile } from 'node-unrar-js/esm';
import { getErrorMessage } from './utils/error';

export async function convertCbrToCbz(cbrPath: string): Promise<string | null> {
    if (!cbrPath || !cbrPath.toLowerCase().match(/\.(cbr|rar)$/)) return null;

    const cbzPath = cbrPath.replace(/\.(cbr|rar)$/i, '.cbz');
    
    const baseTempDir = process.env.OMNIBUS_CACHE_DIR || '/cache';
    const tempDir = path.join(baseTempDir, `cbr_${crypto.randomBytes(8).toString('hex')}`);

    try {
        await fs.ensureDir(tempDir);
        Logger.log(`[Converter] Starting conversion for: ${path.basename(cbrPath)}`, 'info');

        // --- Fetch WEBP Conversion Settings ---
        const settings = await prisma.systemSetting.findMany({
            where: { key: { in: ['convert_to_webp', 'webp_quality'] } }
        });
        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
        const convertToWebp = config.convert_to_webp === 'true';
        const webpQuality = parseInt(config.webp_quality || '80', 10);

        const options: any = { 
            filepath: cbrPath,
            targetPath: tempDir 
        };
        
        const wasmPath = path.join(process.cwd(), 'node_modules', 'node-unrar-js', 'esm', 'js', 'unrar.wasm');
        if (fs.existsSync(wasmPath)) {
            const wasmBuf = fs.readFileSync(wasmPath);
            options.wasmBinary = wasmBuf.buffer.slice(wasmBuf.byteOffset, wasmBuf.byteOffset + wasmBuf.byteLength);
        }

        const extractor = await createExtractorFromFile(options);
        const extracted = extractor.extract(); 
        Array.from((extracted.files as any) || []);

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

        allImages.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

        const zip = new AdmZip();
        let imageCount = 1;

        // --- NEW: WEBP Conversion Logic ---
        for (const imgPath of allImages) {
            const imgExt = path.extname(imgPath);
            
            if (convertToWebp && imgExt.toLowerCase() !== '.webp' && imgExt.toLowerCase() !== '.gif') {
                try {
                    const webpBuffer = await sharp(imgPath)
                        .webp({ quality: webpQuality, effort: 4 })
                        .toBuffer();
                    
                    const newName = `page_${imageCount.toString().padStart(4, '0')}.webp`;
                    zip.addFile(newName, webpBuffer);
                } catch (err) {
                    Logger.log(`[Converter] WEBP conversion failed for ${path.basename(imgPath)}, falling back to original.`, 'warn');
                    const newName = `page_${imageCount.toString().padStart(4, '0')}${imgExt}`;
                    zip.addLocalFile(imgPath, "", newName);
                }
            } else {
                const newName = `page_${imageCount.toString().padStart(4, '0')}${imgExt}`;
                zip.addLocalFile(imgPath, "", newName);
            }
            imageCount++;
        }

        zip.writeZip(cbzPath);

        if (fs.existsSync(cbrPath)) {
            await fs.remove(cbrPath);
        }

        const existingIssue = await prisma.issue.findFirst({ where: { filePath: cbrPath } });
        if (existingIssue) {
            await prisma.issue.update({
                where: { id: existingIssue.id },
                data: { filePath: cbzPath }
            });
        }

        Logger.log(`[Converter] Success: Flattened ${imageCount - 1} pages into ${path.basename(cbzPath)}`, 'success');
        return cbzPath;

    } catch (error: unknown) {
        Logger.log(`[Converter] Failed to convert ${path.basename(cbrPath)}: ${getErrorMessage(error)}`, 'error');
        return null;
    } finally {
        if (fs.existsSync(tempDir)) {
            await fs.remove(tempDir).catch(() => {});
        }
    }
}

export async function repackArchive(filePath: string): Promise<boolean> {
    if (!filePath || !fs.existsSync(filePath)) return false;

    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.cbr' || ext === '.rar') {
        const newPath = await convertCbrToCbz(filePath);
        return !!newPath;
    }

    if (ext !== '.cbz' && ext !== '.zip') return false;

    const baseTempDir = process.env.OMNIBUS_CACHE_DIR || '/cache';
    const tempDir = path.join(baseTempDir, `repack_${crypto.randomBytes(8).toString('hex')}`);

    try {
        await fs.ensureDir(tempDir);
        Logger.log(`[Repacker] Starting internal repack for: ${path.basename(filePath)}`, 'info');

        // --- Fetch WEBP Conversion Settings ---
        const settings = await prisma.systemSetting.findMany({
            where: { key: { in: ['convert_to_webp', 'webp_quality'] } }
        });
        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
        const convertToWebp = config.convert_to_webp === 'true';
        const webpQuality = parseInt(config.webp_quality || '80', 10);

        const zip = new AdmZip(filePath);
        zip.extractAllTo(tempDir, true);

        const allImages: string[] = [];

        async function findImages(currentDir: string) {
            const items = await fs.readdir(currentDir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(currentDir, item.name);
                if (item.isDirectory()) {
                    await findImages(fullPath);
                } else if (item.name.match(/\.(jpg|jpeg|png|webp|gif|bmp)$/i) && !item.name.toLowerCase().includes('__macosx')) {
                    allImages.push(fullPath);
                }
            }
        }

        await findImages(tempDir);

        if (allImages.length === 0) {
            throw new Error("Archive contained no valid images after extraction.");
        }

        allImages.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

        const newZip = new AdmZip();
        let imageCount = 1;

        // --- NEW: WEBP Conversion Logic ---
        for (const imgPath of allImages) {
            const imgExt = path.extname(imgPath);
            
            if (convertToWebp && imgExt.toLowerCase() !== '.webp' && imgExt.toLowerCase() !== '.gif') {
                try {
                    const webpBuffer = await sharp(imgPath)
                        .webp({ quality: webpQuality, effort: 4 })
                        .toBuffer();
                    
                    const newName = `page_${imageCount.toString().padStart(4, '0')}.webp`;
                    newZip.addFile(newName, webpBuffer);
                } catch (err) {
                    Logger.log(`[Repacker] WEBP conversion failed for ${path.basename(imgPath)}, falling back.`, 'warn');
                    const newName = `page_${imageCount.toString().padStart(4, '0')}${imgExt}`;
                    newZip.addLocalFile(imgPath, "", newName);
                }
            } else {
                const newName = `page_${imageCount.toString().padStart(4, '0')}${imgExt}`;
                newZip.addLocalFile(imgPath, "", newName);
            }
            imageCount++;
        }

        const comicInfoPath = path.join(tempDir, 'ComicInfo.xml');
        if (fs.existsSync(comicInfoPath)) {
            newZip.addLocalFile(comicInfoPath, "", "ComicInfo.xml");
        }

        const tmpOut = `${filePath}.tmp`;
        newZip.writeZip(tmpOut);
        await fs.move(tmpOut, filePath, { overwrite: true });

        Logger.log(`[Repacker] Success: Flattened and repacked ${imageCount - 1} pages in ${path.basename(filePath)}`, 'success');
        return true;

    } catch (error: unknown) {
        Logger.log(`[Repacker] Failed to repack ${path.basename(filePath)}: ${getErrorMessage(error)}`, 'error');
        return false;
    } finally {
        if (fs.existsSync(tempDir)) {
            await fs.remove(tempDir).catch(() => {});
        }
    }
}