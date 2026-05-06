import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { Logger } from './logger';

// In-memory cache to prevent API bans during mass scans
const volumeResolutionCache = new Map<string, { cvId: number, timestamp: number }>();

// NEW: Cleanup function to be called by the background job
export function cleanupMetadataExtractorCache() {
    const now = Date.now();
    let deletedCount = 0;
    for (const [key, data] of volumeResolutionCache.entries()) {
        // Clear items older than 24 hours (86400000 ms)
        if (now - data.timestamp > 24 * 60 * 60 * 1000) {
            volumeResolutionCache.delete(key);
            deletedCount++;
        }
    }
    return deletedCount;
}

export async function parseComicInfo(filePath: string) {
    if (!filePath.toLowerCase().match(/\.(cbz|zip|epub)$/)) return null;

    try {
        const zip = new AdmZip(filePath);
        const zipEntries = zip.getEntries();
        
        const infoEntry = zipEntries.find(e => e.entryName.toLowerCase() === 'comicinfo.xml');
        if (!infoEntry) return null; 

        const xmlString = infoEntry.getData().toString('utf8');
        const parser = new XMLParser({ ignoreAttributes: false });
        const result = parser.parse(xmlString);

        const info = result.ComicInfo;
        Logger.log(`[Metadata Extractor Debug] Successfully parsed ComicInfo.xml for: ${filePath}`, 'debug');
        if (!info) return null;

        const seriesName = info.Series ? String(info.Series).trim() : null;

        // 1. Look directly for standard ComicVine tags first
        let cvId = info.ComicVineVolumeId ? parseInt(info.ComicVineVolumeId) : null;
        let cvIssueId = info.ComicVineIssueId ? parseInt(info.ComicVineIssueId) : null;
        
        // 2. Fallback to parsing the Web URL if standard tags are missing
        if (info.Web && typeof info.Web === 'string') {
            if (!cvId) {
                const volMatch = info.Web.match(/(?:comicvine\.gamespot\.com|comicvine\.com)\/.*\/4050-(\d+)/i);
                if (volMatch) cvId = parseInt(volMatch[1]);
            }
            if (!cvIssueId) {
                const issMatch = info.Web.match(/(?:comicvine\.gamespot\.com|comicvine\.com)\/.*\/4000-(\d+)/i);
                if (issMatch) cvIssueId = parseInt(issMatch[1]);
            }
        }

        // 3. Extract the Year BEFORE checking the cache
        let parsedYear = info.Volume ? parseInt(info.Volume) : null;
        if (!parsedYear || isNaN(parsedYear)) {
            parsedYear = info.Year ? parseInt(info.Year) : null;
        }

        Logger.log(`[Metadata Extractor Debug] Parsed values from ComicInfo.xml -> Series: "${seriesName}", Number: "${info.Number}", Volume/Year: "${parsedYear}", Manga: "${info.Manga}"`, 'debug');

        // 4. Safely resolve Volume ID from Issue URL using a Composite Key
        const cacheKey = `${seriesName}_${parsedYear || 'unknown'}`;

        if (!cvId && cvIssueId) {
            // Check the cache using the Name + Year
            if (seriesName && volumeResolutionCache.has(cacheKey)) {
                Logger.log(`[Metadata Extractor Debug] Cache HIT for composite key: ${cacheKey}`, 'debug');
                cvId = volumeResolutionCache.get(cacheKey)!.cvId; // <-- UPDATED: Read the cvId property
            } else {
                try {
                    const { prisma } = await import('@/lib/db');
                    const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
                    if (setting?.value) {
                        const { apiClient } = await import('@/lib/api-client');
                        const cvRes = await apiClient.get(`https://comicvine.gamespot.com/api/issue/4000-${cvIssueId}/`, {
                            params: { api_key: setting.value, format: 'json', field_list: 'volume' }
                        });
                        
                        if (cvRes.data?.results?.volume?.id) {
                            cvId = parseInt(cvRes.data.results.volume.id);
                            Logger.log(`[Metadata] Resolved Volume ID ${cvId} from Issue URL.`, 'info');
                            
                            // Cache the result using the composite key with a timestamp
                            if (seriesName) {
                                volumeResolutionCache.set(cacheKey, { cvId, timestamp: Date.now() }); // <-- UPDATED: Save as object
                            }
                        }
                    }
                } catch (e) {
                    Logger.log(`[Metadata] Failed to resolve Volume ID from Issue URL: ${cvIssueId}`, 'warn');
                }
            }
        }
        
        const splitList = (str: any) => str ? String(str).split(',').map(s => s.trim()).filter(Boolean) : [];

        return {
            series: seriesName,
            title: info.Title ? String(info.Title).trim() : null,
            number: info.Number ? String(info.Number).trim() : null,
            publisher: info.Publisher ? String(info.Publisher).trim() : null,
            year: parsedYear,
            summary: info.Summary ? String(info.Summary).trim() : null,
            writers: splitList(info.Writer),
            artists: splitList(info.Penciller),
            characters: splitList(info.Characters),
            isManga: (info.Manga === 'Yes' || info.Manga === 'YesAndRightToLeft'),
            mangaTag: info.Manga ? String(info.Manga).trim() : null,
            cvId: cvId,
            cvIssueId: cvIssueId
        };
    } catch (error) {
        Logger.log(`[Metadata] Failed to parse ComicInfo in ${filePath}`, 'error');
        return null;
    }
}