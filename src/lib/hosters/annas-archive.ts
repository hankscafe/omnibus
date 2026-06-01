// src/lib/hosters/annas-archive.ts
import axios from 'axios';
import { Logger } from '../logger';

export async function resolveAnnasArchive(url: string, account?: any) {
    try {
        Logger.log(`[Anna's Archive Debug] Evaluating URL: ${url}`, 'debug');

        // Anna's Archive URLs usually look like: https://annas-archive.org/md5/239847239847239847239847
        const md5Match = url.match(/\/md5\/([a-zA-Z0-9]+)/i);
        if (!md5Match) {
            Logger.log(`[Anna's Archive Debug] Failed to extract MD5 hash from URL.`, 'debug');
            return { success: false, error: "Invalid Anna's Archive URL format. Missing MD5." };
        }

        const md5 = md5Match[1];
        Logger.log(`[Anna's Archive Debug] Successfully extracted MD5: ${md5}`, 'debug');

        // If the user has a premium API key configured in the Hosters tab
        if (account?.apiKey) {
            Logger.log(`[Anna's Archive] Using premium API key for fast download of ${md5}`, 'info');
            Logger.log(`[Anna's Archive Debug] Calling fast_download API endpoint...`, 'debug');
            
            // Call the fast download API
            const apiRes = await axios.get(`https://annas-archive.org/api/fast_download`, {
                headers: { 'User-Agent': 'Omnibus/1.0' },
                params: {
                    key: account.apiKey,
                    md5: md5
                },
                timeout: 15000
            });

            Logger.log(`[Anna's Archive Debug] API responded with status: ${apiRes.status}`, 'debug');

            // The API returns { "download_url": "..." }
            if (apiRes.data && apiRes.data.download_url) {
                Logger.log(`[Anna's Archive Debug] Fast download URL retrieved successfully.`, 'debug');
                return { 
                    success: true, 
                    directUrl: apiRes.data.download_url 
                };
            } else {
                throw new Error("API did not return a download URL. Check your API key limit.");
            }
        }

        // If no API key is provided, we return false. 
        // Omnibus will then drop the link into the MANUAL_DDL queue so the user can click it and solve the CAPTCHAs in their browser.
        Logger.log(`[Anna's Archive Debug] No Premium API Key configured. Dropping to manual resolution queue.`, 'debug');
        return { 
            success: false, 
            error: "Anna's Archive requires a Premium API Key for automated downloads. Please configure one in Settings -> File Hosters." 
        };

    } catch (error: any) {
        Logger.log(`[Anna's Archive Debug] Request failed: ${error.message}`, 'debug');
        return { success: false, error: `Anna's Archive Error: ${error.message}` };
    }
}