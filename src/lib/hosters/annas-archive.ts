import axios from 'axios';
import { Logger } from '../logger';

export async function resolveAnnasArchive(url: string, account?: any) {
    try {
        // Anna's Archive URLs usually look like: https://annas-archive.org/md5/239847239847239847239847
        const md5Match = url.match(/\/md5\/([a-zA-Z0-9]+)/i);
        if (!md5Match) {
            return { success: false, error: "Invalid Anna's Archive URL format. Missing MD5." };
        }

        const md5 = md5Match[1];

        // If the user has a premium API key configured in the Hosters tab
        if (account?.apiKey) {
            Logger.log(`[Anna's Archive] Using premium API key for fast download of ${md5}`, 'info');
            
            // Call the fast download API
            const apiRes = await axios.get(`https://annas-archive.org/api/fast_download`, {
                headers: { 'User-Agent': 'Omnibus/1.0' },
                params: {
                    key: account.apiKey,
                    md5: md5
                },
                timeout: 15000
            });

            // The API returns { "download_url": "..." }
            if (apiRes.data && apiRes.data.download_url) {
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
        return { 
            success: false, 
            error: "Anna's Archive requires a Premium API Key for automated downloads. Please configure one in Settings -> File Hosters." 
        };

    } catch (error: any) {
        return { success: false, error: `Anna's Archive Error: ${error.message}` };
    }
}