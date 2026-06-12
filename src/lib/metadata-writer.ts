// src/lib/metadata-writer.ts
import fs from 'fs-extra';
import path from 'path';
import AdmZip from 'adm-zip';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { escapeXml } from '@/lib/utils/xml';

export async function writeComicInfo(issueId: string): Promise<boolean> {
    // Declare 'issue' outside the try block so it can be accessed in the catch block for logging
    let issue: any = null; 

    try {
        issue = await prisma.issue.findUnique({
            where: { id: issueId },
            include: { series: true }
        });

        if (!issue || !issue.filePath || !fs.existsSync(issue.filePath)) return false;
        if (!issue.filePath.toLowerCase().endsWith('.cbz')) {
            Logger.log(`[Writer] Skipping ${issue.name} - Not a CBZ file`, 'warn');
            return false;
        }

        const writers = issue.writers ? JSON.parse(issue.writers).join(', ') : '';
        const artists = issue.artists ? JSON.parse(issue.artists).join(', ') : '';
        const characters = issue.characters ? JSON.parse(issue.characters).join(', ') : '';

        const genreList: string[] = [];
        if ((issue as any).genres) {
            try { genreList.push(...JSON.parse((issue as any).genres)); } catch(e) {}
        }
        if (issue.series.isManga && !genreList.includes('Manga')) {
            genreList.push('Manga');
        }
        const genres = genreList.join(', ');

        const storyArcsList: string[] = [];
        if ((issue as any).storyArcs) {
            try { 
                const parsed = JSON.parse((issue as any).storyArcs);
                if (Array.isArray(parsed)) storyArcsList.push(...parsed.filter((a: string) => a !== "NONE"));
            } catch(e) {}
        }
        const storyArcs = storyArcsList.join(', ');

        let year = issue.series.year?.toString() || '';
        let month = '';
        let day = '';
        if (issue.releaseDate) {
            const parts = issue.releaseDate.split('-');
            year = parts[0] || year;
            month = parts[1] || '';
            day = parts[2] || '';
        }

        const isCvSeries = issue.series.metadataSource === 'COMICVINE';
        const isMetronSeries = issue.series.metadataSource === 'METRON';
        const isCvIssue = issue.metadataSource === 'COMICVINE';
        const isMetronIssue = issue.metadataSource === 'METRON';

        let webUrl = '';
        if (isMetronIssue && issue.metadataId) webUrl = `https://metron.cloud/issue/${issue.metadataId}/`;
        else if (isMetronSeries && issue.series.metadataId) webUrl = `https://metron.cloud/series/${issue.series.metadataId}/`;
        else if (isCvIssue && issue.metadataId) webUrl = `https://comicvine.gamespot.com/issue/4000-${issue.metadataId}/`;
        else if (isCvSeries && issue.series.metadataId) webUrl = `https://comicvine.gamespot.com/volume/4050-${issue.series.metadataId}/`;

        const cleanDesc = (issue.description || '').replace(/<[^>]*>?/gm, '').trim();

        const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Series>${escapeXml(issue.series.name)}</Series>
  <Title>${escapeXml(issue.name)}</Title>
  <Number>${escapeXml(issue.number)}</Number>
  <Volume>${issue.series.year || ''}</Volume>
  <Summary>${escapeXml(cleanDesc)}</Summary>
  <Year>${year}</Year>
  <Month>${month}</Month>
  <Day>${day}</Day>
  <Publisher>${escapeXml(issue.series.publisher)}</Publisher>
  <Universe>${escapeXml(issue.universe || issue.series.universe || '')}</Universe> <!-- ADD THIS LINE -->
  <Genre>${escapeXml(genres)}</Genre>
  <StoryArc>${escapeXml(storyArcs)}</StoryArc>
  <Writer>${escapeXml(writers)}</Writer>
  <Penciller>${escapeXml(artists)}</Penciller>
  <Characters>${escapeXml(characters)}</Characters>
  <Web>${escapeXml(webUrl)}</Web>
  <Manga>${issue.series.isManga ? 'YesAndRightToLeft' : 'No'}</Manga>
  <ComicVineVolumeId>${(isCvSeries && issue.series.metadataId) ? issue.series.metadataId : ''}</ComicVineVolumeId>
  <ComicVineIssueId>${(isCvIssue && issue.metadataId) ? issue.metadataId : ''}</ComicVineIssueId>
  <MetronId>${(isMetronSeries && issue.series.metadataId) ? issue.series.metadataId : ''}</MetronId>
  <MetronIssueId>${(isMetronIssue && issue.metadataId) ? issue.metadataId : ''}</MetronIssueId>
</ComicInfo>`;

        Logger.log(`[Metadata Writer Debug] Generated XML content for: ${issue.series.name} #${issue.number}`, 'debug');
        const zip = new AdmZip(issue.filePath);
        
        const existingEntry = zip.getEntries().find(e => e.entryName.toLowerCase() === 'comicinfo.xml');
        if (existingEntry) {
            zip.deleteFile(existingEntry.entryName);
        }

        zip.addFile("ComicInfo.xml", Buffer.from(xmlContent, 'utf8'));

        const tmpPath = `${issue.filePath}.tmp`;
        zip.writeZip(tmpPath);
        await fs.move(tmpPath, issue.filePath, { overwrite: true });

        Logger.log(`[Metadata Writer Debug] Successfully wrote ComicInfo.xml to ${issue.filePath}`, 'debug');
        return true;
    } catch (error) {
        // We optionally use a fallback to issueId just in case the issue lookup failed entirely
        const issueIdentifier = issue ? `${issue.series.name} #${issue.number}` : issueId;
        Logger.log(`[Writer] Failed to write XML for ${issueIdentifier}: ${getErrorMessage(error)}`, 'error');
        return false;
    }
}

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

// Formats a "YYYY-MM-DD" release date as "Month YYYY" (e.g. "March 1999")
function formatMonthYear(dateStr: string): string {
    const [year, month] = dateStr.split('-');
    const monthIdx = parseInt(month, 10) - 1;
    return monthIdx >= 0 && monthIdx <= 11 ? `${MONTH_NAMES[monthIdx]} ${year}` : year;
}

export async function writeSeriesJson(seriesId: string): Promise<boolean> {
    try {
        const setting = await prisma.systemSetting.findUnique({ where: { key: 'export_series_json' } });
        if (setting?.value !== 'true') return false;

        const series = await prisma.series.findUnique({
            where: { id: seriesId },
            include: { issues: true }
        });

        if (!series || !series.folderPath || !fs.existsSync(series.folderPath)) {
            return false;
        }

        const jsonPath = path.join(series.folderPath, 'series.json');

        // Never clobber a series.json Omnibus didn't create (e.g. a curated Mylar
        // library). Ownership is tracked in the DB; the one exception is our own
        // legacy Komga-style format from before ownership tracking existed, which
        // is recognizable (no version key, Komga-only fields) and safe to upgrade.
        if (!series.seriesJsonWritten && fs.existsSync(jsonPath)) {
            let isLegacyOmnibusFile = false;
            try {
                const existing = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));
                isLegacyOmnibusFile = !existing.version && existing.metadata?.readingDirection !== undefined;
            } catch (e) { /* unreadable or not JSON — treat as foreign */ }

            if (!isLegacyOmnibusFile) {
                Logger.log(`[Writer] Skipping series.json for ${series.name}: the existing file was not created by Omnibus.`, 'warn');
                return false;
            }
        }

        // comicid is the ComicVine volume ID per the Mylar spec; never substitute a Metron ID
        let comicid: number | null = series.cvId ?? null;
        if (comicid === null && series.metadataSource === 'COMICVINE' && series.metadataId) {
            const parsed = parseInt(series.metadataId, 10);
            if (!isNaN(parsed)) comicid = parsed;
        }

        const isEnded = series.status === 'Ended';

        const releaseDates = series.issues
            .map(i => i.releaseDate)
            .filter((d): d is string => !!d)
            .sort();

        let publicationRun = '';
        if (releaseDates.length > 0) {
            const start = formatMonthYear(releaseDates[0]);
            const end = isEnded ? formatMonthYear(releaseDates[releaseDates.length - 1]) : 'Present';
            publicationRun = `${start} - ${end}`;
        } else if (series.year) {
            publicationRun = isEnded ? `${series.year}` : `${series.year} - Present`;
        }

        const rawDesc = series.description || '';
        const descriptionText = rawDesc.replace(/(<([^>]+)>)/gi, '').trim();
        const descriptionFormatted = rawDesc
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/(<([^>]+)>)/gi, '')
            .trim();

        // comic_image prefers the remote ComicVine/Metron cover URL. When that isn't
        // known, fall back to the locally cached cover served through Omnibus (made
        // absolute via NEXTAUTH_URL) so the field is never empty when a cover exists.
        let comicImage: string | null = series.remoteCoverUrl || null;
        if (!comicImage && series.coverUrl) {
            if (series.coverUrl.startsWith('http')) {
                comicImage = series.coverUrl;
            } else {
                const baseUrl = (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/$/, '');
                comicImage = series.coverUrl.startsWith('/')
                    ? `${baseUrl}${series.coverUrl}`
                    : `${baseUrl}/api/library/cover?path=${encodeURIComponent(series.coverUrl)}`;
            }
        }

        // Mylar series.json schema v1.0.2 — the format Komga, Kavita, and Mylar consume.
        // Unknown values are null, never "": Komga ignores nulls but chokes on blanks.
        // https://github.com/mylar3/mylar3/wiki/series.json-schema-(version-1.0.2)
        const seriesJson = {
            version: '1.0.2',
            metadata: {
                type: 'comicSeries',
                publisher: series.publisher || null,
                imprint: null,
                name: series.name,
                comicid: comicid,
                year: series.year,
                description_text: descriptionText || null,
                description_formatted: descriptionFormatted || null,
                volume: null,
                booktype: series.bookType || 'Print',
                age_rating: null,
                collects: null,
                comic_image: comicImage,
                total_issues: series.issues.length,
                publication_run: publicationRun || null,
                status: isEnded ? 'Ended' : 'Continuing'
            }
        };

        Logger.log(`[Metadata Writer Debug] Exporting Mylar-spec series.json to: ${jsonPath}`, 'debug');
        await fs.writeFile(jsonPath, JSON.stringify(seriesJson, null, 2), 'utf-8');

        // Claim ownership so future runs keep this file updated
        if (!series.seriesJsonWritten) {
            await prisma.series.update({
                where: { id: series.id },
                data: { seriesJsonWritten: true }
            });
        }
        return true;
    } catch (error) {
        Logger.log(`[Writer] Failed to write series.json for ${seriesId}: ${getErrorMessage(error)}`, 'error');
        return false;
    }
}