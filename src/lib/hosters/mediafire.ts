// src/lib/hosters/mediafire.ts
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Logger } from '../logger';

export async function resolveMediaFire(url: string, account?: any) {
    try {
        Logger.log(`[MediaFire Debug] Fetching HTML for: ${url}`, 'debug');
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...(account?.apiKey ? { 'Cookie': `session=${account.apiKey}` } : {})
            },
            timeout: 15000
        });

        Logger.log(`[MediaFire Debug] HTML fetched successfully. Parsing with Cheerio...`, 'debug');
        const $ = cheerio.load(res.data);
        
        // MediaFire's direct download link is usually wrapped in an anchor tag with the id 'downloadButton'
        const directUrl = $('#downloadButton').attr('href');

        if (directUrl && directUrl.startsWith('http')) {
            Logger.log(`[MediaFire Debug] Found direct URL: ${directUrl.substring(0, 50)}...`, 'debug');
            return { success: true, directUrl };
        }

        Logger.log(`[MediaFire Debug] Failed to find #downloadButton with a valid href.`, 'debug');
        return { success: false, error: 'Could not locate direct download button on MediaFire page.' };
    } catch (error: any) {
        Logger.log(`[MediaFire Debug] Request failed: ${error.message}`, 'debug');
        return { success: false, error: `MediaFire Scrape Error: ${error.message}` };
    }
}