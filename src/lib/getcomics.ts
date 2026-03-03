import axios from 'axios';
import * as cheerio from 'cheerio';
import { Logger } from './logger';

export const GetComicsService = {
  async search(query: string) {
    // Strip the year from the fallback search if the strict search fails
    const noYearQuery = query.replace(/\s\d{4}$/, '').trim();
    
    // NEW: One-Shot Fallback. Strips the trailing issue number (e.g., "1") entirely
    const noIssueQuery = noYearQuery.replace(/\s#?\d+(?:\.\d+)?$/, '').trim();
    
    const searches = [
        query,
        query.replace(/[:\-\&]/g, ' ').replace(/\s+/g, ' ').trim(),
        noYearQuery,
        noYearQuery.replace(/[:\-\&]/g, ' ').replace(/\s+/g, ' ').trim(),
        noIssueQuery, // <--- One-Shot Fallback
        noIssueQuery.replace(/[:\-\&]/g, ' ').replace(/\s+/g, ' ').trim() 
    ];
    
    // Remove duplicates and any empty strings
    const uniqueSearches = [...new Set(searches)].filter(s => s.length > 0);
    
    for (const q of uniqueSearches) {
        let retries = 3;
        while (retries > 0) {
            try {
                const results = await this.performSearch(q);
                if (results.length > 0) return results;
                break; // Found nothing but no server error, move to next query format
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
        await new Promise(r => setTimeout(r, 1000)); // Standard buffer between query formats
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

    // Keep words that contain numbers (e.g., "#1", "2"). Previously, length > 2 deleted them!
    const queryWords = safeQuery.toLowerCase().split(' ').filter(w => w.length > 2 || /\d/.test(w));

    $('article.post').each((i, el) => {
      const title = $(el).find('h1.post-title a').text().trim();
      const link = $(el).find('h1.post-title a').attr('href');
      
      const titleLower = title.toLowerCase();
      let isRelevant = true;

      for (let w of queryWords) {
          // Smart Issue Number Matching (Matches "#1", " 1 ", " 01 ", etc.)
          if (w.startsWith('#')) {
              const num = parseInt(w.replace('#', ''));
              // Regex looks for #1, or word boundary 01, 001, etc.
              const numRegex = new RegExp(`(?:#|\\b0*)${num}\\b`, 'i');
              if (!numRegex.test(titleLower)) {
                  isRelevant = false;
                  break;
              }
          } else if (!titleLower.includes(w)) {
              isRelevant = false;
              break;
          }
      }

      if (title && link && isRelevant) {
        results.push({
          title, downloadUrl: link, size: 'Unknown', age: 'N/A', indexer: 'GetComics', protocol: 'ddl'
        });
      }
    });
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

          // 1. Scan ALL links on the page, avoiding strictly hardcoded CSS classes that break often
          $('a').each((i, el) => {
              const text = $(el).text().toLowerCase();
              const titleAttr = ($(el).attr('title') || "").toLowerCase();
              const href = $(el).attr('href') || "";
              
              // Optimization: Only parse links that actually look like they contain files or redirects
              if (!href.includes('go.php') && !text.includes('download') && !titleAttr.includes('download')) {
                  return; // continue loop
              }

              const decoded = decodeLink(href);
              if (!decoded) return;

              const isMainServer = 
                  text.includes('main server') || titleAttr.includes('main server') || 
                  text.includes('download now') || titleAttr.includes('download now') ||
                  text.includes('direct download');
              
              const isThirdParty = decoded.includes('mediafire.com') || decoded.includes('mega.nz') || decoded.includes('zippyshare.com') || decoded.includes('userscloud.com');

              // Holy Grail: A direct server link
              if ((isMainServer || decoded.match(/\.(cbz|cbr|zip)$/i)) && !isThirdParty) {
                  bestLink = decoded;
                  isDirect = true;
                  return false; // Break the loop! We found the absolute best possible link.
              } 
              // Silver Medal: A third-party or unknown link (store it just in case we find nothing better)
              else if (!bestLink) {
                  bestLink = decoded;
                  isDirect = !isThirdParty; // If it's not explicitly a 3rd party host, guess that it might be direct
              }
          });

          if (bestLink) return { url: bestLink, isDirect };
          return { url: articleUrl, isDirect: false };

      } catch (error: any) {
          return { url: articleUrl, isDirect: false };
      }
  }
};