// src/lib/metadata/providers/metron.ts
import { IMetadataProvider, MetadataSeries, MetadataIssue } from '../provider';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { logApiUsage } from '@/lib/utils/system-flags'; 

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

export class MetronProvider implements IMetadataProvider {
    private readonly baseUrl = 'https://metron.cloud/api';
    private readonly requestHeaders = { 'User-Agent': 'Omnibus/1.0' };

    private async getAuth() {
        const settings = await prisma.systemSetting.findMany({
            where: { key: { in: ['metron_user', 'metron_pass'] } }
        });
        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
        
        if (!config.metron_user || !config.metron_pass || config.metron_pass === '********') {
            Logger.log(`[Metron Debug] Auth requested but credentials are missing or masked.`, 'debug');
            return undefined;
        }
        
        return { username: config.metron_user, password: config.metron_pass };
    }

    // --- THE FIX: Native Fetch Implementation ---
    private async fetchWithBackoff(url: string, config: any, maxRetries = 3): Promise<any> {
        const headers: Record<string, string> = { ...config.headers };
        
        if (config.auth) {
            headers['Authorization'] = `Basic ${Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64')}`;
        }

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), config.timeout || 10000);

                const response = await fetch(url, {
                    method: 'GET',
                    headers,
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);

                const remaining = parseInt(response.headers.get('x-ratelimit-burst-remaining') || '20', 10);
                if (remaining <= 2) {
                    const reset = parseInt(response.headers.get('x-ratelimit-burst-reset') || '0', 10);
                    if (reset > 0) {
                        const sleepMs = Math.max(0, (reset * 1000) - Date.now()) + 500;
                        if (sleepMs > 0) {
                            Logger.log(`[Metron] Proactive burst limit pause for ${Math.round(sleepMs/1000)}s...`, 'info');
                            await new Promise(r => setTimeout(r, sleepMs));
                        }
                    } else {
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }

                if (response.status === 429) {
                    const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10);
                    Logger.log(`[Metron] Rate limit hit (429) for ${url}. Waiting ${retryAfter}s...`, 'warn');
                    await new Promise(resolve => setTimeout(resolve, (retryAfter + 1) * 1000));
                    continue;
                }

                const isValid = (response.status >= 200 && response.status < 300) || response.status === 304 || response.status === 404;
                if (!isValid) {
                    throw new Error(`HTTP Error: ${response.status}`);
                }

                let data = {};
                if (response.status !== 204 && response.status !== 304) {
                    try { data = await response.json(); } catch(e) {}
                }

                return {
                    status: response.status,
                    data
                };

            } catch (error: any) {
                if (attempt === maxRetries - 1) throw error;
                Logger.log(`[Metron] Fetch failed. Retrying attempt ${attempt + 2}/${maxRetries}...`, 'warn');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        throw new Error('Max retries reached');
    }

    async searchSeries(query: string): Promise<MetadataSeries[]> {
        const auth = await this.getAuth();
        if (!auth) return [];
        
        const res = await this.fetchWithBackoff(`${this.baseUrl}/series/?name=${encodeURIComponent(query)}`, {
            headers: this.requestHeaders,
            auth,
            timeout: 10000
        });

        await logApiUsage('metron', '/series');
        
        return (res.data?.results || []).map((series: any) => ({
            sourceId: series.id.toString(),
            source: 'METRON',
            name: series.name || 'Unknown',
            year: series.year_began || 0,
            publisher: series.publisher?.name || series.publisher || "Metron",
            description: series.desc || null,
            coverUrl: series.image || null,
            status: series.status?.name === 'Ended' ? 'Ended' : 'Ongoing'
        }));
    }

    async getSeriesByCvId(cvId: string): Promise<MetadataSeries | null> {
        const auth = await this.getAuth();
        if (!auth) return null;
        
        const res = await this.fetchWithBackoff(`${this.baseUrl}/series/?cv_id=${cvId}`, {
            headers: this.requestHeaders,
            auth,
            timeout: 10000
        });
        
        if (res.status === 404) return null;

        const results = res.data?.results || [];
        if (results.length > 0) {
            const series = results[0];
            return {
                sourceId: series.id.toString(),
                source: 'METRON',
                name: series.name || 'Unknown',
                year: series.year_began || 0,
                publisher: series.publisher?.name || series.publisher || "Metron",
                description: series.desc || null,
                coverUrl: series.image || null,
                status: series.status?.name === 'Ended' ? 'Ended' : 'Ongoing'
            };
        }
        return null;
    }

    async getSeriesDetails(id: string, lastModified?: Date): Promise<MetadataSeries | null> {
        const auth = await this.getAuth();
        
        const headers: any = { ...this.requestHeaders };
        if (lastModified) headers['If-Modified-Since'] = lastModified.toUTCString();

        const res = await this.fetchWithBackoff(`${this.baseUrl}/series/${id}/`, { 
            headers, auth, timeout: 10000 
        });
        
        if (res.status === 304) return null;
        if (res.status === 404) throw new Error(`Series ${id} not found on Metron.`);

        await logApiUsage('metron', `/series/${id}`);
        const series = res.data;

        return {
            sourceId: series.id.toString(),
            source: 'METRON',
            name: series.name || 'Unknown',
            year: series.year_began || 0,
            publisher: series.publisher?.name || series.publisher || "Metron",
            description: series.desc || null,
            coverUrl: series.image || null,
            status: series.status?.name === 'Ended' ? 'Ended' : 'Ongoing'
        };
    }

    async getSeriesIssues(id: string): Promise<MetadataIssue[]> {
        const auth = await this.getAuth();
        let allIssues: any[] = [];
        let nextUrl: string | null = `${this.baseUrl}/series/${id}/issue_list/`;
        let callsMade = 0;

        while (nextUrl) {
            const res = await this.fetchWithBackoff(nextUrl, { headers: this.requestHeaders, auth, timeout: 10000 });
            callsMade++;
            const pageResults = res.data?.results || [];
            allIssues = allIssues.concat(pageResults);
            nextUrl = res.data?.next || null;
        }

        if (callsMade > 0) await logApiUsage('metron', '/issue', callsMade);

        return allIssues.map((issue: any) => {
            const credits = issue.credits || [];
            const writers = credits.filter((c: any) => hasRole(c.role, 'writer')).map((c: any) => extractName(c.creator));
            const artists = credits.filter((c: any) => hasRole(c.role, 'artist') || hasRole(c.role, 'penciller') || hasRole(c.role, 'inker')).map((c: any) => extractName(c.creator));
            const characters = (issue.characters || []).map((c: any) => extractName(c));

            return {
                sourceId: issue.id.toString(),
                issueNumber: issue.number || '0',
                name: issue.name || `Issue ${issue.number}`,
                releaseDate: issue.cover_date || null,
                coverUrl: issue.image || null,
                description: issue.desc || null,
                writers: writers.filter(Boolean),
                artists: artists.filter(Boolean),
                characters: characters.filter(Boolean)
            };
        });
    }

    async getIssueDetails(id: string): Promise<MetadataIssue> {
        const auth = await this.getAuth();
        const res = await this.fetchWithBackoff(`${this.baseUrl}/issue/${id}/`, {
            headers: this.requestHeaders, auth, timeout: 10000
        });

        await logApiUsage('metron', `/issue/${id}`);
        const issue = res.data;
        const credits = issue.credits || [];

        const writers = credits.filter((c: any) => hasRole(c.role, 'writer')).map((c: any) => extractName(c.creator));
        const artists = credits.filter((c: any) => hasRole(c.role, 'artist') || hasRole(c.role, 'penciller') || hasRole(c.role, 'inker')).map((c: any) => extractName(c.creator));
        const coverArtists = credits.filter((c: any) => hasRole(c.role, 'cover')).map((c: any) => extractName(c.creator));
        const colorists = credits.filter((c: any) => hasRole(c.role, 'color')).map((c: any) => extractName(c.creator));
        const letterers = credits.filter((c: any) => hasRole(c.role, 'letter')).map((c: any) => extractName(c.creator));

        const characters = (issue.characters || []).map((c: any) => extractName(c));
        const teams = (issue.teams || []).map((t: any) => extractName(t));
        const storyArcs = (issue.arcs || []).map((a: any) => extractName(a));

        return {
            sourceId: issue.id.toString(),
            issueNumber: issue.number || '0',
            name: issue.name || `Issue ${issue.number}`,
            releaseDate: issue.cover_date || null,
            coverUrl: issue.image || null,
            description: issue.desc || null,
            writers: Array.from(new Set(writers)).filter(Boolean) as string[],
            artists: Array.from(new Set(artists)).filter(Boolean) as string[],
            coverArtists: Array.from(new Set(coverArtists)).filter(Boolean) as string[],
            colorists: Array.from(new Set(colorists)).filter(Boolean) as string[],
            letterers: Array.from(new Set(letterers)).filter(Boolean) as string[],
            characters: characters.filter(Boolean) as string[],
            teams: teams.filter(Boolean) as string[],
            storyArcs: storyArcs.filter(Boolean) as string[],
            locations: []
        };
    }
}