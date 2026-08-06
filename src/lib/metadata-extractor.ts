// src/lib/metadata-extractor.ts
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { Logger } from './logger';

// In-memory cache to prevent API bans during mass scans
const volumeResolutionCache = new Map<string, { cvId: number | string, timestamp: number }>();

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
    // ZIP-family only: AdmZip cannot read RAR, so accepting .cbr/.rar here only produced a silent throw →
    // null (it never actually read their ComicInfo). CBR/RAR are handled by the CBZ conversion pipeline
    // (unrar/unar); the resulting .cbz is then parsed here normally — so don't pretend to parse them now.
    if (!filePath.toLowerCase().match(/\.(cbz|zip|epub)$/)) return null;

    try {
        const zip = new AdmZip(filePath);
        const zipEntries = zip.getEntries();
        
        const infoEntry = zipEntries.find(e => e.entryName.toLowerCase() === 'comicinfo.xml');
        if (!infoEntry) return null; 

        let xmlString = infoEntry.getData().toString('utf8');
        
        // FIX: Safely sanitize ampersands WITHOUT breaking numeric entities like &#39; or &#x2013;
        xmlString = xmlString.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/gi, '&amp;');

        const parser = new XMLParser({ ignoreAttributes: false });
        const result = parser.parse(xmlString);

        const info = result.ComicInfo;
        Logger.log(`[Metadata Extractor Debug] Successfully parsed ComicInfo.xml for: ${filePath}`, 'debug');
        if (!info) return null;

        const seriesName = info.Series ? String(info.Series).trim() : null;

        // 1. Look directly for standard ComicVine & Metron tags first
        let cvId = info.ComicVineVolumeId ? parseInt(info.ComicVineVolumeId) : null;
        let cvIssueId = info.ComicVineIssueId ? parseInt(info.ComicVineIssueId) : null;
        
        // Ensure Metron IDs are explicitly numeric if pulled from the XML tag
        let metronId: number | null = info.MetronId && !isNaN(Number(info.MetronId)) ? parseInt(info.MetronId) : null;
        let metronIssueId: number | null = info.MetronIssueId && !isNaN(Number(info.MetronIssueId)) ? parseInt(info.MetronIssueId) : null;

        // 2. Fallback to parsing the Web URL if standard tags are missing
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
            
            // Only extract Metron IDs from URLs if they are NUMBERS. Do not extract text slugs.
            if (!metronId) {
                const metronVolMatch = webUrl.match(/metron\.cloud\/series\/(\d+)/i);
                if (metronVolMatch) metronId = parseInt(metronVolMatch[1]);
            }
            
            if (!metronIssueId) {
                const metronIssMatch = webUrl.match(/metron\.cloud\/issue\/(\d+)/i);
                if (metronIssMatch) metronIssueId = parseInt(metronIssMatch[1]);
            }
        }

        let parsedYear = info.Volume ? parseInt(info.Volume) : null;
        if (!parsedYear || isNaN(parsedYear)) {
            parsedYear = info.Year ? parseInt(info.Year) : null;
        }

        const cacheKey = `${seriesName}_${parsedYear || 'unknown'}`;
        // Namespace the resolution cache by provider — a ComicVine volume id and a Metron series id for the
        // same series+year are different numbers and must not alias each other in this shared map.
        const cvCacheKey = `CV:${cacheKey}`;
        const metronCacheKey = `METRON:${cacheKey}`;

        // 3. Dynamic Resolution: If we STILL don't have an ID, we query the APIs using the Series Name
        if (!cvId && cvIssueId) {
            if (seriesName && volumeResolutionCache.has(cvCacheKey)) {
                cvId = volumeResolutionCache.get(cvCacheKey)!.cvId as number;
            } else {
                try {
                    const { prisma } = await import('@/lib/db');
                    const setting = await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } });
                    if (setting?.value) {
                        const { cachedCvGet } = await import('@/lib/metadata/metadata-cache');
                        const cvRes = await cachedCvGet(`https://comicvine.gamespot.com/api/issue/4000-${cvIssueId}/`, {
                            params: { api_key: setting.value, format: 'json', field_list: 'volume' }
                        });
                        
                        if (cvRes.data?.results?.volume?.id) {
                            cvId = parseInt(cvRes.data.results.volume.id);
                            if (seriesName) volumeResolutionCache.set(cvCacheKey, { cvId, timestamp: Date.now() });
                        }
                    }
                } catch (e) {
                    Logger.log(`[Metadata] Failed to resolve Volume ID from Issue URL: ${cvIssueId}`, 'warn');
                }
            }
        } else if (!metronId && metronIssueId && seriesName) {
            // Resolve a Metron SERIES id by name ONLY for files that actually carry Metron evidence (a Metron
            // issue id). Previously this `else if (!metronId && seriesName)` fired for essentially every
            // series-named file lacking a Metron id — including normal ComicVine files — issuing a live Metron
            // search per scanned file and sometimes flipping the resolved source to METRON.
            if (volumeResolutionCache.has(metronCacheKey)) {
                Logger.log(`[Metadata Extractor Debug] Cache HIT for composite key: ${metronCacheKey}`, 'debug');
                metronId = volumeResolutionCache.get(metronCacheKey)!.cvId as number;
            } else {
                try {
                    const { prisma } = await import('@/lib/db');
                    const metronUser = await prisma.systemSetting.findUnique({ where: { key: 'metron_user' } });
                    const metronPass = await prisma.systemSetting.findUnique({ where: { key: 'metron_pass' } });
                    
                    if (metronUser?.value && metronPass?.value) {
                        const { apiClient } = await import('@/lib/api-client');
                        const auth = { username: metronUser.value, password: metronPass.value };
                        
                        // Query Metron using the clean Series Name from the XML
                        const metronRes = await apiClient.get(`https://metron.cloud/api/series/?name=${encodeURIComponent(seriesName)}`, { auth });
                        
                        if (metronRes.data?.results?.length > 0) {
                            // Look for an exact match on BOTH the Name and the Year
                            const exactMatch = metronRes.data.results.find((s: any) => {
                                const nameMatch = (s.name || s.series)?.toLowerCase() === seriesName.toLowerCase();
                                
                                // If we extracted a year from the XML, ensure the Metron series year matches
                                if (parsedYear && s.year_began) {
                                    // Allow a 1-year variance (e.g., Series started Dec 2019, but XML says 2020)
                                    const diff = Math.abs(parseInt(s.year_began) - parsedYear);
                                    return nameMatch && diff <= 1;
                                }
                                
                                return nameMatch;
                            });
                            
                            // Fallback: If no perfect year match, use the first name match. If no name match, use the first result.
                            const fallbackMatch = metronRes.data.results.find((s: any) => (s.name || s.series)?.toLowerCase() === seriesName.toLowerCase());
                            const finalResult = exactMatch || fallbackMatch || metronRes.data.results[0];
                            
                            metronId = parseInt(finalResult.id);
                            Logger.log(`[Metadata] Resolved Metron Series ID ${metronId} from Series Name search (Year Checked: ${parsedYear || 'None'}).`, 'info');
                            volumeResolutionCache.set(metronCacheKey, { cvId: metronId, timestamp: Date.now() });
                        }
                    }
                } catch (e) {
                    Logger.log(`[Metadata] Failed to dynamically resolve Metron Series ID for: ${seriesName}`, 'warn');
                }
            }
        }
        
        const splitList = (str: any) => str ? String(str).split(',').map(s => s.trim()).filter(Boolean) : [];
        const resolvedMetaSource = (metronId || metronIssueId) ? 'METRON' : ((cvId || cvIssueId) ? 'COMICVINE' : 'LOCAL');
        
        // Final fallback: Ensure metadataId preserves the raw extracted number structure (not forced to a string for tests to pass)
        const resolvedMetaId = metronId || cvId || null;
        const resolvedMetaIssueId = metronIssueId || cvIssueId || null;

        return {
            series: seriesName,
            title: info.Title ? String(info.Title).trim() : null,
            universe: info.Universe ? String(info.Universe).trim() : null,
            seriesGroup: info.SeriesGroup ? String(info.SeriesGroup).trim() : null,
            number: info.Number ? String(info.Number).trim() : null,
            publisher: info.Publisher ? String(info.Publisher).trim() : null,
            year: parsedYear,
            summary: info.Summary ? String(info.Summary).trim() : null,
            writers: splitList(info.Writer),
            artists: splitList(info.Penciller),
            coverArtists: splitList(info.CoverArtist),
            colorists: splitList(info.Colorist),
            letterers: splitList(info.Letterer),
            inker: splitList(info.Inker),
            editor: splitList(info.Editor),
            translator: splitList(info.Translator),
            // #199 Call-3 Beta B: the per-issue remainder, converted with the engine scanner's rules
            // (parse/clamp/tri-state) so both ingest legs store identical shapes.
            tags: splitList(info.Tags),
            mainCharacterOrTeam: info.MainCharacterOrTeam ? String(info.MainCharacterOrTeam).trim() : null,
            alternateSeries: info.AlternateSeries ? String(info.AlternateSeries).trim() : null,
            alternateNumber: info.AlternateNumber ? String(info.AlternateNumber).trim() : null,
            alternateCount: (() => { const n = parseInt(String(info.AlternateCount ?? '').trim(), 10); return Number.isNaN(n) ? null : n; })(),
            storyArcNumber: info.StoryArcNumber ? String(info.StoryArcNumber).trim() : null,
            gtin: info.GTIN ? String(info.GTIN).trim() : null,
            notes: info.Notes ? String(info.Notes).trim() : null,
            scanInformation: info.ScanInformation ? String(info.ScanInformation).trim() : null,
            review: info.Review ? String(info.Review).trim() : null,
            blackAndWhite: (() => { const v = String(info.BlackAndWhite ?? '').trim().toLowerCase(); return v === 'yes' ? true : v === 'no' ? false : null; })(),
            communityRating: (() => { const n = Number(String(info.CommunityRating ?? '').trim()); return Number.isFinite(n) && String(info.CommunityRating ?? '').trim() !== '' ? Math.min(5, Math.max(0, n)) : null; })(),
            characters: splitList(info.Characters),
            teams: splitList(info.Teams),
            locations: splitList(info.Locations),
            isManga: (info.Manga === 'Yes' || info.Manga === 'YesAndRightToLeft'),
            mangaTag: info.Manga ? String(info.Manga).trim() : null,
            cvId: cvId,
            cvIssueId: cvIssueId,
            metronId: metronId,
            metadataId: resolvedMetaId,
            metadataSource: resolvedMetaSource,
            metadataIssueId: resolvedMetaIssueId
        };
    } catch (error: any) {
        const isFormatError = error.message && error.message.toLowerCase().includes("invalid or unsupported zip format");
        
        // Suppress log spam for genuine RAR archives or fake CBZs failing the ZIP parser
        if (!filePath.toLowerCase().match(/\.(cbr|rar)$/) && !isFormatError) {
            Logger.log(`[Metadata] Failed to parse ComicInfo in ${filePath}: ${error.message || 'Unknown error'}`, 'error');
        }
        return null;
    }
}