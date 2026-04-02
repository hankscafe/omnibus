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
        noYearQuery.replace(/[:\-\&]/g, ' ').replace(/\s+/g, ' ').trim(),
        noIssueQuery, 
        noIssueQuery.replace(/[:\-\&]/g, ' ').replace(/\s+/g, ' ').trim() 
    ];
    
    const uniqueSearches = [...new Set(searches)].filter(s => s.length > 0);
    
    for (const q of uniqueSearches) {
        let retries = 2;
        while (retries > 0) {
            try {
                const results = await this.performSearch(q, query, isInteractive, isManga); 
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
    if (reqNum === null) {
        let noYearQuery = cleanOriginal.replace(/\b(19|20)\d{2}\b/g, '');
        // FIX: Lookbehind regex prevents space consumption overlap
        const fallbacks = [...noYearQuery.matchAll(/(?<=^|[^a-zA-Z0-9])0*(\d+(?:\.\d+)?)(?=[^a-zA-Z0-9]|$)/g)];
        if (fallbacks.length > 0) reqNum = parseFloat(fallbacks[fallbacks.length - 1][1]);
    }

    const reqYearMatch = cleanOriginal.match(/\b(19|20)\d{2}\b/);
    const reqYear = reqYearMatch ? reqYearMatch[1] : null;

    $('article, .post').each((i, el) => {
      const titleEl = $(el).find('h1.post-title a, h2.post-title a, h1 a, h2 a, .post-header a').first();
      const title = titleEl.text().trim();
      const link = titleEl.attr('href');
      
      if (!title || !link) return;

      const titleLower = title.toLowerCase();
      let isRelevant = true;

      if (!isInteractive) {
          
          const tpbTerms = ['omnibus', 'tpb', 'compendium', 'absolute', 'collection', 'hc', 'hardcover', 'trade paperback', 'annual'];
          if (!isManga) tpbTerms.push('vol ', 'volume ', 'book ');

          const isLookingForOmnibus = queryWords.some(w => tpbTerms.includes(w));
          if (reqNum !== null && !isLookingForOmnibus) {
              if (tpbTerms.some(term => titleLower.includes(term))) {
                  isRelevant = false;
              }
          }

          if (isRelevant) {
              let cleanTor = titleLower.replace(/\.\w+$/, '').replace(/\[\d{4}(?:-\d{4})?\]/g, '').replace(/\(\d{4}(?:-\d{4})?\)/g, '');
              
              let strippedForNumbers = cleanTor;
              if (!isManga) {
                  strippedForNumbers = strippedForNumbers.replace(/(?:vol(?:ume)?\s*\.?|v\s*\.?)\s*0*\d+(?:\.\d+)?/gi, '');
                  strippedForNumbers = strippedForNumbers.replace(/(?:book\s*\.?)\s*0*\d+(?:\.\d+)?/gi, '');
              }

              let torNumMatch = strippedForNumbers.match(/(?:#|issue\s*#?|vol(?:ume)?\s*\.?|v\s*\.?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
              let torNum = torNumMatch ? parseFloat(torNumMatch[1]) : null;
              if (torNum === null) {
                  // FIX: Lookbehind regex prevents space consumption overlap
                  const fallbacks = [...strippedForNumbers.matchAll(/(?<=^|[^a-zA-Z0-9])0*(\d+(?:\.\d+)?)(?=[^a-zA-Z0-9]|$)/g)];
                  if (fallbacks.length > 0) torNum = parseFloat(fallbacks[fallbacks.length - 1][1]);
              }

              if (reqNum !== null) {
                  if (torNum !== null && torNum !== reqNum) isRelevant = false;
                  if (torNum === null) {
                      isRelevant = false; 
                  }
              }
          }

          if (isRelevant) {
              const torYearMatch = titleLower.match(/[\(\[]?(19|20)\d{2}[\)\]]?/);
              const torYear = torYearMatch ? torYearMatch[1] : null;

              if (reqYear && torYear && reqYear !== torYear) {
                  isRelevant = false;
              }
          }

          // FIX: Improved Filter 3 to enforce titles that are 100% numerical
          if (isRelevant) {
              for (let w of queryWords) {
                  const isIssueNum = reqNum !== null && parseFloat(w) === reqNum;
                  const isYear = reqYear !== null && w === reqYear;
                  if (isIssueNum || isYear) continue;

                  if (!titleLower.includes(w)) {
                      isRelevant = false;
                      break;
                  }
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

      } catch (error: unknown) {
          Logger.log(`[GetComics Scrape] Failed to parse deep link: ${getErrorMessage(error)}`, 'error');
          return { url: articleUrl, isDirect: false };
      }
  }
};