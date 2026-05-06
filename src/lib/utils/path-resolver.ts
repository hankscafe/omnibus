// src/lib/utils/path-resolver.ts
import { prisma } from '@/lib/db';
import path from 'path';
import { Logger } from '../logger';
import { getErrorMessage } from './error';

/**
 * Automatically translates a path from a Download Client to a Local Path
 * based on the "Remote Path Mapping" settings in the database.
 */
export async function resolveRemotePath(remotePath: string): Promise<string> {
  try {
    Logger.log(`[Path Resolver Debug] Attempting to resolve remote path: ${remotePath}`, 'debug');

    // 1. Fetch current settings from DB
    const settings = await prisma.systemSetting.findUnique({ 
      where: { key: 'remote_path_mappings' } 
    });

    if (!settings?.value) {
        Logger.log(`[Path Resolver Debug] No mapping rules found in DB. Returning original path.`, 'debug');
        return remotePath;
    }

    // 2. Parse Mappings
    let mappings: any[] = [];
    try {
      mappings = JSON.parse(settings.value);
    } catch (e) {
      Logger.log(`[Path Resolver Debug] Failed to parse mapping JSON. Returning original path.`, 'debug');
      return remotePath;
    }

    if (!Array.isArray(mappings) || mappings.length === 0) return remotePath;

    Logger.log(`[Path Resolver Debug] Loaded ${mappings.length} mapping rules.`, 'debug');

    // 3. Normalize Input Path (forward slashes for matching)
    const normalizedInput = remotePath.replace(/\\/g, '/');

    for (const mapping of mappings) {
      if (!mapping.remote || !mapping.local) continue;

      // Normalize mapping paths
      const normalizedRemote = mapping.remote.replace(/\\/g, '/').replace(/\/$/, '');
      const normalizedLocal = mapping.local.replace(/\\/g, '/').replace(/\/$/, '');

      Logger.log(`[Path Resolver Debug] Evaluating Rule: Remote "${normalizedRemote}" -> Local "${normalizedLocal}" against input "${normalizedInput}"`, 'debug');

      // 4. Perform "Search and Replace"
      if (normalizedInput.startsWith(normalizedRemote)) {
        const resolved = normalizedInput.replace(normalizedRemote, normalizedLocal);
        
        // 5. Final Pass: Use path.normalize to match the Host OS (\ for Windows, / for Linux)
        const finalPath = path.normalize(resolved);
        Logger.log(`[Path Resolver Debug] MATCH FOUND! Translated path to: ${finalPath}`, 'debug');
        return finalPath;
      }
    }

    Logger.log(`[Path Resolver Debug] No rules matched. Returning original path.`, 'debug');
    return remotePath;

  } catch (error) {
    Logger.log(`[Path Resolver] Error: ${getErrorMessage(error)}`, 'error');
    return remotePath;
  }
}