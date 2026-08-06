// src/lib/metadata/providers/metron.ts
import { IMetadataProvider, MetadataSeries, MetadataIssue } from '../provider';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { logApiUsage } from '@/lib/utils/system-flags';
import { getCachedResponse, putCachedResponse } from '@/lib/metadata/metadata-cache';

const extractName = (obj: any): string => {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    return obj.name || obj.label || '';
};

const hasRole = (roleObj: any, roleName: string): boolean => {
    if (!roleObj) return false;
    if (Array.isArray(roleObj)) {
        return roleObj.some(r => extractName(r).toLowerCase().includes(roleName));
    }
    return extractName(roleObj).toLowerCase().includes(roleName);
};

// Maps Metron's series_type (e.g. "One-Shot", "Trade Paperback", "Ongoing Series")
// to the Mylar booktype values used in series.json
const mapSeriesType = (seriesType: any): 'Print' | 'OneShot' | 'TPB' | 'GN' | null => {
    const name = extractName(seriesType).toLowerCase();
    if (!name) return null;
    if (name.includes('one-shot') || name.includes('one shot') || name.includes('single issue')) return 'OneShot';
    if (name.includes('trade paperback') || name.includes('omnibus') || name.includes('hard cover') || name.includes('hardcover')) return 'TPB';
    if (name.includes('graphic novel')) return 'GN';
    return 'Print'; // Ongoing, Limited, Annual, Digital Chapters, etc. are all standard print series
};

export class MetronProvider implements IMetadataProvider {
    private readonly baseUrl = 'https://metron.cloud/api';
    private readonly requestHeaders = { 'User-Agent': 'Omnibus/1.0' };

    private async getAuth() {
        const settings = await prisma.systemSetting.findMany({
            where: { key: { in: ['metron_user', 'metron_pass'] } }
        });
        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
        
        if (!config.metron_user || !config.metron_pass || config.metron_pass === '********') {
            return undefined;
        }
        
        return { username: config.metron_user, password: config.metron_pass };
    }

    private async fetchWithBackoff(url: string, config: any, maxRetries = 3): Promise<any> {
        const headers: Record<string, string> = { ...config.headers };

        if (config.auth) {
            headers['Authorization'] = `Basic ${Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64')}`;
        }

        // Shared response cache (metadata_cache_enabled): conditional (If-Modified-Since) requests
        // bypass it — their whole point is asking Metron "did this change", which the cache can't
        // answer. Callers check `cached` before logging API usage (a hit is not an upstream call).
        const conditional = !!headers['If-Modified-Since'];
        if (!conditional) {
            const hit = await getCachedResponse('metron', url);
            if (hit !== null) return { status: 200, data: hit, cached: true };
        }

        Logger.log(`[Metron Debug] Executing Fetch: ${url}`, 'debug');

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), config.timeout || 15000);

                const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
                clearTimeout(timeoutId);

                const remaining = parseInt(response.headers.get('x-ratelimit-burst-remaining') || '20', 10);
                Logger.log(`[Metron Debug] Rate Limit Status -> Burst Remaining: ${remaining}`, 'debug');

                if (remaining <= 2) {
                    const reset = parseInt(response.headers.get('x-ratelimit-burst-reset') || '0', 10);
                    if (reset > 0) {
                        const sleepMs = Math.max(0, (reset * 1000) - Date.now()) + 500;
                        if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));
                    }
                }

                if (response.status === 429) {
                    const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10);
                    
                    // --- NEW: Circuit Breaker for Severe Bans ---
                    if (retryAfter > 60) {
                        Logger.log(`[Metron] FATAL Rate Limit Hit. IP blocked for ${retryAfter}s.`, 'error');
                        throw new Error("FATAL_RATE_LIMIT");
                    }
                    
                    Logger.log(`[Metron] Rate Limit Hit. Waiting ${retryAfter}s before retrying...`, 'warn');
                    await new Promise(resolve => setTimeout(resolve, (retryAfter + 1) * 1000));
                    continue; 
                }

                const isValid = (response.status >= 200 && response.status < 300) || response.status === 304 || response.status === 404;
                if (!isValid) throw new Error(`HTTP Error: ${response.status}`);

                let data = {};
                if (response.status !== 204 && response.status !== 304) {
                    try {
                        data = await response.json();
                    } catch(e) {
                        Logger.log(`[Metron Debug] Failed to parse JSON response from ${url}`, 'error');
                    }
                }

                if (!conditional && response.status === 200 && data && Object.keys(data).length > 0) {
                    await putCachedResponse('metron', url, data);
                }
                return { status: response.status, data, cached: false };

            } catch (error: any) {
                Logger.log(`[Metron Debug] Fetch Attempt ${attempt + 1} Failed: ${error.message}`, 'debug');
                if (attempt === maxRetries - 1) throw error;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        throw new Error('Max retries reached');
    }

    async searchSeries(query: string, page: number = 1): Promise<MetadataSeries[]> {
        const auth = await this.getAuth();
        if (!auth) return [];
        
        const metronPage = Math.floor((page - 1) / 5) + 1;
        const startIndex = ((page - 1) % 5) * 10;
        const endIndex = startIndex + 10;

        const res = await this.fetchWithBackoff(`${this.baseUrl}/series/?name=${encodeURIComponent(query)}&page=${metronPage}`, { headers: this.requestHeaders, auth, timeout: 10000 });
        if (!res.cached) await logApiUsage('metron', '/series');
        
        const rawList = res.data?.results || [];
        Logger.log(`[Metron Debug] Search returning ${rawList.length} total items. Slicing indexes ${startIndex} to ${endIndex}.`, 'debug');
        
        const seriesList = rawList.slice(startIndex, endIndex);
        const mapped: MetadataSeries[] = [];
        let rateLimitHit = false;

        for (let i = 0; i < seriesList.length; i++) {
            const series = seriesList[i];
            let coverUrl = null; 
            
            let realPublisher = "Unknown";
            if (series.publisher) {
                realPublisher = typeof series.publisher === 'string' ? series.publisher : (series.publisher.name || "Unknown");
            }
            
            if (!rateLimitHit) { 
                try {
                    const issueRes = await this.fetchWithBackoff(`${this.baseUrl}/series/${series.id}/issue_list/`, { headers: this.requestHeaders, auth, timeout: 3000 }, 1);
                    if (issueRes.data?.results?.length > 0) coverUrl = issueRes.data.results[0].image || null;
                } catch(e: any) {
                    // fetchWithBackoff throws 'FATAL_RATE_LIMIT' (or 'HTTP Error: 429'), never 'RATE_LIMIT' —
                    // the old check never tripped, leaving this per-page cover circuit-breaker dead.
                    if (e.message === 'FATAL_RATE_LIMIT' || (e.message || '').includes('429')) rateLimitHit = true;
                }
            }

            mapped.push({
                sourceId: series.id.toString(),
                source: 'METRON',
                name: series.series || series.name || 'Unknown',
                year: series.year_began || 0,
                publisher: realPublisher,
                universe: series.universe?.name || null,
                description: series.desc || null,
                coverUrl: coverUrl,
                status: series.status?.name === 'Ended' ? 'Ended' : 'Ongoing',
                issueCount: series.issue_count || 0
            });
        }
        return mapped;
    }

    async getSeriesByCvId(cvId: string): Promise<MetadataSeries | null> {
        const auth = await this.getAuth();
        if (!auth) return null;
        
        const res = await this.fetchWithBackoff(`${this.baseUrl}/series/?cv_id=${cvId}`, { headers: this.requestHeaders, auth, timeout: 10000 });
        if (res.status === 404) return null;
        
        const results = res.data?.results || [];
        if (results.length > 0) {
            const series = results[0];
            let coverUrl = null;
            try {
                const issueRes = await this.fetchWithBackoff(`${this.baseUrl}/series/${series.id}/issue_list/`, { headers: this.requestHeaders, auth, timeout: 5000 }, 1);
                if (issueRes.data?.results?.length > 0) coverUrl = issueRes.data.results[0].image || null;
            } catch(e) {}

            return {
                sourceId: series.id.toString(),
                source: 'METRON',
                name: series.series || series.name || 'Unknown',
                year: series.year_began || 0,
                publisher: series.publisher?.name || series.publisher || "Unknown",
                description: series.desc || null,
                coverUrl: coverUrl,
                status: series.status?.name === 'Ended' ? 'Ended' : 'Ongoing',
                issueCount: series.issue_count || 0
            };
        }
        return null;
    }

    async getSeriesDetails(id: string, lastModified?: Date): Promise<MetadataSeries | null> {
        const auth = await this.getAuth();
        const headers: any = { ...this.requestHeaders };
        if (lastModified) headers['If-Modified-Since'] = lastModified.toUTCString();

        let targetEndpoint = `${this.baseUrl}/series/${id}/`;
        
        // FIX: If the ID is a slug (Not a Number), we MUST use the query endpoint to resolve it
        if (isNaN(Number(id))) {
            targetEndpoint = `${this.baseUrl}/series/?name=${encodeURIComponent(id)}`;
        }

        const res = await this.fetchWithBackoff(targetEndpoint, { headers, auth, timeout: 10000 });
        if (res.status === 304) return null;
        if (res.status === 404) throw new Error(`Series ${id} not found on Metron.`);

        let series = res.data;
        
        // If we queried by slug, extract the first exact result
        if (isNaN(Number(id)) && res.data?.results) {
            if (res.data.results.length === 0) throw new Error(`Series slug ${id} returned 0 results on Metron.`);
            series = res.data.results[0];
        }

        if (!res.cached) await logApiUsage('metron', `/series/${series.id}`);
        Logger.log(`[Metron Debug] Raw Series Details Payload: ${JSON.stringify(series).substring(0, 150)}...`, 'debug');

        let coverUrl = null;

        try {
            const issueRes = await this.fetchWithBackoff(`${this.baseUrl}/series/${series.id}/issue_list/`, { headers: this.requestHeaders, auth, timeout: 5000 }, 1);
            if (issueRes.data?.results?.length > 0) coverUrl = issueRes.data.results[0].image || null;
        } catch(e) {}

        return {
            sourceId: series.id.toString(),
            source: 'METRON',
            name: series.series || series.name || 'Unknown',
            year: series.year_began || 0,
            publisher: series.publisher?.name || series.publisher || "Unknown",
            description: series.desc || null,
            coverUrl: coverUrl,
            status: series.status?.name === 'Ended' ? 'Ended' : 'Ongoing',
            issueCount: series.issue_count || 0,
            bookType: mapSeriesType(series.series_type)
        };
    }

    async getSeriesIssues(id: string): Promise<MetadataIssue[]> {
        const auth = await this.getAuth();
        let allIssues: any[] = [];
        let nextUrl: string | null = `${this.baseUrl}/series/${id}/issue_list/`;
        let callsMade = 0;

        while (nextUrl) {
            const res = await this.fetchWithBackoff(nextUrl, { headers: this.requestHeaders, auth, timeout: 15000 });
            if (!res.cached) callsMade++;
            allIssues = allIssues.concat(res.data?.results || []);
            nextUrl = res.data?.next || null;
        }

        if (callsMade > 0) await logApiUsage('metron', '/issue', callsMade);

        return allIssues.map((issue: any) => {
            const seriesName = typeof issue.series === 'string' ? issue.series : (issue.series?.name || '');
            const issueName = issue.title || issue.issue_name || issue.issue || '';
            
            let fullName = seriesName ? `${seriesName} #${issue.number || '0'}` : `Issue #${issue.number || '0'}`;
            const isGeneric = issueName.match(/^Issue\s*#?\s*\d+$/i) !== null;
            
            if (issueName && issueName !== seriesName && !issueName.includes(`#${issue.number}`) && !isGeneric) {
                fullName += `: ${issueName}`;
            } else if (issueName && issueName.includes(`#${issue.number}`) && !isGeneric) {
                fullName = issueName;
            }

            return {
                sourceId: issue.id.toString(),
                issueNumber: issue.number || '0',
                name: fullName,
                releaseDate: issue.store_date || issue.cover_date || null,
                coverUrl: issue.image || null,
                description: issue.desc || issue.description || null,
                writers: [], artists: [], characters: []
            };
        });
    }

    async getIssueDetails(id: string): Promise<MetadataIssue> {
        const auth = await this.getAuth();
        const res = await this.fetchWithBackoff(`${this.baseUrl}/issue/${id}/`, { headers: this.requestHeaders, auth, timeout: 10000 });

        if (!res.cached) await logApiUsage('metron', `/issue/${id}`);
        const issue = res.data;
        Logger.log(`[Metron Debug] Raw Issue Details Payload: ${JSON.stringify(issue).substring(0, 150)}...`, 'debug');
        
        const credits = issue.credits || [];

        const writers = credits.filter((c: any) => hasRole(c.role, 'writer')).map((c: any) => extractName(c.creator));
        // #199 Call-3 Beta A: inkers get their own bucket now that Issue has an inker column —
        // ComicInfo separates <Penciller> and <Inker>, and double-filing would double-credit on embed.
        const artists = credits.filter((c: any) => hasRole(c.role, 'artist') || hasRole(c.role, 'penciller')).map((c: any) => extractName(c.creator));
        const inker = credits.filter((c: any) => hasRole(c.role, 'inker')).map((c: any) => extractName(c.creator));
        const editor = credits.filter((c: any) => hasRole(c.role, 'editor')).map((c: any) => extractName(c.creator));
        const translator = credits.filter((c: any) => hasRole(c.role, 'translator')).map((c: any) => extractName(c.creator));
        const coverArtists = credits.filter((c: any) => hasRole(c.role, 'cover')).map((c: any) => extractName(c.creator));
        const colorists = credits.filter((c: any) => hasRole(c.role, 'color')).map((c: any) => extractName(c.creator));
        const letterers = credits.filter((c: any) => hasRole(c.role, 'letter')).map((c: any) => extractName(c.creator));

        const characters = (issue.characters || []).map((c: any) => extractName(c));
        const teams = (issue.teams || []).map((t: any) => extractName(t));
        const storyArcs = (issue.arcs || []).map((a: any) => extractName(a));

        let issueTitle = issue.title;
        if (!issueTitle && Array.isArray(issue.name) && issue.name.length > 0) {
            issueTitle = issue.name[0];
        } else if (!issueTitle && typeof issue.name === 'string') {
            issueTitle = issue.name;
        }

        let parsedSeriesId: number | null = null;
        if (issue.series && typeof issue.series === 'object') {
            parsedSeriesId = parseInt(issue.series.id);
        } else if (issue.series_id) {
            parsedSeriesId = parseInt(issue.series_id);
        } else if (typeof issue.series === 'string' || typeof issue.series === 'number') {
            parsedSeriesId = parseInt(issue.series as string);
        }
        
        const seriesName = issue.series?.name || (typeof issue.series === 'string' ? issue.series : null);

        if ((!parsedSeriesId || isNaN(parsedSeriesId)) && seriesName) {
            try {
                const cleanName = seriesName.replace(/\(\d{4}\)/g, '').trim();
                const searchRes = await this.fetchWithBackoff(`${this.baseUrl}/series/?name=${encodeURIComponent(cleanName)}`, { headers: this.requestHeaders, auth, timeout: 5000 }, 1);
                
                if (searchRes.data?.results?.length > 0) {
                    const exact = searchRes.data.results.find((s: any) => (s.name || s.series)?.toLowerCase() === cleanName.toLowerCase());
                    if (exact) {
                        parsedSeriesId = parseInt(exact.id);
                    } else {
                        parsedSeriesId = parseInt(searchRes.data.results[0].id);
                    }
                }
            } catch(e) {}
        }
        
        let fullName = seriesName ? `${seriesName} #${issue.number || '0'}` : `Issue #${issue.number || '0'}`;
        const isGeneric = issueTitle ? issueTitle.match(/^Issue\s*#?\s*\d+$/i) !== null : false;
        
        if (issueTitle && issueTitle !== seriesName && !issueTitle.includes(`#${issue.number}`) && !isGeneric) {
            fullName += `: ${issueTitle}`;
        } else if (issueTitle && issueTitle.includes(`#${issue.number}`) && !isGeneric) {
            fullName = issueTitle;
        }

        return {
            sourceId: issue.id.toString(),
            issueNumber: issue.number || '0',
            name: fullName,
            releaseDate: issue.store_date || issue.cover_date || null,
            coverUrl: issue.image || null,
            description: issue.desc || null,
            writers: Array.from(new Set(writers)).filter(Boolean) as string[],
            artists: Array.from(new Set(artists)).filter(Boolean) as string[],
            coverArtists: Array.from(new Set(coverArtists)).filter(Boolean) as string[],
            colorists: Array.from(new Set(colorists)).filter(Boolean) as string[],
            letterers: Array.from(new Set(letterers)).filter(Boolean) as string[],
            inker: Array.from(new Set(inker)).filter(Boolean) as string[],
            editor: Array.from(new Set(editor)).filter(Boolean) as string[],
            translator: Array.from(new Set(translator)).filter(Boolean) as string[],
            characters: characters.filter(Boolean) as string[],
            teams: teams.filter(Boolean) as string[],
            storyArcs: storyArcs.filter(Boolean) as string[],
            locations: [],
            seriesId: (!parsedSeriesId || isNaN(parsedSeriesId)) ? null : parsedSeriesId,
            seriesName: seriesName || null,
            publisher: issue.publisher?.name || "Metron",
            // The raw story title, separate from the display composite above — the sync's
            // Issue.name convention is raw titles (parity with ComicVine), so the detail
            // pass needs it unwrapped. Placeholders ("Issue 154") stay out (#199 round 3).
            storyTitle: issueTitle && !isGeneric ? issueTitle : null
        };
    }
}