// src/lib/hosters/vikingfile.ts
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Logger } from '../logger';

export async function resolveVikingfile(url: string, account?: any) {
    try {
        Logger.log(`[VikingFile Debug] Fetching HTML for: ${url}`, 'debug');
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...(account?.apiKey ? { 'Cookie': `session=${account.apiKey}` } : {})
            },
            timeout: 15000
        });

        const $ = cheerio.load(res.data);
        let directUrl: string | null = null;
        const anchors = $('a');
        
        Logger.log(`[VikingFile Debug] HTML fetched. Evaluating ${anchors.length} anchor tags...`, 'debug');

        // Search for typical download links
        anchors.each((_, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().toLowerCase();

            if (href && href.startsWith('http')) {
                // VikingFile often uses direct file extensions or prominent download buttons
                if (href.match(/\.(cbz|cbr|zip|rar)$/i) || text.includes('download')) {
                    directUrl = href;
                    Logger.log(`[VikingFile Debug] Match found! Tag text: "${text}", Href: ${href.substring(0, 50)}...`, 'debug');
                    return false; // Break loop
                }
            }
        });

        if (directUrl) {
            return { success: true, directUrl };
        }

        Logger.log(`[VikingFile Debug] Evaluation complete. No valid download links found.`, 'debug');
        return { success: false, error: 'Could not locate direct download button on Vikingfile page.' };
    } catch (error: any) {
        Logger.log(`[VikingFile Debug] Request failed: ${error.message}`, 'debug');
        return { success: false, error: `Vikingfile Scrape Error: ${error.message}` };
    }
}