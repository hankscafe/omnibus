// src/lib/metadata/providers/metron.ts
import axios from 'axios';
import { IMetadataProvider, MetadataSeries, MetadataIssue } from '../provider';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';

export class MetronProvider implements IMetadataProvider {
    private readonly baseUrl = 'https://metron.cloud/api';

    private async getAuth() {
        const settings = await prisma.systemSetting.findMany({
            where: { key: { in: ['metron_user', 'metron_pass'] } }
        });
        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));
        
        // Return undefined if credentials aren't set or are obfuscated by the API
        if (!config.metron_user || !config.metron_pass || config.metron_pass === '********') {
            return undefined;
        }
        
        return { username: config.metron_user, password: config.metron_pass };
    }

    async searchSeries(query: string): Promise<MetadataSeries[]> {
        const auth = await this.getAuth();
        if (!auth) {
            Logger.log('[Metron] Missing credentials. Please configure Metron in Settings.', 'warn');
            return [];
        }
        
        const res = await axios.get(`${this.baseUrl}/series/`, {
            params: { name: query },
            auth,
            timeout: 10000
        });

        return (res.data.results || []).map((series: any) => ({
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

    async getSeriesDetails(id: string): Promise<MetadataSeries> {
        const auth = await this.getAuth();
        const res = await axios.get(`${this.baseUrl}/series/${id}/`, { auth, timeout: 10000 });
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
        let nextUrl = `${this.baseUrl}/issue/?series=${id}`;

        while (nextUrl) {
            const res = await axios.get(nextUrl, { auth, timeout: 10000 });
            allIssues = allIssues.concat(res.data.results || []);
            nextUrl = res.data.next;
        }

        return allIssues.map((issue: any) => {
            const credits = issue.credits || [];
            
            // Extract Roles from Metron's nested credit structure
            const writers = credits.filter((c: any) => c.role?.name?.toLowerCase().includes('writer')).map((c: any) => c.creator?.name);
            const artists = credits.filter((c: any) => c.role?.name?.toLowerCase().includes('artist') || c.role?.name?.toLowerCase().includes('penciller')).map((c: any) => c.creator?.name);
            const characters = (issue.characters || []).map((c: any) => c.name);

            return {
                sourceId: issue.id.toString(),
                issueNumber: issue.number || '0',
                name: issue.name || `Issue ${issue.number}`,
                releaseDate: issue.cover_date || null,
                coverUrl: issue.image || null,
                description: issue.desc || null,
                writers: writers,
                artists: artists,
                characters: characters
            };
        });
    }

    async getIssueDetails(id: string): Promise<MetadataIssue> {
        throw new Error('Not implemented');
    }
}