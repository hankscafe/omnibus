import axios from 'axios';
import * as cheerio from 'cheerio';
import { Logger } from './logger';
import { getErrorMessage } from './utils/error';

export const GetComicsService = {
  async search(query: string, isInteractive: boolean = false) {
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
        let retries = 2;
        while (retries > 0) {
            try {
                const results = await this.performSearch(q, isInteractive);
                if (results.length > 0) return results;
                break; 
            } catch (e: any) { 
                Logger.log(`[GetComics] Search failed for "${q}": ${e.message}`, 'warn');
                retries--;
                if (retries === 0) break;
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }
    return [];
  },

  async performSearch(safeQuery: string, isInteractive: boolean = false) {
    const url = `https://getcomics.org/?s=${encodeURIComponent(safeQuery)}`;
    
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000
    });

    const $ = cheerio.load(data);
    const results: any[] = [];
    
    const queryWords = safeQuery.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(' ').filter(w => w.trim().length > 0);

    $('article, .post').each((i, el) => {
      const titleEl = $(el).find('h1.post-title a, h2.post-title a, h1 a, h2 a, .post-header a').first();
      const title = titleEl.text().trim();
      const link = titleEl.attr('href');
      
      if (!title || !link) return;

      const titleLower = title.toLowerCase();
      let isRelevant = true;

      // INTERACTIVE BYPASS: If interactive, show all results. If automated, use strict filtering.
      if (!isInteractive) {
          for (let w of queryWords) {
              if (/^\d+$/.test(w)) {
                  const num = parseInt(w);
                  const numRegex = new RegExp(`(?:#|\\bissue\\s*|\\bvol(?:ume)?\\s*|\\b0*)${num}\\b`, 'i');
                  if (!numRegex.test(titleLower)) { isRelevant = false; break; }
              } else {
                  const wordRegex = new RegExp(`\\b${w}\\b`, 'i');
                  if (!wordRegex.test(titleLower)) { isRelevant = false; break; }
              }
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
              const text = $(el).text().toLowerCase();
              // RESTORED: The crucial titleAttr check that prevents grabbing ad links
              const titleAttr = ($(el).attr('title') || "").toLowerCase();
              const href = $(el).attr('href') || "";
              
              if (!href.includes('go.php') && !text.includes('download') && !titleAttr.includes('download')) {
                  return; 
              }

              const decoded = decodeLink(href);
              if (!decoded) return;

              // RESTORED: The 'download now' keyword check
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

      } catch (error: unknown) {
          Logger.log(`[GetComics Scrape] Failed to parse deep link: ${getErrorMessage(error)}`, 'error');
          return { url: articleUrl, isDirect: false };
      }
  }
};