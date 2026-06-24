// src/lib/hosters/annas-archive.ts
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Logger } from '../logger';
import { prisma } from '../db';
import { getErrorMessage } from '../utils/error';

export async function resolveAnnasArchive(url: string, account?: any) {
    try {
        Logger.log(`[Anna's Archive Debug] Evaluating URL: ${url}`, 'debug');

        // Anna's Archive URLs usually look like: https://annas-archive.org/md5/239847239847239847239847
        const md5Match = url.match(/\/md5\/([a-zA-Z0-9]+)/i);
        if (!md5Match) {
            Logger.log(`[Anna's Archive Debug] Failed to extract MD5 hash from URL.`, 'debug');
            return { success: false, error: "Invalid Anna's Archive URL format. Missing MD5." };
        }

        const md5 = md5Match[1];
        Logger.log(`[Anna's Archive Debug] Successfully extracted MD5: ${md5}`, 'debug');

        // If the user has a premium API key configured in the Hosters tab
        if (account?.apiKey) {
            Logger.log(`[Anna's Archive] Using premium API key for fast download of ${md5}`, 'info');
            Logger.log(`[Anna's Archive Debug] Calling fast_download API endpoint...`, 'debug');
            
            // Anna's Archive's fast-download JSON API (members only). The endpoint is
            // /dyn/api/fast_download.json — the older /api/fast_download path no longer resolves.
            // Follow whatever mirror the /md5/ link used (its origin); AA rotates domains frequently
            // (.org/.se/.li are dead; .gl is current as of mid-2026).
            let apiOrigin = 'https://annas-archive.gl';
            try { apiOrigin = new URL(url).origin; } catch { /* malformed URL — keep the default mirror */ }
            const apiRes = await axios.get(`${apiOrigin}/dyn/api/fast_download.json`, {
                headers: { 'User-Agent': 'Omnibus/1.0' },
                params: {
                    key: account.apiKey,
                    md5: md5
                },
                timeout: 15000
            });

            Logger.log(`[Anna's Archive Debug] API responded with status: ${apiRes.status}`, 'debug');

            // Success → { download_url, account_fast_download_info: { downloads_left, downloads_per_day } }
            // Failure → { error: "..." } (invalid key, exhausted daily quota, etc.).
            const data = apiRes.data || {};
            if (data.download_url) {
                const left = data.account_fast_download_info?.downloads_left;
                if (typeof left === 'number') {
                    Logger.log(`[Anna's Archive] Fast download resolved (${left} download(s) left today).`, 'info');
                }
                return {
                    success: true,
                    directUrl: data.download_url
                };
            } else {
                throw new Error(data.error || "API did not return a download URL. Check your API key or daily limit.");
            }
        }

        // If no API key is provided, we return false. 
        // Omnibus will then drop the link into the MANUAL_DDL queue so the user can click it and solve the CAPTCHAs in their browser.
        Logger.log(`[Anna's Archive Debug] No Premium API Key configured. Dropping to manual resolution queue.`, 'debug');
        return { 
            success: false, 
            error: "Anna's Archive requires a Premium API Key for automated downloads. Please configure one in Settings -> File Hosters." 
        };

    } catch (error: any) {
        Logger.log(`[Anna's Archive Debug] Request failed: ${error.message}`, 'debug');
        return { success: false, error: `Anna's Archive Error: ${error.message}` };
    }
}

// =============================================================================
// SEARCH HALF
//
// Anna's Archive (annas-archive.*) is BOTH a search index and a download host. The block above is the
// DOWNLOAD half (fast_download API). What follows is its SEARCH half: it scrapes the public /search page
// (NO API key required) and returns unified results with protocol "ddl" — matching the field shape that
// ProwlarrService.searchComics produces (guid, title, size, indexer, seeders, peers, infoUrl,
// downloadUrl, protocol, publishDate, infoHash). Resolving a result to bytes uses resolveAnnasArchive at
// download time (premium key) or falls to the manual queue. Ported 1:1 from the Rust engine's
// annas_archive.rs.
//
// Two gotchas, confirmed against six reference scrapers:
//  1. AA lazy-loads each result card INSIDE an HTML comment (`<!-- … -->`); a raw-HTTP parse must strip
//     the comment markers first or it finds zero results (`uncomment`).
//  2. AA sits behind Cloudflare/DDoS-Guard, so fetches reuse the same FlareSolverr/Byparr bypass +
//     browser User-Agent that GetComics uses.
// =============================================================================

// AA rotates domains under takedown pressure: .org was suspended (Jan 2026), .se/.li are gone; .gl is
// the current stable mirror (mid-2026). Admin-overridable via `annas_archive_base_url` for the next one.
const AA_DEFAULT_BASE_URL = 'https://annas-archive.gl';
const AA_DEFAULT_FORMATS = 'cbz,cbr,pdf,epub';

// Known Anna's Archive mirror hosts to fail over to when the configured base is unreachable. AA rotates
// domains under takedown pressure (.org/.se/.li were lost through 2026; .gl is current), so this list is
// best-effort: the admin can always point `annas_archive_base_url` at the live mirror.
const AA_KNOWN_MIRRORS = [
    'https://annas-archive.gl',
    'https://annas-archive.se',
    'https://annas-archive.li',
    'https://annas-archive.org',
];

const AA_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/** Ordered, de-duplicated base URLs to try: the configured base first, then the known mirrors. Pure. */
function aaMirrorCandidates(configured: string): string[] {
    const c = configured.trim().replace(/\/+$/, '');
    const out: string[] = [c];
    for (const m of AA_KNOWN_MIRRORS) {
        if (!out.includes(m)) out.push(m);
    }
    return out;
}

/**
 * Word-boundary substring test, ported from the Rust engine's `discover::contains_word`. A match counts
 * only when the character immediately before/after the needle is NOT ASCII-alphanumeric (so "man" does
 * not match "manga"/"manhattan", but "gee-whiz" — which ends on a hyphen — still matches at a boundary).
 * Deliberately NOT a `\b` regex: `\b` treats "-" as a boundary differently and the needle can contain
 * regex metacharacters, so a byte-boundary scan mirrors the Rust behavior exactly.
 */
function aaContainsWord(haystack: string, needle: string): boolean {
    if (!needle) return false;
    const isAlnum = (ch: string | undefined) => ch !== undefined && /[a-zA-Z0-9]/.test(ch);
    let from = 0;
    while (from <= haystack.length) {
        const i = haystack.indexOf(needle, from);
        if (i === -1) break;
        const beforeOk = i === 0 || !isAlnum(haystack[i - 1]);
        const after = i + needle.length;
        const afterOk = after >= haystack.length || !isAlnum(haystack[after]);
        if (beforeOk && afterOk) return true;
        from = i + 1;
    }
    return false;
}

/**
 * Strip the lazy-load HTML comment markers AA wraps each result card in, so a raw-HTTP parse sees the
 * cards (parity with the milahu/CrazyZard/aapy scrapers, which all do this blunt global replace).
 */
function aaUncomment(html: string): string {
    return html.split('<!--').join('').split('-->').join('');
}

/**
 * Build the AA search URL. `content=book_comic` is added for comics (omitted for manga, whose AA
 * categorization is inconsistent — the `ext` filter still constrains it). `ext` repeats to OR formats.
 */
function aaBuildSearchUrl(base: string, query: string, formats: string[], includeComicContent: boolean, page: number): string {
    let url = `${base.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}`;
    if (includeComicContent) url += '&content=book_comic';
    for (const f of formats) url += `&ext=${encodeURIComponent(f)}`;
    if (page > 1) url += `&page=${page}`;
    return url;
}

/** Extract the 32-hex md5 from an AA `/md5/<hash>` href (full URL or bare path), lowercased. */
function aaExtractMd5(href: string): string | null {
    const idx = href.indexOf('/md5/');
    if (idx === -1) return null;
    const rest = href.slice(idx + 5);
    const m = rest.match(/^[0-9a-fA-F]*/);
    const hash = m ? m[0] : '';
    return hash.length === 32 ? hash.toLowerCase() : null;
}

/** First recognized comic/book file-format token in a metadata string, lowercased (".cbz" → "cbz"). */
function aaParseFormat(text: string): string | null {
    const m = text.match(/\b(cbz|cbr|cbt|cb7|epub|pdf|mobi|azw3|fb2|djvu)\b/i);
    return m ? m[1].toLowerCase() : null;
}

/** Parse a human-readable size ("12.3MB", "900 KB", "1.5 GB") into bytes (decimal units). null if absent. */
function aaParseSize(text: string): number | null {
    const m = text.match(/(\d+(?:\.\d+)?)\s*(tb|gb|mb|kb|b)\b/i);
    if (!m) return null;
    const num = parseFloat(m[1]);
    if (isNaN(num)) return null;
    const mult: Record<string, number> = { tb: 1e12, gb: 1e9, mb: 1e6, kb: 1e3, b: 1 };
    return Math.trunc(num * (mult[m[2].toLowerCase()] ?? 1));
}

/**
 * Cloudflare/DDoS-Guard-aware fetch, mirroring getcomics.ts's fetchGetComicsHtml but tagged for Anna's
 * Archive and reusing the same solver settings. On a 403/503 it routes through the configured solver;
 * if that fails (or none is set) it returns the raw (likely-challenge) body so the caller degrades to an
 * empty result list rather than erroring.
 */
async function aaFetchHtml(url: string, flareUrl: string, solverType: string, solveSecs: number): Promise<string> {
    try {
        const { data } = await axios.get(url, {
            headers: { 'User-Agent': AA_USER_AGENT },
            timeout: 15000,
        });
        return typeof data === 'string' ? data : String(data);
    } catch (err: any) {
        const status = err?.response?.status;
        if (status === 403 || status === 503) {
            if (flareUrl) {
                // FlareSolverr's maxTimeout is in MILLISECONDS; Byparr reads it as SECONDS. The HTTP
                // timeout always uses real ms + a 15s margin so it never cuts the solver short.
                const payloadTimeout = solverType === 'byparr' ? solveSecs : solveSecs * 1000;
                const httpTimeoutMs = solveSecs * 1000 + 15000;
                Logger.log(`[Anna's Archive] HTTP ${status} for ${url}; attempting ${solverType} bypass...`, 'warn');
                try {
                    const targetUrl = flareUrl.endsWith('/v1') ? flareUrl : `${flareUrl}/v1`;
                    const flareRes = await axios.post(targetUrl, {
                        cmd: 'request.get',
                        url,
                        maxTimeout: payloadTimeout,
                    }, { headers: { 'Content-Type': 'application/json' }, timeout: httpTimeoutMs });

                    if (flareRes.data?.solution?.response) {
                        Logger.log(`[Anna's Archive] ${solverType} bypass successful for ${url}`, 'info');
                        return flareRes.data.solution.response;
                    }
                    Logger.log(`[Anna's Archive] ${solverType} returned no usable HTML for ${url}`, 'warn');
                } catch (flareErr: unknown) {
                    Logger.log(`[Anna's Archive] solver request failed: ${getErrorMessage(flareErr)}`, 'warn');
                }
            } else {
                Logger.log(`[Anna's Archive] HTTP ${status} for ${url} and no Cloudflare solver configured.`, 'warn');
            }
        }
        // Degrade gracefully: return whatever body we have (challenge page or empty) instead of throwing.
        const body = err?.response?.data;
        return typeof body === 'string' ? body : '';
    }
}

/**
 * Searches Anna's Archive across the given queries and returns unified DDL results (de-duped by md5
 * across pages/queries), matching ProwlarrService.searchComics's result shape. No API key is needed —
 * search scrapes the public page; resolving a result to bytes uses resolveAnnasArchive at download time
 * (premium key) or falls to the manual queue. `isInteractive` selects the page depth.
 */
export async function searchAnnasArchive(queries: string[], isInteractive: boolean, isManga: boolean, year?: string): Promise<any[]> {
    // --- SystemSetting-driven config (single read of the keys we need) ---
    let baseUrl = AA_DEFAULT_BASE_URL;
    let allowedFormats: string[] = AA_DEFAULT_FORMATS.split(',').map(s => s.trim().replace(/^\.+/, '').toLowerCase()).filter(Boolean);
    let interactivePages = 1;
    let automatedPages = 2;
    let flareUrl = '';
    let solverType = 'flaresolverr';
    let solveSecs = 300;
    const blocklist: string[] = [];

    try {
        const [
            baseSetting,
            formatsSetting,
            interactivePagesSetting,
            automatedPagesSetting,
            flareSetting,
            solverSetting,
            timeoutSetting,
            filterEnabledSetting,
            filterKeywordsSetting,
            filterPublishersSetting,
        ] = await Promise.all([
            prisma.systemSetting.findUnique({ where: { key: 'annas_archive_base_url' } }),
            prisma.systemSetting.findUnique({ where: { key: 'annas_archive_formats' } }),
            prisma.systemSetting.findUnique({ where: { key: 'annas_archive_interactive_pages' } }),
            prisma.systemSetting.findUnique({ where: { key: 'annas_archive_automated_pages' } }),
            prisma.systemSetting.findUnique({ where: { key: 'flaresolverr_url' } }),
            prisma.systemSetting.findUnique({ where: { key: 'solver_type' } }),
            prisma.systemSetting.findUnique({ where: { key: 'flaresolverr_timeout' } }),
            prisma.systemSetting.findUnique({ where: { key: 'filter_enabled' } }),
            prisma.systemSetting.findUnique({ where: { key: 'filter_keywords' } }),
            prisma.systemSetting.findUnique({ where: { key: 'filter_publishers' } }),
        ]);

        const trimmedBase = baseSetting?.value?.trim().replace(/\/+$/, '');
        if (trimmedBase) baseUrl = trimmedBase;

        if (formatsSetting?.value?.trim()) {
            const parsed = formatsSetting.value.split(',').map(s => s.trim().replace(/^\.+/, '').toLowerCase()).filter(Boolean);
            if (parsed.length > 0) allowedFormats = parsed;
        }

        const iParsed = parseInt((interactivePagesSetting?.value ?? '').trim(), 10);
        if (!isNaN(iParsed)) interactivePages = iParsed;
        const aParsed = parseInt((automatedPagesSetting?.value ?? '').trim(), 10);
        if (!isNaN(aParsed)) automatedPages = aParsed;

        if (flareSetting?.value) flareUrl = flareSetting.value.replace(/\/$/, '');
        if (solverSetting?.value === 'byparr') solverType = 'byparr';
        const parsedSecs = parseInt(timeoutSetting?.value || '300', 10);
        if (!isNaN(parsedSecs)) solveSecs = Math.min(600, Math.max(30, parsedSecs));

        // Content blocklist: applied to AA result titles only when the global content filter is on
        // (parity with the Discover filter). AA exposes no rating/publisher field, so both keyword and
        // publisher lists are matched against the title (the best signal available).
        if (filterEnabledSetting?.value === 'true') {
            for (const s of [filterKeywordsSetting?.value, filterPublishersSetting?.value]) {
                if (s) blocklist.push(...s.split(',').map(v => v.trim().toLowerCase()).filter(Boolean));
            }
        }
    } catch (e: unknown) {
        Logger.log(`[Anna's Archive] Failed to load settings: ${getErrorMessage(e)}`, 'warn');
    }

    const maxPages = Math.max(1, isInteractive ? interactivePages : automatedPages);

    // Mirror failover: lock onto a reachable host on the first successful fetch; if the configured base
    // is dead (AA rotates domains), fall over to a known mirror and use it for the rest of this call.
    const candidates = aaMirrorCandidates(baseUrl);
    let activeBase = baseUrl;
    let baseLocked = false;

    const results: any[] = [];
    const seen = new Set<string>();

    for (const q of queries) {
        if (!q || !q.trim()) continue;
        Logger.log(`[Anna's Archive] Searching for: "${q}"`, 'info');

        for (let page = 1; page <= maxPages; page++) {
            // Rate-limit throttle (interactive is more aggressive than automation).
            await new Promise(r => setTimeout(r, isInteractive ? 2500 : 4000));

            let html: string;
            if (baseLocked) {
                const url = aaBuildSearchUrl(activeBase, q, allowedFormats, !isManga, page);
                Logger.log(`[Anna's Archive Debug] Searching page ${page}/${maxPages}: ${url}`, 'debug');
                html = await aaFetchHtml(url, flareUrl, solverType, solveSecs);
            } else {
                // First fetch: try the configured base, then fail over to known mirrors. aaFetchHtml
                // already degrades to a body on error, so a connect failure surfaces as an empty string.
                let got: string | null = null;
                for (const cand of candidates) {
                    const url = aaBuildSearchUrl(cand, q, allowedFormats, !isManga, page);
                    Logger.log(`[Anna's Archive Debug] Searching page ${page}/${maxPages}: ${url}`, 'debug');
                    const body = await aaFetchHtml(url, flareUrl, solverType, solveSecs);
                    if (body) {
                        if (cand !== activeBase) {
                            Logger.log(`[Anna's Archive] Configured mirror ${activeBase} unreachable; switched to ${cand}. Update the Base URL in Settings.`, 'warn');
                            activeBase = cand;
                        }
                        baseLocked = true;
                        got = body;
                        break;
                    }
                    Logger.log(`[Anna's Archive] Mirror ${cand} unreachable.`, 'warn');
                }
                if (got === null) {
                    Logger.log(`[Anna's Archive] All known mirrors unreachable for "${q}".`, 'warn');
                    break;
                }
                html = got;
            }

            // Extract (md5, title, full-text) cards. Select anchors whose href contains /md5/; the
            // cover-image link (same md5, no <h3>, no text) yields no title and is skipped — the real
            // card wins.
            const $ = cheerio.load(aaUncomment(html));
            const cards: { md5: string; title: string; full: string }[] = [];
            $('a').each((_i, el) => {
                const href = $(el).attr('href') || '';
                if (!href.includes('/md5/')) return;
                const md5 = aaExtractMd5(href);
                if (!md5) return;
                const h3Text = $(el).find('h3').first().text().trim();
                const anchorText = $(el).text().trim();
                const title = h3Text || anchorText;
                if (!title) return;
                cards.push({ md5, title, full: $(el).text() });
            });

            if (cards.length === 0) break; // end of results / a blocked challenge page

            for (const { md5, title, full } of cards) {
                if (seen.has(md5)) continue;
                seen.add(md5);

                // Content filter (when the admin's global filter is on): match the blocklist against the
                // title (word-boundary) — the only signal AA exposes here.
                if (blocklist.length > 0) {
                    const titleLower = title.toLowerCase();
                    if (blocklist.some(b => aaContainsWord(titleLower, b))) {
                        Logger.log(`[Anna's Archive] Filtered "${title}" (matched content blocklist).`, 'debug');
                        continue;
                    }
                }

                // Parse metadata from the card text MINUS the title, so a format word in the title isn't
                // misread as the file format.
                const meta = full.replace(title, ' ');
                const fmt = aaParseFormat(meta);
                if (fmt && allowedFormats.length > 0 && !allowedFormats.includes(fmt)) continue;

                const size = aaParseSize(meta) ?? 0;
                const cleanTitle = title.split(/\s+/).filter(Boolean).join(' ');
                // Append the format for interactive display clarity, but keep a clean title for automation
                // so relevance/issue-number matching isn't skewed.
                const displayTitle = (fmt && isInteractive) ? `${cleanTitle} [${fmt}]` : cleanTitle;
                const md5Url = `${activeBase}/md5/${md5}`;

                results.push({
                    guid: md5,
                    title: displayTitle,
                    size,
                    indexer: "Anna's Archive",
                    seeders: 0,
                    peers: 0,
                    infoUrl: md5Url,
                    downloadUrl: md5Url,
                    protocol: 'ddl',
                    publishDate: 'N/A',
                    infoHash: null,
                });
            }

            // Automation doesn't need every page; stop once we have matches (interactive aggregates all).
            if (!isInteractive && results.length > 0) break;
        }
    }

    Logger.log(`[Anna's Archive] Returning ${results.length} result(s).`, 'info');
    return results;
}