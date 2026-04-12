// src/lib/hosters/rootz.ts
import axios from 'axios';
import * as cheerio from 'cheerio';

export async function resolveRootz(url: string, account?: any) {
    try {
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...(account?.apiKey ? { 'Cookie': `session=${account.apiKey}` } : {})
            },
            timeout: 15000
        });

        const $ = cheerio.load(res.data);
        let directUrl: string | null = null;

        // Try to find standard download links
        $('a').each((_, el) => {
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
                    return false; // Break loop
                }
            }
        });

        if (directUrl) {
            return { success: true, directUrl };
        }

        return { success: false, error: 'Could not locate direct download button on Rootz page.' };
    } catch (error: any) {
        return { success: false, error: `Rootz Scrape Error: ${error.message}` };
    }
}