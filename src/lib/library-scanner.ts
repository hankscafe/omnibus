// src/lib/library-scanner.ts
import path from 'path';
import fs from 'fs-extra';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';

export const LibraryScanner = {
    async scan(specificPath?: string): Promise<boolean | null> {
        Logger.log(specificPath
            ? `[Scan] Forwarding targeted library scan for ${specificPath} to Rust Engine...`
            : "[Scan] Forwarding library scan to Rust Engine...", "info");

        try {
            // Fetch all configured libraries from PostgreSQL
            const libraries = await prisma.library.findMany();

            if (libraries.length === 0) {
                Logger.log("[Scan] No libraries configured in the database to scan.", "warn");
                return false;
            }

            // TARGETED DIRECTORY DISPATCHING (beta.024): resolve the owning library and forward a
            // single scan with specific_path — the engine crawls only that subtree and skips the
            // global ghost cleanup.
            if (specificPath) {
                let targetPath = specificPath;
                try {
                    if (!fs.statSync(specificPath).isDirectory()) targetPath = path.dirname(specificPath);
                } catch {
                    targetPath = path.dirname(specificPath);
                }
                const norm = (p: string) => path.normalize(p).toLowerCase();
                const targetLib = libraries.find(l => norm(targetPath).startsWith(norm(l.path)));
                if (!targetLib) {
                    Logger.log(`[Scan] Targeted path is not within any registered library: ${targetPath}`, "warn");
                    return false;
                }

                const rustResponse = await fetch(ENGINE_URL + '/api/scan', {
                    method: 'POST',
                    headers: engineHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        library_id: targetLib.id,
                        library_path: targetLib.path,
                        specific_path: targetPath
                    })
                });
                if (!rustResponse.ok) {
                    Logger.log(`[Scan] Rust Engine rejected targeted scan for ${targetPath} (Status: ${rustResponse.status})`, 'error');
                    return false;
                }
                return true;
            }

            // Tell Rust to scan each library
            let acceptedCount = 0;
            for (const lib of libraries) {
                Logger.log(`[Scan] Instructing Rust to scan library path: ${lib.path}`, 'info');

                try {
                    const rustResponse = await fetch(ENGINE_URL + '/api/scan', {
                        method: 'POST',
                        headers: engineHeaders({ 'Content-Type': 'application/json' }),
                        body: JSON.stringify({
                            library_id: lib.id,
                            library_path: lib.path
                        })
                    });

                    if (!rustResponse.ok) {
                        Logger.log(`[Scan] Rust Engine rejected scan for ${lib.name} (Status: ${rustResponse.status})`, 'error');
                    } else {
                        acceptedCount++;
                    }
                } catch (e) {
                    Logger.log(`[Scan] Failed to contact Rust Engine for ${lib.name}: ${getErrorMessage(e)}`, 'error');
                }
            }

            if (acceptedCount === 0) {
                Logger.log(`[Scan] Rust Engine accepted none of the ${libraries.length} scan requests.`, 'error');
                return false;
            }
            return true;
        } catch (error) {
            Logger.log(`[Scan] Error forwarding to Rust: ${getErrorMessage(error)}`, 'error');
            return false;
        }
    }
};