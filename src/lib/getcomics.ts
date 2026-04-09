import axios from 'axios';
import * as cheerio from 'cheerio';
import { Logger } from './logger';
import { getErrorMessage } from './utils/error';

export const GetComicsService = {
  async search(query: string, isInteractive: boolean = false, isManga: boolean = false) {
    const noYearQuery = query.replace(/\s\d{4}$/, '').trim();
    const noIssueQuery = noYearQuery.replace(/\s#?\d+(?:\.\d+)?$/, '').trim();
    
    const searches = [
        query,
        query.replace(/[:\-\&]/g, ' ').replace(/\s+/g, ' ').trim(),
        noYearQuery,
        noIssueQuery
    ];
    
    const uniqueSearches = [...new Set(searches)].filter(s => s.length > 0);
    
    for (const q of uniqueSearches) {
        try {
            const results = await this.performSearch(q, query, isInteractive, isManga); 
            if (results.length > 0) return results;
        } catch (e: any) { 
            Logger.log(`[GetComics] Search failed for "${q}": ${e.message}`, 'warn');
        }
    }
    return [];
  },

  async performSearch(safeQuery: string, originalQuery: string, isInteractive: boolean = false, isManga: boolean = false) {
    const url = `https://getcomics.org/?s=${encodeURIComponent(safeQuery)}`;
    
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000
    });

    const $ = cheerio.load(data);
    const results: any[] = [];
    
    const cleanOriginal = originalQuery.replace(/[:\-\&]/g, ' ').replace(/\s+/g, ' ').trim();
    const queryWords = cleanOriginal.toLowerCase().split(' ').filter(w => w.trim().length > 0);

    let reqNumMatch = cleanOriginal.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v\s*\.?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
    let reqNum = reqNumMatch ? parseFloat(reqNumMatch[1]) : null;

    const reqYearMatch = cleanOriginal.match(/\b(19|20)\d{2}\b/);
    const reqYear = reqYearMatch ? reqYearMatch[1] : null;

    const stopWords = ['the', 'a', 'an', 'of', 'and', 'or', 'vol', 'volume', 'issue', 'black', 'white', 'blood'];
    const significantWords = queryWords.filter(w => !stopWords.includes(w) && w.length > 2 && w !== reqYear);

    $('article, .post').each((i, el) => {
      const titleEl = $(el).find('h1.post-title a, h2.post-title a, h1 a, h2 a, .post-header a').first();
      const title = titleEl.text().trim();
      const link = titleEl.attr('href');
      
      if (!title || !link) return;

      const titleLower = title.toLowerCase();
      let isRelevant = true;

      if (!isInteractive) {
          // 1. STRICT YEAR ANCHOR
          if (reqYear && !titleLower.includes(reqYear)) isRelevant = false;

          // 2. MANDATORY WORD INTERSECTION
          if (isRelevant) {
              for (const word of significantWords) {
                  if (!titleLower.includes(word)) {
                      isRelevant = false;
                      break;
                  }
              }
          }

          // 3. RELAXED ISSUE NUMBER MATCH
          if (isRelevant && reqNum !== null) {
              let cleanTor = titleLower.replace(/\.\w+$/, '').replace(/\[\d{4}(?:-\d{4})?\]/g, '').replace(/\(\d{4}(?:-\d{4})\)/g, '');
              const fallbacks = [...cleanTor.matchAll(/(?<=^|[^a-zA-Z0-9])0*(\d+(?:\.\d+)?)(?=[^a-zA-Z0-9]|$)/g)];
              let torNum = fallbacks.length > 0 ? parseFloat(fallbacks[fallbacks.length - 1][1]) : null;
              
              // Only reject if it's the WRONG number. If no number is listed, assume it's a valid series post.
              if (torNum !== null && torNum !== reqNum) isRelevant = false;
          }
      }

      if (isRelevant) {
        results.push({
          title, downloadUrl: link, size: 'Unknown', age: 'N/A', indexer: 'GetComics', protocol: 'ddl'
        });
      }
    });

    return results.sort((a, b) => a.title.length - b.title.length);
  },

  async scrapeDeepLink(articleUrl: string): Promise<{ url: string, isDirect: boolean }> {
      try {
          const { data } = await axios.get(articleUrl, { 
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
              timeout: 10000
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
              const text = $(el).text().trim();
              const titleAttr = ($(el).attr('title') || "").trim();
              const href = $(el).attr('href') || "";
              
              const decoded = decodeLink(href);
              if (!decoded) return;

              // FIX: Use case-insensitive Regex to find the button
              const isDownloadText = /download now|main server|direct download/i.test(text) || 
                                     /download now|main server|direct download/i.test(titleAttr);
              
              // Ensure we only automate links that stay on the getcomics.org domain
              const isInternal = decoded.includes('getcomics.org');
              const isDirectFile = !!decoded.match(/\.(cbz|cbr|zip|rar|epub)$/i);

              if (isDownloadText && (isInternal || isDirectFile)) {
                  bestLink = decoded;
                  isDirect = true;
                  return false; // Found the primary link, exit each loop
              } 
              
              // Fallback: If we find a direct file link elsewhere, use it if no high-priority link found
              if (isDirectFile && !bestLink) {
                  bestLink = decoded;
                  isDirect = true;
              }
          });

          // Final cleanup check
          if (!bestLink || bestLink === articleUrl) {
              return { url: articleUrl, isDirect: false };
          }

          return { url: bestLink, isDirect: true };
      } catch (error: unknown) {
          return { url: articleUrl, isDirect: false };
      }
  }
};