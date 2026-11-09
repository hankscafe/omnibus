// src/lib/utils/archive-signature.ts
//
// An archive whose extension lies about its format (a ZIP named .cbr, a RAR named .cbz) is renamed
// to the extension its first bytes say it is. Moved out of importer.ts so it can be tested against
// real files.
import fs from 'fs-extra';
import path from 'path';
import { Logger } from '@/lib/logger';
import { resolveUniquePathSync } from '@/lib/utils/unique-path';
import { getErrorMessage } from '@/lib/utils/error';

export function fixMagicNumberSync(filePath: string): string {
    try {
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return filePath;
        const buffer = Buffer.alloc(4);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buffer, 0, 4, 0);
        fs.closeSync(fd);
        const hex = buffer.toString('hex').toLowerCase();

        const currentExt = path.extname(filePath).toLowerCase();
        let trueExt = currentExt;

        if (hex === '52617221') {
            trueExt = '.cbr';
        } else if (hex === '504b0304') {
            trueExt = '.cbz';
        }

        if (trueExt !== currentExt && ((currentExt === '.cbz' || currentExt === '.zip') && trueExt === '.cbr' || (currentExt === '.cbr' || currentExt === '.rar') && trueExt === '.cbz')) {
            Logger.log(`[Importer] Detected fake extension (${currentExt} -> ${trueExt}) on destination file! Renaming to match true signature...`, 'info');
            // Never over a file that already has the corrected name ("X.cbr" that is really a ZIP,
            // beside a real "X.cbz"): rename alone replaces it. Same "(copy N)" rule as the uploads.
            const correctedName = path.basename(filePath).replace(/\.[^/.]+$/, trueExt);
            const correctedPath = resolveUniquePathSync(path.dirname(filePath), correctedName);
            fs.renameSync(filePath, correctedPath);
            return correctedPath;
        }
    } catch (e) {
        Logger.log(`[Importer Debug] Failed to verify file signature for ${filePath}: ${getErrorMessage(e)}`, 'warn');
    }
    return filePath;
}
