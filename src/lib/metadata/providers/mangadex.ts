import axios from 'axios';
import { IMetadataProvider, MetadataSeries, MetadataIssue } from '../provider';

export class MangaDexProvider implements IMetadataProvider {
    private readonly baseUrl = 'https://api.mangadex.org';

    async searchSeries(query: string): Promise<MetadataSeries[]> {
        const res = await axios.get(`${this.baseUrl}/manga`, {
            params: { title: query, limit: 10, includes: ['cover_art', 'author'] }
        });

        return res.data.data.map((manga: any) => {
            const coverArt = manga.relationships?.find((r: any) => r.type === 'cover_art');
            const fileName = coverArt?.attributes?.fileName;
            const coverUrl = fileName ? `https://uploads.mangadex.org/covers/${manga.id}/${fileName}` : null;
            const title = manga.attributes.title?.en || Object.values(manga.attributes.title || {})[0] || 'Unknown';

            return {
                sourceId: manga.id,
                source: 'MANGADEX',
                name: title,
                year: manga.attributes.year || 0,
                publisher: "MangaDex", 
                description: manga.attributes.description?.en || null,
                coverUrl: coverUrl,
                status: manga.attributes.status === 'ongoing' ? 'Ongoing' : 'Ended'
            };
        });
    }

    async getSeriesDetails(id: string): Promise<MetadataSeries> {
        const res = await axios.get(`${this.baseUrl}/manga/${id}`, {
            params: { includes: ['cover_art', 'author'] }
        });
        const manga = res.data.data;
        const coverArt = manga.relationships?.find((r: any) => r.type === 'cover_art');
        const fileName = coverArt?.attributes?.fileName;
        const coverUrl = fileName ? `https://uploads.mangadex.org/covers/${manga.id}/${fileName}` : null;
        const title = manga.attributes.title?.en || Object.values(manga.attributes.title || {})[0] || 'Unknown';

        return {
            sourceId: manga.id,
            source: 'MANGADEX',
            name: title,
            year: manga.attributes.year || 0,
            publisher: "MangaDex",
            description: manga.attributes.description?.en || null,
            coverUrl: coverUrl,
            status: manga.attributes.status === 'ongoing' ? 'Ongoing' : 'Ended'
        };
    }

    async getSeriesIssues(id: string): Promise<MetadataIssue[]> {
        let allChapters: any[] = [];
        let offset = 0;
        let hasMore = true;

        while (hasMore && offset < 500) { 
            const res = await axios.get(`${this.baseUrl}/manga/${id}/feed`, {
                params: { translatedLanguage: ['en'], order: { chapter: 'asc' }, limit: 100, offset }
            });
            allChapters = allChapters.concat(res.data.data);
            if (res.data.total <= offset + 100) hasMore = false;
            offset += 100;
        }

        // Dedup by chapter number to prevent multiple scanlation groups blowing up the DB
        const uniqueChapters = new Map();
        for (const chapter of allChapters) {
            const chNum = chapter.attributes.chapter;
            if (chNum && !uniqueChapters.has(chNum)) {
                uniqueChapters.set(chNum, chapter);
            }
        }

        return Array.from(uniqueChapters.values()).map((chapter: any) => ({
            sourceId: chapter.id,
            issueNumber: chapter.attributes.chapter || '0',
            name: chapter.attributes.title || `Chapter ${chapter.attributes.chapter}`,
            releaseDate: chapter.attributes.publishAt,
            coverUrl: null, 
            description: null,
            writers: [],
            artists: [],
            characters: []
        }));
    }

    async getIssueDetails(id: string): Promise<MetadataIssue> {
        throw new Error('Not implemented');
    }
}