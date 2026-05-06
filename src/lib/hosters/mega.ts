// src/lib/hosters/mega.ts
import { File } from 'megajs';
import { Logger } from '../logger';

export async function resolveMega(url: string, account?: any) {
    try {
        Logger.log(`[Mega] Initializing decryption for: ${url}`, 'info');
        
        const node = File.fromURL(url);
        await node.loadAttributes();

        Logger.log(`[Mega Debug] Decryption successful. Node Name: "${node.name}", Is Directory: ${node.directory}`, 'debug');

        // If it's a single file, just return its node stream
        if (!node.directory) {
            return { 
                success: true, 
                isMegaStream: true,
                megaFileNode: node,
                fileName: node.name
            };
        }

        // If it's a folder, we need to search inside it for the comic archive
        let targetFile: any = null;
        let largestSize = 0;

        Logger.log(`[Mega Debug] Scanning decrypted folder contents (${node.children?.length || 0} items)...`, 'debug');

        for (const child of node.children || []) {
            if (child.directory) continue;
            
            const ext = child.name?.toLowerCase().split('.').pop();
            if (['cbz', 'cbr', 'zip', 'rar'].includes(ext || '')) {
                // FIX: Fallback to 0 if the size is undefined to satisfy TypeScript
                const childSize = child.size || 0;

                Logger.log(`[Mega Debug] Evaluated child file: "${child.name}" | Ext: .${ext} | Size: ${Math.round(childSize/1024/1024)}MB`, 'debug');
                
                // Grab the largest valid archive in the folder
                if (childSize > largestSize) {
                    largestSize = childSize;
                    targetFile = child;
                }
            }
        }

        if (!targetFile) {
            Logger.log(`[Mega Debug] Failed to find a valid comic archive in the Mega folder.`, 'debug');
            return { success: false, error: "No comic files (.cbz, .cbr) found inside the Mega folder." };
        }

        Logger.log(`[Mega] Found file inside decrypted folder: ${targetFile.name}`, 'info');
        
        return { 
            success: true, 
            isMegaStream: true,
            megaFileNode: targetFile,
            fileName: targetFile.name
        };

    } catch (error: any) {
        return { success: false, error: `Mega Error: ${error.message}` };
    }
}