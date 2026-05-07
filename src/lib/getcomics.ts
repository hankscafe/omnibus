// src/lib/getcomics.ts
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Logger } from './logger';
import { getErrorMessage } from './utils/error';
import { prisma } from './db';
import { markSystemFlag } from './utils/system-flags';

// --- NEW: FlareSolverr 403-Bypass Helper ---
async function fetchGetComicsHtml(url: string) {
    let flareUrl = "";
    try {
        const setting = await prisma.systemSetting.findUnique({ where: { key: 'flaresolverr_url' } });
        if (setting?.value) flareUrl = setting.value.replace(/\/$/, "");
    } catch(e) {}

    try {
        const { data } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 15000
        });
        return data;
    } catch (err: any) {
        if (err.response?.status === 403) {
            if (flareUrl) {
                Logger.log(`[GetComics] 403 Forbidden detected. Attempting Cloudflare bypass via FlareSolverr...`, 'warn');
                Logger.log(`[GetComics Debug] Attempting Cloudflare bypass via FlareSolverr with payload: ${JSON.stringify({ cmd: 'request.get', url: url })}`, 'debug');
                try {
                    const targetUrl = flareUrl.endsWith('/v1') ? flareUrl : `${flareUrl}/v1`;
                    const flareRes = await axios.post(targetUrl, {
                        cmd: 'request.get',
                        url: url,
                        maxTimeout: 60000
                    }, { headers: { 'Content-Type': 'application/json' }, timeout: 65000 });
                    
                    if (flareRes.data?.solution?.response) {
                        Logger.log(`[GetComics] FlareSolverr bypass successful!`, 'success');
                        Logger.log(`[GetComics Debug] FlareSolverr bypass successful with response length: ${flareRes.data.solution.response.length}`, 'debug');                        return flareRes.data.solution.response;
                    }
                } catch (flareErr) {
                     await markSystemFlag('cloudflare_block_time');
                     throw flareErr;
                }
            } else {
                await markSystemFlag('cloudflare_block_time');
            }
        }
        throw err;
    }
}

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
    Logger.log(`[GetComics Debug] Performing search with URL: ${url}`, 'debug');
    Logger.log(`[GetComics] Rate-limit throttle: Delaying search for 2.5s...`, 'info');
    await new Promise(resolve => setTimeout(resolve, 2500));

    const data = await fetchGetComicsHtml(url);
    const $ = cheerio.load(data);
    const results: any[] = [];
    
    const cleanOriginal = originalQuery.replace(/[:\-\&]/g, ' ').replace(/\s+/g, ' ').trim();
    const queryWords = cleanOriginal.toLowerCase().split(' ').filter(w => w.trim().length > 0);

    const boundedVariantKeywords = ['noir', 'b&w', 'sketch', 'blank', 'virgin', 'uncut'];
    const openVariantKeywords = ['variant', 'special edition', "director's cut", "directors cut", 'facsimile', 'black and white', 'extended'];
    const userWantsVariant = [...boundedVariantKeywords, ...openVariantKeywords].some(k => cleanOriginal.toLowerCase().includes(k));

    // Tier 1: Explicit
    const reqIssueMatch = cleanOriginal.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
    let reqNum = reqIssueMatch ? parseFloat(reqIssueMatch[1]) : null;

    if (reqNum === null) {
        // Tier 2: Volume
        const volMatch = cleanOriginal.match(/(?:vol(?:ume)?\s*\.?|v\s*\.?)\s*0*(\d{1,3}(?:\.\d+)?)(?!\d)/i);
        if (volMatch) {
            reqNum = parseFloat(volMatch[1]);
        } else {
            // Tier 3: Standalone with Year Trap
            let noYearQuery = cleanOriginal.replace(/\b(19|20)\d{2}\b/g, '');
            const fallbacks = [...noYearQuery.matchAll(/(?<=^|[^a-zA-Z0-9])0*(\d+(?:\.\d+)?)(?=[^a-zA-Z0-9]|$)/g)];
            if (fallbacks.length > 0) {
                for (let i = fallbacks.length - 1; i >= 0; i--) {
                    const numVal = parseFloat(fallbacks[i][1]);
                    if (numVal >= 1900 && numVal <= 2099) continue;
                    reqNum = numVal;
                    break;
                }
            }
        }
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

          if (isRelevant && !userWantsVariant) {
              if (openVariantKeywords.some(k => titleLower.includes(k))) {
                  isRelevant = false;
              } else {
                  for (const bk of boundedVariantKeywords) {
                      const regex = new RegExp(`\\b${bk}\\b`, 'i');
                      if (regex.test(titleLower)) {
                          isRelevant = false;
                          break;
                      }
                  }
              }
          }

          if (isRelevant) {
              let cleanTor = titleLower.replace(/\.\w+$/, '').replace(/\[\d{4}(?:-\d{4})?\]/g, '').replace(/\(\d{4}(?:-\d{4})?\)/g, '');
              
              let strippedForNumbers = cleanTor;
              if (!isManga) {
                  strippedForNumbers = strippedForNumbers.replace(/(?:vol(?:ume)?\s*\.?|v\s*\.?)\s*0*\d+(?:\.\d+)?/gi, '');
                  strippedForNumbers = strippedForNumbers.replace(/(?:book\s*\.?)\s*0*\d+(?:\.\d+)?/gi, '');
              }

              let torNumMatch = strippedForNumbers.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
              let torNum = torNumMatch ? parseFloat(torNumMatch[1]) : null;
              
              if (torNum === null) {
                  const volMatch = strippedForNumbers.match(/(?:vol(?:ume)?\s*\.?|v\s*\.?)\s*0*(\d{1,3}(?:\.\d+)?)(?!\d)/i);
                  if (volMatch) {
                      torNum = parseFloat(volMatch[1]);
                  } else {
                      const fallbacks = [...strippedForNumbers.matchAll(/(?<=^|[^a-zA-Z0-9])0*(\d+(?:\.\d+)?)(?=[^a-zA-Z0-9]|$)/g)];
                      if (fallbacks.length > 0) {
                          for (let i = fallbacks.length - 1; i >= 0; i--) {
                              const numVal = parseFloat(fallbacks[i][1]);
                              if (numVal >= 1900 && numVal <= 2099) continue;
                              torNum = numVal;
                              break;
                          }
                      }
                  }
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

          if (isRelevant) {
              for (let w of queryWords) {
                  if (!/^\d+$/.test(w) && !titleLower.includes(w)) {
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

  async scrapeDeepLink(articleUrl: string): Promise<{ url: string, isDirect: boolean, hoster: string }> {
      try {
          Logger.log(`[GetComics] Rate-limit throttle: Delaying scrape for 2.5s...`, 'info');
          await new Promise(resolve => setTimeout(resolve, 2500));

          const data = await fetchGetComicsHtml(articleUrl);
          const $ = cheerio.load(data);

          let foundLinks: { url: string, isDirect: boolean, hoster: string }[] = [];

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

          const getHosterFromUrl = (url: string, isMainServerBtn: boolean) => {
              if (isMainServerBtn) return 'getcomics';
              
              // Only whitelist dedicated file-serving domains here (DO NOT ADD GETCOMICS HERE)
              if (url.includes('comicfiles') || url.includes('comic-files')) return 'getcomics';
              
              if (url.includes('mediafire.com')) return 'mediafire';
              if (url.includes('mega.nz') || url.includes('mega.co.nz')) return 'mega';
              if (url.includes('pixeldrain.com')) return 'pixeldrain';
              if (url.includes('terabox.com') || url.includes('teraboxapp.com')) return 'terabox';
              if (url.includes('rootz')) return 'rootz';
              if (url.includes('vikingfile')) return 'vikingfile';
              if (url.includes('zippyshare.com')) return 'zippyshare';
              if (url.includes('userscloud.com')) return 'userscloud';
              return 'unknown';
          };

          $('a').each((i, el) => {
              const text = $(el).text().toLowerCase();
              const titleAttr = ($(el).attr('title') || "").toLowerCase();
              const rawHref = $(el).attr('href') || "";
              const btnClass = ($(el).attr('class') || "").toLowerCase();

              const decoded = decodeLink(rawHref);
              if (!decoded) return;

              Logger.log(`[GetComics Debug] Decoded raw deep link: ${decoded}`, 'debug');

              // Ensure we accurately target the actual download button, even if text varies slightly
              const isMainServerBtn = text.includes('main server') || 
                                      titleAttr.includes('main server') || 
                                      text.includes('download now') || 
                                      text.includes('direct download') || 
                                      (btnClass.includes('aio-button') && text.includes('download'));
              
              if (isMainServerBtn && !rawHref.includes('go.php') && !decoded.match(/\.(cbz|cbr|zip)$/i)) {
                  // THE FIX: Allow native GetComics file servers (like dl.getcomics.org or comicfiles) 
                  // to bypass the strict file extension check, but do NOT allow this block to trust 
                  // the word 'getcomics' on every anchor tag on the webpage.
                  if (!decoded.includes('comicfiles') && !decoded.includes('comic-files') && !decoded.includes('getcomics')) {
                      return;
                  }
              }

              const hoster = getHosterFromUrl(decoded, isMainServerBtn);

              if (hoster !== 'unknown') {
                  foundLinks.push({ 
                      url: decoded, 
                      isDirect: hoster === 'getcomics', 
                      hoster 
                  });
              }
          });

          const setting = await prisma.systemSetting.findUnique({ where: { key: 'hoster_priority' } });
          let priorityList = ['mediafire', 'getcomics', 'mega', 'pixeldrain', 'rootz', 'vikingfile', 'terabox'];
          let disabledHosters: string[] = [];

          if (setting?.value) {
              try {
                  const parsed = JSON.parse(setting.value);
                  if (parsed.length > 0) {
                      if (typeof parsed[0] === 'string') {
                          priorityList = parsed;
                      } else if (typeof parsed[0] === 'object') {
                          priorityList = parsed.map((p: any) => p.hoster);
                          disabledHosters = parsed.filter((p: any) => !p.enabled).map((p: any) => p.hoster);
                      }
                  }
              } catch (e) {}
          }

          if (disabledHosters.length > 0) {
              const beforeCount = foundLinks.length;
              foundLinks = foundLinks.filter(l => !disabledHosters.includes(l.hoster));
              if (foundLinks.length < beforeCount) {
                  Logger.log(`[GetComics] Ignored ${beforeCount - foundLinks.length} links from disabled hosters.`, 'info');
              }
          }

          if (foundLinks.length === 0) {
              return { url: articleUrl, isDirect: false, hoster: 'unknown' };
          }

          const foundHosterNames = [...new Set(foundLinks.map(l => l.hoster))];
          Logger.log(`[GetComics] Found ${foundLinks.length} valid links. Available Hosters: ${foundHosterNames.join(', ')}`, 'info');

          foundLinks.sort((a, b) => {
              const idxA = priorityList.indexOf(a.hoster);
              const idxB = priorityList.indexOf(b.hoster);
              if (idxA === -1 && idxB === -1) return 0;
              if (idxA === -1) return 1;
              if (idxB === -1) return -1;
              return idxA - idxB;
          });

          const selectedHoster = foundLinks[0].hoster;
          const topPriority = priorityList.filter(h => !disabledHosters.includes(h))[0];

          if (selectedHoster !== topPriority) {
              Logger.log(`[GetComics] Preferred hoster '${topPriority}' not found. Falling back to next available: '${selectedHoster}'`, 'warn');
          } else {
              Logger.log(`[GetComics] Successfully selected top priority hoster: ${selectedHoster}`, 'success');
          }

          return foundLinks[0];

      } catch (error: unknown) {
          Logger.log(`[GetComics Scrape] Failed to parse deep link: ${getErrorMessage(error)}`, 'error');
          return { url: articleUrl, isDirect: false, hoster: 'unknown' };
      }
  }
};