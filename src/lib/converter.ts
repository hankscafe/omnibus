// src/lib/converter.ts
import fs from 'fs-extra';
import path from 'path';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { Logger } from '@/lib/logger';
import { prisma } from '@/lib/db';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getErrorMessage } from './utils/error';
import { CACHE_DIR } from '@/lib/utils/paths';
import { IMAGE_EXT_REGEX } from '@/lib/utils/formats';

const execFileAsync = promisify(execFile);

// Reads the leading magic bytes of a file; returns an empty buffer on any failure
async function readFileSignature(filePath: string): Promise<Buffer> {
    try {
        const fd = await fs.open(filePath, 'r');
        const buffer = Buffer.alloc(4);
        try {
            await fs.read(fd, buffer, 0, 4, 0);
        } finally {
            await fs.close(fd);
        }
        return buffer;
    } catch {
        return Buffer.alloc(0);
    }
}

export async function convertCbrToCbz(cbrPath: string): Promise<string | null> {
    if (!cbrPath || !cbrPath.toLowerCase().match(/\.(cbr|rar|cb7)$/)) return null;
    const cbzPath = cbrPath.replace(/\.(cbr|rar|cb7)$/i, '.cbz');
         
    // --- THE FIX: Safe local fallback path to /config/cache ---
    const tempDir = path.join(CACHE_DIR, `cbr_${crypto.randomBytes(8).toString('hex')}`);
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
        
        // --- NATIVE OS EXTRACTION ---
        // Official unrar is the primary decoder: unar/XADMaster corrupts some files
        // inside RAR 2.0 archives (common in vintage comic rips). unar remains the
        // fallback because it auto-detects other formats, e.g. genuine 7z archives
        // (.cb7). ZIPs in disguise are routed by magic bytes and never reach either.
        const execOpts = { maxBuffer: 10 * 1024 * 1024 };
        let expectedPages = -1;
        let unrarExitError: any = null;

        // Extensions lie: .cbr files are frequently ZIPs in disguise, and WinRAR's
        // UnRAR.exe exits 0 with an empty listing for them — so the real container
        // format, not the extension or exit code, picks the decoder.
        const signature = await readFileSignature(cbrPath);
        const isActuallyZip = signature.length >= 2 && signature[0] === 0x50 && signature[1] === 0x4B; // "PK"

        if (isActuallyZip) {
            Logger.log(`[Converter] ${path.basename(cbrPath)} is a ZIP in disguise — extracting natively`, 'info');
            new AdmZip(cbrPath).extractAllTo(tempDir, true);
        } else {
            let rarListing: string | null = null;
            try {
                const { stdout } = await execFileAsync('unrar', ['lb', '-p-', cbrPath], execOpts);
                // An empty listing means "not a RAR" even on exit 0 (WinRAR's UnRAR.exe
                // succeeds silently on non-RAR input) — route it to unar instead.
                rarListing = typeof stdout === 'string' && stdout.trim() !== '' ? stdout : null;
            } catch (err: any) {
                // unrar exits non-zero for benign structural quirks (e.g. a missing
                // end-of-archive block) even when the listing printed in full, so
                // salvage its stdout. A genuine non-RAR file yields an empty listing.
                rarListing = typeof err?.stdout === 'string' && err.stdout.trim() !== '' ? err.stdout : null;
            }
            if (rarListing !== null) {
                expectedPages = rarListing.split('\n')
                    .filter(line => IMAGE_EXT_REGEX.test(line.trim()))
                    .length;
            }

            if (expectedPages >= 0) {
                // Vintage archives often carry benign structural quirks (e.g. a missing
                // end-of-archive block) that make unrar exit non-zero even though every
                // file extracted OK. Success is judged by comparing extracted page count
                // against the listing below, not by the exit code.
                try {
                    await execFileAsync('unrar', ['x', '-y', '-o+', '-p-', '-idq', cbrPath, `${tempDir}/`], execOpts);
                } catch (err: any) {
                    unrarExitError = err;
                }
            } else {
                try {
                    await execFileAsync('unar', ['-q', '-p', '', '-o', tempDir, '-f', '-D', cbrPath], execOpts);
                } catch (unarErr: any) {
                    const detail = unarErr?.code === 'ENOENT'
                        ? 'unar binary not found on PATH (is it installed in this environment?)'
                        : unarErr?.stderr || unarErr?.message || 'Unknown CLI error';
                    throw new Error(`Native extraction failed: ${detail}`);
                }
            }
        }
        // ----------------------------
        
        const allImages: string[] = [];
        
        async function findImages(currentDir: string) {
            const items = await fs.readdir(currentDir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(currentDir, item.name);
                if (item.isDirectory()) {
                    await findImages(fullPath);
                } else if (IMAGE_EXT_REGEX.test(item.name)) {
                    allImages.push(fullPath);
                }
            }
        }
        await findImages(tempDir);
        Logger.log(`[Converter Debug] Found ${allImages.length} images inside CBR archive: ${path.basename(cbrPath)}`, 'debug');

        if (expectedPages >= 0 && allImages.length < expectedPages) {
            const detail = unrarExitError?.stderr || unrarExitError?.message || 'archive may be damaged';
            throw new Error(`Native extraction failed: only ${allImages.length} of ${expectedPages} pages extracted (${detail})`);
        }
        
        if (allImages.length === 0) {
            throw new Error("Archive contained no valid images after extraction.");
        }
        
        allImages.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
        const zip = new AdmZip();
        let imageCount = 1;
        
        // --- WEBP Conversion Logic ---
        for (const imgPath of allImages) {
            const imgExt = path.extname(imgPath);
                         
            if (convertToWebp && imgExt.toLowerCase() !== '.webp' && imgExt.toLowerCase() !== '.gif') {
                try {
                    Logger.log(`[Converter Debug] Converting ${path.basename(imgPath)} to WEBP at ${webpQuality}% quality...`, 'debug');
                    const newName = `page_${imageCount.toString().padStart(4, '0')}.webp`;
                    const tempWebpPath = path.join(tempDir, newName);
                                         
                    // Write to physical disk instead of memory buffer to prevent OOM
                    await sharp(imgPath)
                        .webp({ quality: webpQuality, effort: 4 })
                        .toFile(tempWebpPath);
                                         
                    zip.addLocalFile(tempWebpPath, "", newName);
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
        
        const comicInfoPath = path.join(tempDir, 'ComicInfo.xml');
        if (fs.existsSync(comicInfoPath)) {
            zip.addLocalFile(comicInfoPath, "", "ComicInfo.xml");
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
    
    if (ext === '.cbr' || ext === '.rar' || ext === '.cb7') {
        const newPath = await convertCbrToCbz(filePath);
        return !!newPath;
    }
    
    if (ext !== '.cbz' && ext !== '.zip') return false;
    
    const tempDir = path.join(CACHE_DIR, `repack_${crypto.randomBytes(8).toString('hex')}`);
    
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
                } else if (IMAGE_EXT_REGEX.test(item.name) && !item.name.toLowerCase().includes('__macosx')) {
                    allImages.push(fullPath);
                }
            }
        }
        await findImages(tempDir);
        Logger.log(`[Repacker Debug] Found ${allImages.length} raw images inside archive. Initializing sequential repack...`, 'debug');
        
        if (allImages.length === 0) {
            throw new Error("Archive contained no valid images after extraction.");
        }
        
        allImages.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
        const newZip = new AdmZip();
        let imageCount = 1;
        
        // --- WEBP Conversion Logic ---
        for (const imgPath of allImages) {
            const imgExt = path.extname(imgPath);
                         
            if (convertToWebp && imgExt.toLowerCase() !== '.webp' && imgExt.toLowerCase() !== '.gif') {
                try {
                    const newName = `page_${imageCount.toString().padStart(4, '0')}.webp`;
                    const tempWebpPath = path.join(tempDir, newName);
                    
                    // Write to physical disk instead of memory buffer to prevent OOM
                    await sharp(imgPath)
                        .webp({ quality: webpQuality, effort: 4 })
                        .toFile(tempWebpPath);
                                         
                    newZip.addLocalFile(tempWebpPath, "", newName);
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