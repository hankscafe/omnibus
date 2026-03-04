// src/lib/getcomics.ts
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Logger } from './logger';

export const GetComicsService = {
  async search(query: string) {
    const noYearQuery = query.replace(/\s\d{4}$/, '').trim();
    const noIssueQuery = noYearQuery.replace(/\s#?\d+(?:\.\d+)?$/, '').trim();
    
    const searches = [
        query,
        query.replace(/[:\-\&]/g, ' ').replace(/\s+/g, ' ').trim(),
        noYearQuery,
        noYearQuery.replace(/[:\-\&]/g, ' ').replace(/\s+/g, ' ').trim(),
        noIssueQuery, 
        noIssueQuery.replace(/[:\-\&]/g, ' ').replace(/\s+/g, ' ').trim() 
    ];
    
    const uniqueSearches = [...new Set(searches)].filter(s => s.length > 0);
    
    for (const q of uniqueSearches) {
        let retries = 3;
        while (retries > 0) {
            try {
                const results = await this.performSearch(q);
                if (results.length > 0) return results;
                break; 
            } catch (e: any) { 
                if (e.response && e.response.status >= 500) {
                    Logger.log(`[GetComics] Server error (${e.response.status}). Retrying in 5s...`, 'info');
                    retries--;
                    if (retries === 0) break;
                    await new Promise(r => setTimeout(r, 5000));
                } else {
                    break;
                }
            }
        }
        await new Promise(r => setTimeout(r, 1000)); 
    }
    return [];
  },

  async performSearch(safeQuery: string) {
    const url = `https://getcomics.org/?s=${encodeURIComponent(safeQuery)}`;
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000
    });

    const $ = cheerio.load(data);
    const results: any[] = [];

    // Keep all words to allow strict matching
    const queryWords = safeQuery.toLowerCase().split(' ').filter(w => w.trim().length > 0);

    $('article.post').each((i, el) => {
      const title = $(el).find('h1.post-title a').text().trim();
      const link = $(el).find('h1.post-title a').attr('href');
      
      const titleLower = title.toLowerCase();
      let isRelevant = true;

      for (let w of queryWords) {
          // STRICT NUMERIC MATCHING (Prevents "2" from matching "2026")
          if (/^\d+$/.test(w) || w.startsWith('#')) {
              const num = parseInt(w.replace('#', ''));
              const numRegex = new RegExp(`(?:#|\\bissue\\s*|\\bvol(?:ume)?\\s*|\\b0*)${num}\\b`, 'i');
              if (!numRegex.test(titleLower)) {
                  isRelevant = false;
                  break;
              }
          } else {
              // STRICT WORD BOUNDARY MATCHING
              const cleanW = w.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
              const wordRegex = new RegExp(`\\b${cleanW}\\b`, 'i');
              if (!wordRegex.test(titleLower)) {
                  isRelevant = false;
                  break;
              }
          }
      }

      if (title && link && isRelevant) {
        results.push({
          title, downloadUrl: link, size: 'Unknown', age: 'N/A', indexer: 'GetComics', protocol: 'ddl'
        });
      }
    });

    // THE FIX: Sort results by title length (shortest first). 
    // "Rogue #2" (9 chars) will easily beat "Star Wars Rogue Agents #2" (24 chars)
    results.sort((a, b) => a.title.length - b.title.length);

    return results;
  },

  async scrapeDeepLink(articleUrl: string): Promise<{ url: string, isDirect: boolean }> {
      try {
          const { data } = await axios.get(articleUrl, { 
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } 
          });
          const $ = cheerio.load(data);

          let bestLink: string | null = null;
          let isDirect = false;

          const decodeLink = (rawHref: string): string | null => {
            if (!rawHref) return null;
            if (rawHref.includes('go.php-url=')) {
                try {
                    const encoded = rawHref.split('go.php-url=')[1];
                    return Buffer.from(encoded, 'base64').toString('utf-8');
                } catch (e) { return null; }
            }
            return rawHref; 
          };

          $('a').each((i, el) => {
              const text = $(el).text().toLowerCase();
              const titleAttr = ($(el).attr('title') || "").toLowerCase();
              const href = $(el).attr('href') || "";
              
              if (!href.includes('go.php') && !text.includes('download') && !titleAttr.includes('download')) {
                  return; 
              }

              const decoded = decodeLink(href);
              if (!decoded) return;

              const isMainServer = 
                  text.includes('main server') || titleAttr.includes('main server') || 
                  text.includes('download now') || titleAttr.includes('download now') ||
                  text.includes('direct download');
              
              const isThirdParty = decoded.includes('mediafire.com') || decoded.includes('mega.nz') || decoded.includes('zippyshare.com') || decoded.includes('userscloud.com');

              if ((isMainServer || decoded.match(/\.(cbz|cbr|zip)$/i)) && !isThirdParty) {
                  bestLink = decoded;
                  isDirect = true;
                  return false; 
              } 
              else if (!bestLink) {
                  bestLink = decoded;
                  isDirect = !isThirdParty; 
              }
          });

          if (bestLink) return { url: bestLink, isDirect };
          return { url: articleUrl, isDirect: false };

      } catch (error: any) {
          return { url: articleUrl, isDirect: false };
      }
  }
};