// src/lib/metadata/providers/metron.ts
import { IMetadataProvider, MetadataSeries, MetadataIssue, SearchSeriesOptions } from '../provider';
import { Logger } from '@/lib/logger';
import { getMetronAuth, metronGet, MetronHttpError, MetronPace, MetronResponse } from '@/lib/metron/client';

/** Results per Metron list page (their API's page size). */
const METRON_PAGE_SIZE = 100;
/** Results per Omnibus search page. */
const UI_PAGE_SIZE = 10;

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
    private readonly pace: MetronPace;

    /**
     * Every request goes through the shared Metron client (src/lib/metron/client.ts): token or Basic
     * auth, pacing from Metron's rate-limit headers, retries only on 429/5xx, usage counting, the
     * response cache. `pace`: 'interactive' (the default) for someone waiting on a page, 'background'
     * for sync/import work.
     */
    constructor(opts: { pace?: MetronPace } = {}) {
        this.pace = opts.pace ?? 'interactive';
    }

    private get(url: string, extra: { ifModifiedSince?: string; timeoutMs?: number } = {}): Promise<MetronResponse> {
        return metronGet(url, { pace: this.pace, ...extra });
    }

    /**
     * A series' first-issue cover (Metron's series payloads carry no image, so it costs an issue_list
     * request): the URL, null when the series has none, or undefined when the request was skipped -
     * a nice-to-have is never waited for - or failed.
     */
    private async tryFirstIssueCover(seriesId: string | number): Promise<string | null | undefined> {
        try {
            const res = await metronGet(`${this.baseUrl}/series/${seriesId}/issue_list/`, { pace: this.pace, optional: true, maxAttempts: 1, timeoutMs: 5000 });
            return res.data?.results?.[0]?.image || null;
        } catch {
            return undefined;
        }
    }

    private async firstIssueCover(seriesId: string | number): Promise<string | null> {
        return (await this.tryFirstIssueCover(seriesId)) ?? null;
    }

    /** One series' cover, for a result someone is about to look at (see /api/search/cover). */
    async seriesCover(seriesId: string): Promise<string | null> {
        if (!(await getMetronAuth())) return null;
        return this.firstIssueCover(seriesId);
    }

    /**
     * Series search, ten results per page. `covers` fetches a first-issue cover per result - one
     * Metron request each - so only a search someone is looking at asks for them (Metron beta 4).
     */
    async searchSeries(query: string, page: number = 1, opts: SearchSeriesOptions = {}): Promise<MetadataSeries[]> {
        if (!(await getMetronAuth())) return [];

        // Metron pages hold 100 results (checked 2026-09-30; this assumed 50, so results 51-100 of
        // every page were unreachable): ten of our pages per Metron page.
        const perMetronPage = METRON_PAGE_SIZE / UI_PAGE_SIZE;
        const metronPage = Math.floor((page - 1) / perMetronPage) + 1;
        const startIndex = ((page - 1) % perMetronPage) * UI_PAGE_SIZE;
        const endIndex = startIndex + UI_PAGE_SIZE;

        const res = await this.get(`${this.baseUrl}/series/?name=${encodeURIComponent(query)}&page=${metronPage}`, { timeoutMs: 10000 });

        const rawList = res.data?.results || [];
        Logger.log(`[Metron Debug] Search returning ${rawList.length} total items. Slicing indexes ${startIndex} to ${endIndex}.`, 'debug');

        const seriesList = rawList.slice(startIndex, endIndex);
        const mapped: MetadataSeries[] = [];

        for (let i = 0; i < seriesList.length; i++) {
            const series = seriesList[i];

            let realPublisher = "Unknown";
            if (series.publisher) {
                realPublisher = typeof series.publisher === 'string' ? series.publisher : (series.publisher.name || "Unknown");
            }

            // Covers are optional: skipped the moment Metron's burst window has no free slot, so a
            // search page never waits on them (the page is then left uncached - see /api/search).
            const cover = opts.covers ? await this.tryFirstIssueCover(series.id) : null;

            mapped.push({
                sourceId: series.id.toString(),
                source: 'METRON',
                name: series.series || series.name || 'Unknown',
                year: series.year_began || 0,
                publisher: realPublisher,
                universe: series.universe?.name || null,
                description: series.desc || null,
                coverUrl: cover ?? null,
                ...(cover === undefined ? { coverPending: true } : {}),
                status: series.status?.name === 'Ended' ? 'Ended' : 'Ongoing',
                issueCount: series.issue_count || 0
            });
        }
        return mapped;
    }

    async getSeriesByCvId(cvId: string): Promise<MetadataSeries | null> {
        if (!(await getMetronAuth())) return null;

        const res = await this.get(`${this.baseUrl}/series/?cv_id=${cvId}`, { timeoutMs: 10000 });
        if (res.status === 404) return null;

        const results = res.data?.results || [];
        if (results.length > 0) {
            const series = results[0];
            const coverUrl = await this.firstIssueCover(series.id);

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
        let targetEndpoint = `${this.baseUrl}/series/${id}/`;

        // FIX: If the ID is a slug (Not a Number), we MUST use the query endpoint to resolve it
        if (isNaN(Number(id))) {
            targetEndpoint = `${this.baseUrl}/series/?name=${encodeURIComponent(id)}`;
        }

        const res = await this.get(targetEndpoint, { timeoutMs: 10000, ifModifiedSince: lastModified?.toUTCString() });
        if (res.status === 304) return null;
        if (res.status === 404) throw new Error(`Series ${id} not found on Metron.`);

        let series = res.data;
        
        // If we queried by slug, extract the first exact result
        if (isNaN(Number(id)) && res.data?.results) {
            if (res.data.results.length === 0) throw new Error(`Series slug ${id} returned 0 results on Metron.`);
            series = res.data.results[0];
        }

        Logger.log(`[Metron Debug] Raw Series Details Payload: ${JSON.stringify(series).substring(0, 150)}...`, 'debug');

        const coverUrl = await this.firstIssueCover(series.id);

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
        let allIssues: any[] = [];
        let nextUrl: string | null = `${this.baseUrl}/series/${id}/issue_list/`;

        // Pages are walked one after another (Metron's best practices: sequential, never in parallel).
        while (nextUrl) {
            const res: MetronResponse = await this.get(nextUrl, { timeoutMs: 15000 });
            allIssues = allIssues.concat(res.data?.results || []);
            nextUrl = res.data?.next || null;
        }

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
        const res = await this.get(`${this.baseUrl}/issue/${id}/`, { timeoutMs: 10000 });
        if (res.status === 404) throw new MetronHttpError(404, `Issue ${id} not found on Metron.`);
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
                const searchRes = await metronGet(`${this.baseUrl}/series/?name=${encodeURIComponent(cleanName)}`, { pace: this.pace, optional: true, maxAttempts: 1, timeoutMs: 5000 });

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