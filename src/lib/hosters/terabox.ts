// src/lib/hosters/terabox.ts
import axios from 'axios';
import * as cheerio from 'cheerio';

export async function resolveTerabox(url: string, account?: any) {
    try {
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...(account?.apiKey ? { 'Cookie': `ndus=${account.apiKey}` } : {}) // Terabox often uses 'ndus' for auth
            },
            timeout: 15000
        });

        const $ = cheerio.load(res.data);
        let directUrl: string | null = null;

        // Terabox heavily relies on JavaScript, so standard scraping rarely works.
        // We'll look for any obvious fallback links, but typically this requires an API key/cookie.
        $('a').each((_, el) => {
            const href = $(el).attr('href');
            if (href && href.match(/\.(cbz|cbr|zip|rar)$/i)) {
                directUrl = href;
                return false;
            }
        });

        if (directUrl) {
            return { success: true, directUrl };
        }

        return { 
            success: false, 
            error: 'Terabox requires heavy JavaScript rendering. Consider entering a premium session cookie (ndus) in Settings, or use a different hoster.' 
        };
    } catch (error: any) {
        return { success: false, error: `Terabox Scrape Error: ${error.message}` };
    }
}