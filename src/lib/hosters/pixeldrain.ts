// src/lib/hosters/pixeldrain.ts
import axios from 'axios';
import { Logger } from '../logger';

export async function resolvePixeldrain(url: string, account?: any) {
    try {
        // A standard Pixeldrain URL looks like: https://pixeldrain.com/u/FILE_ID
        const fileIdMatch = url.match(/\/u\/([a-zA-Z0-9]+)/);
        if (!fileIdMatch) {
            return { success: false, error: "Invalid Pixeldrain URL format." };
        }

        const fileId = fileIdMatch[1];
        
        // Pixeldrain's direct download API endpoint
        const directUrl = `https://pixeldrain.com/api/file/${fileId}`;

        // If the user provided an API key in settings, we inject it via Basic Auth
        const headers: any = {
            'User-Agent': 'Omnibus/1.0'
        };

        if (account?.apiKey) {
            const auth = Buffer.from(`:${account.apiKey}`).toString('base64');
            headers['Authorization'] = `Basic ${auth}`;
            Logger.log(`[Pixeldrain] Using premium API key for file ${fileId}`, 'info');
        }

        // Do a quick HEAD request to ensure the file is still alive and we aren't blocked
        const check = await axios.head(directUrl, { headers, timeout: 10000 });
        
        if (check.status === 200) {
            return { 
                success: true, 
                directUrl,
                headers: account?.apiKey ? { 'Authorization': headers['Authorization'] } : undefined 
            };
        }

        return { success: false, error: 'File not accessible on Pixeldrain.' };
    } catch (error: any) {
        if (error.response?.status === 429) {
            return { success: false, error: 'Pixeldrain bandwidth limit exceeded. Please add an API Key in Settings.' };
        }
        return { success: false, error: `Pixeldrain Error: ${error.message}` };
    }
}