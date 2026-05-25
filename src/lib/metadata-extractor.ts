import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { Logger } from './logger';

// In-memory cache to prevent API bans during mass scans
const volumeResolutionCache = new Map<string, { cvId: number, timestamp: number }>();

export function cleanupMetadataExtractorCache() {
    const now = Date.now();
    let deletedCount = 0;
    for (const [key, data] of volumeResolutionCache.entries()) {
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
        
        // --- NEW: Look for custom Metron tags injected by external tools (ComicTagger, etc.) ---
        let metronId = info.MetronId ? parseInt(info.MetronId) : null;
        let metronIssueId = info.MetronIssueId ? parseInt(info.MetronIssueId) : null;

        // 2. Fallback to parsing the Web URL if standard tags are missing (Supports CV AND Metron)
        if (info.Web && typeof info.Web === 'string') {
            const webUrl = info.Web;
            if (!cvId) {
                const volMatch = webUrl.match(/(?:comicvine\.gamespot\.com|comicvine\.com)\/.*\/4050-(\d+)/i);
                if (volMatch) cvId = parseInt(volMatch[1]);
            }
            if (!cvIssueId) {
                const issMatch = webUrl.match(/(?:comicvine\.gamespot\.com|comicvine\.com)\/.*\/4000-(\d+)/i);
                if (issMatch) cvIssueId = parseInt(issMatch[1]);
            }
            
            // Look for Metron tags specifically (Requires numeric ID in URL)
            if (!metronId) {
                const metronVolMatch = webUrl.match(/metron\.cloud\/series\/(\d+)/i);
                if (metronVolMatch) metronId = parseInt(metronVolMatch[1]);
            }
            
            if (!metronIssueId) {
                const metronIssMatch = webUrl.match(/metron\.cloud\/issue\/(\d+)/i);
                if (metronIssMatch) metronIssueId = parseInt(metronIssMatch[1]);
            }
        }

        // 3. Extract the Year BEFORE checking the cache
        let parsedYear = info.Volume ? parseInt(info.Volume) : null;
        if (!parsedYear || isNaN(parsedYear)) {
            parsedYear = info.Year ? parseInt(info.Year) : null;
        }

        Logger.log(`[Metadata Extractor Debug] Parsed values from ComicInfo.xml -> Series: "${seriesName}", Number: "${info.Number}", Volume/Year: "${parsedYear}", Manga: "${info.Manga}"`, 'debug');

        // 4. Safely resolve Volume ID from Issue URL using a Composite Key (For CV Only)
        const cacheKey = `${seriesName}_${parsedYear || 'unknown'}`;

        if (!cvId && cvIssueId && !metronId && !metronIssueId) {
            if (seriesName && volumeResolutionCache.has(cacheKey)) {
                Logger.log(`[Metadata Extractor Debug] Cache HIT for composite key: ${cacheKey}`, 'debug');
                cvId = volumeResolutionCache.get(cacheKey)!.cvId; 
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
                            if (seriesName) {
                                volumeResolutionCache.set(cacheKey, { cvId, timestamp: Date.now() }); 
                            }
                        }
                    }
                } catch (e) {
                    Logger.log(`[Metadata] Failed to resolve Volume ID from Issue URL: ${cvIssueId}`, 'warn');
                }
            }
        }
        
        const splitList = (str: any) => str ? String(str).split(',').map(s => s.trim()).filter(Boolean) : [];

        // Finalize the generic Metadata IDs
        const resolvedMetaSource = (metronId || metronIssueId) ? 'METRON' : ((cvId || cvIssueId) ? 'COMICVINE' : 'LOCAL');
        const resolvedMetaId = metronId || cvId || null;
        const resolvedMetaIssueId = metronIssueId || cvIssueId || null;

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
            cvIssueId: cvIssueId,
            metronId: metronId,
            metadataId: resolvedMetaId,
            metadataSource: resolvedMetaSource,
            metadataIssueId: resolvedMetaIssueId
        };
    } catch (error) {
        Logger.log(`[Metadata] Failed to parse ComicInfo in ${filePath}`, 'error');
        return null;
    }
}