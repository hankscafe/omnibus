// src/lib/hosters/rootz.ts
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Logger } from '../logger';

export async function resolveRootz(url: string, account?: any) {
    try {
        Logger.log(`[Rootz Debug] Fetching HTML for: ${url}`, 'debug');
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
        Logger.log(`[Rootz Debug] HTML fetched. Evaluating ${anchors.length} anchor tags...`, 'debug');

        // Try to find standard download links
        anchors.each((_, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().toLowerCase();
            const id = $(el).attr('id')?.toLowerCase() || "";
            const cls = $(el).attr('class')?.toLowerCase() || "";

            if (href && href.startsWith('http')) {
                if (href.match(/\.(cbz|cbr|zip|rar)$/i) || 
                    text.includes('download') || 
                    id.includes('download') || 
                    cls.includes('download')) {
                    directUrl = href;
                    Logger.log(`[Rootz Debug] Match found! Tag text: "${text}", Href: ${href.substring(0, 50)}...`, 'debug');
                    return false; // Break loop
                }
            }
        });

        if (directUrl) {
            return { success: true, directUrl };
        }

        Logger.log(`[Rootz Debug] Evaluation complete. No valid download links found.`, 'debug');
        return { success: false, error: 'Could not locate direct download button on Rootz page.' };
    } catch (error: any) {
        Logger.log(`[Rootz Debug] Request failed: ${error.message}`, 'debug');
        return { success: false, error: `Rootz Scrape Error: ${error.message}` };
    }
}