// src/lib/getcomics.ts
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Logger } from './logger';
import { getErrorMessage } from './utils/error';
import { prisma } from './db';
import { markSystemFlag } from './utils/system-flags';
import { STOP_WORDS as stopWords, BOUNDED_VARIANT_KEYWORDS as boundedVariantKeywords, OPEN_VARIANT_KEYWORDS as openVariantKeywords } from './utils/search-terms';
import { normalizeRequestName } from './search-engine';
import { parseIssueRange } from './utils/issue-parser';
import { ENGINE_URL, engineHeaders } from './engine';

/**
 * Resolve a GetComics article to a concrete hoster link via the Rust engine's section-targeting
 * scraper (/api/getcomics/scrape) — instead of the flat Node scrapeDeepLink, which can hand back the
 * wrong volume's archive from a multi-pack page. Pass the request `name` (and per-issue `year`) so the
 * engine can target the section for the requested issue. Returns the top enabled-hoster link; `hoster`
 * is empty when nothing resolved, and `ambiguous` is true when the article is a multi-pack page with no
 * clean match (the caller should NOT grab an arbitrary archive — fall back to a fresh search instead).
 */
export async function scrapeDeepLinkViaEngine(
    articleUrl: string,
    opts?: { name?: string | null; year?: string | null }
): Promise<{ url: string; hoster: string; ambiguous: boolean }> {
    // Only target when the name explicitly names an issue (same marker rule as the engine's caller).
    let issueNum: number | null = null;
    if (opts?.name) {
        const m = opts.name.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(-?\d+(?:\.\d+)?)/i);
        if (m) { const n = parseFloat(m[1]); if (!isNaN(n)) issueNum = n; }
    }
    try {
        const res = await fetch(ENGINE_URL + '/api/getcomics/scrape', {
            method: 'POST',
            headers: engineHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ url: articleUrl, issue_num: issueNum, year: opts?.year ?? null }),
        });
        if (!res.ok) {
            Logger.log(`[GetComics] engine scrape returned ${res.status} for ${articleUrl}`, 'warn');
            return { url: '', hoster: '', ambiguous: false };
        }
        const data = await res.json();
        if (data.ambiguous) return { url: '', hoster: '', ambiguous: true };
        const first = Array.isArray(data.links) && data.links.length > 0 ? data.links[0] : null;
        return first ? { url: first.url, hoster: first.hoster, ambiguous: false } : { url: '', hoster: '', ambiguous: false };
    } catch (e) {
        Logger.log(`[GetComics] engine scrape failed for ${articleUrl}: ${getErrorMessage(e)}`, 'warn');
        return { url: '', hoster: '', ambiguous: false };
    }
}

// --- Shared hoster-priority helpers (kept in lock-step with the Rust engine's getcomics.rs) ---

/** Default hoster order. Both GetComics variants sit at the TOP — `getcomics_direct` (comicfiles CDN)
 *  then `getcomics_main` (getcomics.org/dls/ main server). The /dls/ direct download works for most
 *  issues (only the subset behind a live Cloudflare challenge falls through to the manual-hold), and it
 *  outranks the far-less-reliable third-party mirrors. Matches the original `getcomics`-first ordering. */
// Anna's Archive is its own search source (search_source_priority), not a GetComics mirror, so it's no
// longer part of the hoster-mirror priority list. Its download key still lives in a HosterAccount.
export const DEFAULT_HOSTER_ORDER = ['getcomics_direct', 'getcomics_main', 'mediafire', 'mega', 'pixeldrain', 'rootz', 'vikingfile', 'terabox'];

// Listed but OFF by default — Cloudflare/JS/app-gated, not resolvable by scraping (still toggleable).
export const DEFAULT_DISABLED_HOSTERS = ['rootz', 'vikingfile', 'terabox'];

export type HosterPref = { hoster: string, enabled: boolean };

/** Default hoster prefs: the standard order with the known-unreliable hosters disabled out of the box. */
export function defaultHosterPrefs(): HosterPref[] {
    return DEFAULT_HOSTER_ORDER.map(h => ({ hoster: h, enabled: !DEFAULT_DISABLED_HOSTERS.includes(h) }));
}

/** Migrate a legacy single `getcomics` entry into `getcomics_direct` (kept in place + enabled flag) +
 *  `getcomics_main` (inserted right after it, same enabled flag, so both stay high-priority — the
 *  legacy `getcomics` was first). Idempotent; mirrors Rust migrate_legacy_getcomics. */
export function migrateHosterPrefs(prefs: HosterPref[]): HosterPref[] {
    const out = prefs.map(p => ({ ...p }));
    const i = out.findIndex(p => p.hoster === 'getcomics');
    if (i !== -1) {
        const enabled = out[i].enabled;
        out[i] = { hoster: 'getcomics_direct', enabled };
        if (!out.some(p => p.hoster === 'getcomics_main')) out.splice(i + 1, 0, { hoster: 'getcomics_main', enabled });
    }
    return out;
}

/** Parse a raw `hoster_priority` setting value into an ordered, migrated pref list. Unset → defaults;
 *  empty array → none; string array → all enabled; object array → each entry's `enabled` (default true). */
export function parseHosterPrefs(value?: string | null): HosterPref[] {
    const defaults = defaultHosterPrefs;
    if (!value) return defaults();
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) return defaults();
        if (parsed.length === 0) return [];
        const prefs: HosterPref[] = typeof parsed[0] === 'string'
            ? parsed.map((h: string) => ({ hoster: h, enabled: true }))
            : parsed.map((p: any) => ({ hoster: p.hoster, enabled: p.enabled !== false }));
        return migrateHosterPrefs(prefs);
    } catch { return defaults(); }
}

/** Enabled hoster names in priority order, migrating the legacy `getcomics` key. Mirrors Rust enabled_hosters. */
export function enabledHostersFromSetting(value?: string | null): string[] {
    return parseHosterPrefs(value).filter(p => p.enabled).map(p => p.hoster);
}

// --- Cloudflare 403-bypass helper (FlareSolverr / Byparr) ---
async function fetchGetComicsHtml(url: string) {
    let flareUrl = "";
    let solverType = "flaresolverr";
    let solveSecs = 300;
    try {
        const [flareSetting, solverSetting, timeoutSetting] = await Promise.all([
            prisma.systemSetting.findUnique({ where: { key: 'flaresolverr_url' } }),
            prisma.systemSetting.findUnique({ where: { key: 'solver_type' } }),
            prisma.systemSetting.findUnique({ where: { key: 'flaresolverr_timeout' } }),
        ]);
        if (flareSetting?.value) flareUrl = flareSetting.value.replace(/\/$/, "");
        if (solverSetting?.value === 'byparr') solverType = 'byparr';
        const parsedSecs = parseInt(timeoutSetting?.value || '300', 10);
        if (!isNaN(parsedSecs)) solveSecs = Math.min(600, Math.max(30, parsedSecs));
    } catch(e) {
        Logger.log(`[GetComics] Could not read FlareSolverr settings (Cloudflare bypass may be disabled): ${e instanceof Error ? e.message : String(e)}`, 'warn');
    }

    try {
        const { data } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 15000
        });
        return data;
    } catch (err: any) {
        if (err.response?.status === 403) {
            if (flareUrl) {
                // FlareSolverr's maxTimeout is in MILLISECONDS; Byparr reads it as SECONDS. The engine's
                // own HTTP timeout always uses real ms + a 15s margin so it never cuts the solver short.
                const payloadTimeout = solverType === 'byparr' ? solveSecs : solveSecs * 1000;
                const httpTimeoutMs = solveSecs * 1000 + 15000;
                Logger.log(`[GetComics] 403 Forbidden detected. Attempting Cloudflare bypass via ${solverType}...`, 'warn');
                try {
                    const targetUrl = flareUrl.endsWith('/v1') ? flareUrl : `${flareUrl}/v1`;
                    const flareRes = await axios.post(targetUrl, {
                        cmd: 'request.get',
                        url: url,
                        maxTimeout: payloadTimeout
                    }, { headers: { 'Content-Type': 'application/json' }, timeout: httpTimeoutMs });

                    if (flareRes.data?.solution?.response) {
                        Logger.log(`[GetComics] ${solverType} bypass successful!`, 'success');
                        return flareRes.data.solution.response;
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
  // Add originalName as an optional 4th parameter
async search(query: string, isInteractive: boolean = false, isManga: boolean = false, originalName?: string, seriesYear?: string, allowPacksOverride?: boolean) {
    let uniqueSearches = [query];
    if (isInteractive) {
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
        uniqueSearches = [...new Set(searches)].filter(s => s.length > 0);
    }
             
    const aggregatedResults: any[] = [];
    const seenUrls = new Set<string>();

    for (const q of uniqueSearches) {
        let retries = 1; 
        while (retries > 0) {
            try {
                Logger.log(`[GetComics] Searching for: "${q}"`, 'info');
                const results = await this.performSearch(q, originalName || query, isInteractive, isManga, seriesYear, allowPacksOverride);
                             
                if (results.length > 0) {
                    if (!isInteractive) {
                        return [results[0]]; // Automation still takes absolute best match instantly
                    }
                    // Interactive search collects everything safely
                    for (const res of results) {
                        if (!seenUrls.has(res.downloadUrl)) {
                            seenUrls.add(res.downloadUrl);
                            aggregatedResults.push(res);
                        }
                    }
                }
                break; 
            } catch (e: any) { 
                Logger.log(`[GetComics] Search failed for "${q}": ${e.message}`, 'warn');
                retries--;
                if (retries === 0) break;
                await new Promise(r => setTimeout(r, isInteractive ? 2500 : 5000));
            }
        }
    }
    return aggregatedResults;
},

  async performSearch(safeQuery: string, originalQuery: string, isInteractive: boolean = false, isManga: boolean = false, seriesYear?: string, allowPacksOverride?: boolean) {
    const results: any[] = [];

    // GetComics post titles use UNPADDED issue numbers ("#1", "Vol. 1") — never zero-padded "001" —
    // so a padded query (some callers, e.g. the interactive modal, pad to 3 digits) matches nothing on
    // their WordPress search. Strip leading zeros from numeric tokens up front so both the search URL and
    // the relevance words use the canonical form. Years ("2008") and plain numbers ("100") are untouched.
    safeQuery = safeQuery.replace(/\b0+(\d)/g, '$1');

    // Generate both word arrays for TPB vs Single Issue validation. Normalize the name first
    // ("#1: Book One" -> "#1", "….cbz" -> "…") so a subtitle keyword doesn't flip this into omnibus mode
    // and a leaked file extension / subtitle word isn't enforced as a required title word (parity with
    // the Rust engine). The retry/recovery path passes a download FILENAME, so the extension strip matters.
    const cleanOriginal = normalizeRequestName(originalQuery).replace(/[:\-\&]/g, ' ').replace(/\s+/g, ' ').trim();
    
    const safeQueryWords = safeQuery.toLowerCase().split(' ').filter(w => w.length > 0 && !stopWords.includes(w));
    const originalQueryWords = cleanOriginal.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 0 && !stopWords.includes(w));

    const userWantsVariant = [...boundedVariantKeywords, ...openVariantKeywords].some(k => cleanOriginal.toLowerCase().includes(k));

    const reqIssueMatch = cleanOriginal.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
    let reqNum = reqIssueMatch ? parseFloat(reqIssueMatch[1]) : null;

    if (reqNum === null) {
        const volMatch = cleanOriginal.match(/(?:vol(?:ume)?\s*\.?|v\s*\.?)\s*0*(\d{1,3}(?:\.\d+)?)(?!\d)/i);
        if (volMatch) {
            reqNum = parseFloat(volMatch[1]);
        } else {
            const fallbacks = [...cleanOriginal.matchAll(/(?<=^|[^a-zA-Z0-9])0*(\d+(?:\.\d+)?)(?=[^a-zA-Z0-9]|$)/g)];
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

    const reqYearMatch = cleanOriginal.match(/\b(19\d{2}|20\d{2})\b/);
    const reqYear = reqYearMatch ? reqYearMatch[1] : (seriesYear || null);

    const bulkSetting = await prisma.systemSetting.findUnique({ where: { key: 'allow_bulk_packs' } });
    let allowBulkPacks = bulkSetting?.value === 'true';

    // If this is an automated isolated issue request, override the setting to false
    if (!isInteractive && allowPacksOverride === false) {
        allowBulkPacks = false;
    }
    // Fetch custom page limits from the database
    const interactivePageSetting = await prisma.systemSetting.findUnique({ where: { key: 'getcomics_interactive_pages' } });
    const automatedPageSetting = await prisma.systemSetting.findUnique({ where: { key: 'getcomics_automated_pages' } });

    // Parse the settings, falling back to safe defaults (4 and 5) if they haven't been set in the UI yet
    const customInteractivePages = interactivePageSetting?.value ? parseInt(interactivePageSetting.value, 10) : 4;
    const customAutomatedPages = automatedPageSetting?.value ? parseInt(automatedPageSetting.value, 10) : 5;

    const maxPages = isInteractive ? customInteractivePages : customAutomatedPages;

    for (let page = 1; page <= maxPages; page++) {
        const pagePath = page === 1 ? '/' : `/page/${page}/`;
        const url = `https://getcomics.org${pagePath}?s=${encodeURIComponent(safeQuery)}`;
        Logger.log(`[GetComics Debug] Performing search with URL: ${url} (Page ${page}/${maxPages})`, 'debug');
        
        // Apply delay to respect rate limits
        const delayTime = isInteractive ? 2500 : 4000;
        Logger.log(`[GetComics] Rate-limit throttle: Delaying search for ${delayTime/1000}s...`, 'info');
        await new Promise(resolve => setTimeout(resolve, delayTime));

        let data;
        try {
            data = await fetchGetComicsHtml(url);
        } catch (err: any) {
            // If GetComics throws a 404, we've hit the end of the search results
            if (err.response?.status === 404) {
                Logger.log(`[GetComics Debug] Reached end of pagination at page ${page}.`, 'debug');
                break;
            }
            throw err;
        }

        const $ = cheerio.load(data);
        const posts = $('article, .post');

        if (posts.length === 0) break;

        posts.each((i, el) => {
      const titleEl = $(el).find('h1.post-title a, h2.post-title a, h1 a, h2 a, .post-header a').first();
      const title = titleEl.text().trim();
      const link = titleEl.attr('href');
      
      if (!title || !link) return;

      const titleLower = title.toLowerCase();
      let isRelevant = true;
      
      // --- BASELINE FILTERS (Applies to both Automated and Interactive Searches) ---
      const tpbTerms = ['omnibus', 'tpb', 'compendium', 'collection', 'hc', 'hardcover', 'trade paperback'];
      if (!isManga) tpbTerms.push('vol ', 'volume ', 'book ');
      const isLookingForOmnibus = tpbTerms.some(term => cleanOriginal.toLowerCase().includes(term));

      // 1. Enforce Core Series Name
      let wordsToEnforce = (reqNum !== null && !isLookingForOmnibus) ? safeQueryWords : originalQueryWords;
      if (reqNum !== null && !isLookingForOmnibus) {
          const numIndex = safeQueryWords.findIndex(w => {
              const numericMatch = w.match(/\d+(?:\.\d+)?/);
              return numericMatch && parseFloat(numericMatch[0]) === reqNum;
          });
          if (numIndex !== -1) {
              wordsToEnforce = safeQueryWords.slice(0, numIndex);
          }
      }
      for (const w of wordsToEnforce) {
          if (!/^\d+$/.test(w) && !titleLower.includes(w)) {
              isRelevant = false;
              break;
          }
      }

      // 2. Enforce Release Year
      if (isRelevant && reqYear) {
          const torYearMatch = titleLower.match(/[\(\[]?(19\d{2}|20\d{2})[\)\]]?/);
          const torYear = torYearMatch ? torYearMatch[1] : null;
          if (torYear) {
              // Allow a 1-year variance for discrepancies between ComicVine and uploaders
              const yearDiff = Math.abs(parseInt(reqYear) - parseInt(torYear));
              if (yearDiff > 1) {
                  isRelevant = false;
              }
          }
      }
      // --------------------------------------------------------------------------

      if (!isInteractive && isRelevant) {
          const packTerms = ['story arc', 'pack', 'complete', 'collection', 'bundle', 'run', 'chronological'];
          // A multi-issue/volume RANGE in the title ("#0 – 9", "Vol. 1 – 4") is the most reliable batch
          // signal — GetComics bundles older runs as ranges that carry no pack KEYWORD. Treat those as
          // packs too (when bulk is enabled) so volume-batches stop being wrongly rejected as unwanted
          // TPBs for single-issue requests. (packTerms and the tpbTerms reject list previously only
          // overlapped on "collection", so a "Vol. 1 – 4" post could never be accepted.)
          const isPack = allowBulkPacks && (packTerms.some(term => titleLower.includes(term)) || parseIssueRange(titleLower) !== null);

          if (reqNum !== null && !isLookingForOmnibus && !isPack) {
              const unexpectedTpbTerms = tpbTerms.filter(term => !cleanOriginal.toLowerCase().includes(term));
              if (unexpectedTpbTerms.some(term => titleLower.includes(term))) {
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
              const cleanTor = titleLower.replace(/\.\w+$/, '').replace(/\[\d{4}(?:-\d{4})?\]/g, '').replace(/\(\d{4}(?:-\d{4})?\)/g, '');
              
              let strippedForNumbers = cleanTor;
              if (!isManga) {
                  strippedForNumbers = strippedForNumbers.replace(/(?:vol(?:ume)?\s*\.?|v\s*\.?)\s*0*\d+(?:\.\d+)?/gi, '');
                  strippedForNumbers = strippedForNumbers.replace(/(?:book\s*\.?)\s*0*\d+(?:\.\d+)?/gi, '');
              }

              const torNumMatch = strippedForNumbers.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(\d+(?:\.\d+)?)/i);
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

              if (reqNum !== null && !isLookingForOmnibus && !isPack) {
                  if (torNum !== null && torNum !== reqNum) isRelevant = false;
                  if (torNum === null) {
                      isRelevant = false; 
                  }
              }
          }

          if (isRelevant) {
              // Protect against Annuals slipping through
              const isLookingForAnnual = cleanOriginal.toLowerCase().includes('annual');
              if (!isLookingForAnnual && titleLower.includes('annual')) {
                  isRelevant = false;
              }
          }
      }

      if (isRelevant) {
          results.push({
            title, downloadUrl: link, size: 'Unknown', age: 'N/A', indexer: 'GetComics', protocol: 'ddl'
          });
        }
      });

      // Only halt pagination early for background automation. 
      // Interactive searches should capture all available options across pages!
      if (results.length > 0 && !isInteractive) {
          Logger.log(`[GetComics Debug] Found ${results.length} valid matches on Page ${page}. Halting pagination.`, 'debug');
          break;
      }
    }

    // Smarter Sorting Logic to bypass lazy uploaders who omitted the year
    return results.sort((a, b) => {
        // Priority 1: If we requested a year, heavily prefer titles that explicitly contain that year
        if (reqYear) {
            const aHasYear = a.title.includes(reqYear) ? 1 : 0;
            const bHasYear = b.title.includes(reqYear) ? 1 : 0;
            if (aHasYear !== bHasYear) {
                return bHasYear - aHasYear; 
            }
        }
        
        // Priority 2: If both have the year (or neither do), sort by shortest length (cleanest title)
        return a.title.length - b.title.length;
    });
  },

  /**
   * @deprecated The flat Node scraper was replaced by the engine's section-targeting scraper, so a
   * multi-pack article no longer hands back the wrong volume's archive. Kept as a thin delegate for any
   * legacy caller; prefer scrapeDeepLinkViaEngine(url, { name, year }) so the requested issue is targeted.
   */
  async scrapeDeepLink(articleUrl: string): Promise<{ url: string, isDirect: boolean, hoster: string }> {
      const { url, hoster } = await scrapeDeepLinkViaEngine(articleUrl);
      return { url: url || articleUrl, isDirect: hoster.startsWith('getcomics'), hoster: hoster || 'unknown' };
  }
};