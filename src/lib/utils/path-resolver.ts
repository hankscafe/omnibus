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
    // 1. Fetch current settings from DB
    const settings = await prisma.systemSetting.findUnique({ 
      where: { key: 'remote_path_mappings' } 
    });

    if (!settings?.value) return remotePath;

    // 2. Parse Mappings
    let mappings: any[] = [];
    try {
      mappings = JSON.parse(settings.value);
    } catch (e) {
      return remotePath;
    }

    if (!Array.isArray(mappings) || mappings.length === 0) return remotePath;

    // 3. Normalize Input Path (forward slashes for matching)
    const normalizedInput = remotePath.replace(/\\/g, '/');

    for (const mapping of mappings) {
      if (!mapping.remote || !mapping.local) continue;

      // Normalize mapping paths
      const normalizedRemote = mapping.remote.replace(/\\/g, '/').replace(/\/$/, '');
      const normalizedLocal = mapping.local.replace(/\\/g, '/').replace(/\/$/, '');

      // 4. Perform "Search and Replace"
      if (normalizedInput.startsWith(normalizedRemote)) {
        const resolved = normalizedInput.replace(normalizedRemote, normalizedLocal);
        
        // 5. Final Pass: Use path.normalize to match the Host OS (\ for Windows, / for Linux)
        return path.normalize(resolved);
      }
    }

    return remotePath;

  } catch (error) {
    Logger.log(`[Path Resolver] Error: ${getErrorMessage(error)}`, 'error');

    return remotePath;
  }
}