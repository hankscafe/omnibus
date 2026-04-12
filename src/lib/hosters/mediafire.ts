// src/lib/hosters/mediafire.ts
import axios from 'axios';
import * as cheerio from 'cheerio';

export async function resolveMediaFire(url: string, account?: any) {
    try {
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...(account?.apiKey ? { 'Cookie': `session=${account.apiKey}` } : {})
            },
            timeout: 15000
        });

        const $ = cheerio.load(res.data);
        
        // MediaFire's direct download link is usually wrapped in an anchor tag with the id 'downloadButton'
        const directUrl = $('#downloadButton').attr('href');

        if (directUrl && directUrl.startsWith('http')) {
            return { success: true, directUrl };
        }

        return { success: false, error: 'Could not locate direct download button on MediaFire page.' };
    } catch (error: any) {
        return { success: false, error: `MediaFire Scrape Error: ${error.message}` };
    }
}