// src/lib/metadata-writer.ts
import fs from 'fs-extra';
import path from 'path';
import AdmZip from 'adm-zip';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function writeComicInfo(issueId: string): Promise<boolean> {
    try {
        const issue = await prisma.issue.findUnique({
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
                if (Array.isArray(parsed)) storyArcsList.push(...parsed.filter(a => a !== "NONE"));
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
        const isCvIssue = issue.metadataSource === 'COMICVINE';

        const cvUrl = (isCvSeries && issue.series.metadataId) 
            ? `https://comicvine.gamespot.com/volume/4050-${issue.series.metadataId}/` 
            : '';

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
  <Genre>${escapeXml(genres)}</Genre>
  <StoryArc>${escapeXml(storyArcs)}</StoryArc>
  <Writer>${escapeXml(writers)}</Writer>
  <Penciller>${escapeXml(artists)}</Penciller>
  <Characters>${escapeXml(characters)}</Characters>
  <Web>${escapeXml(cvUrl)}</Web>
  <Manga>${issue.series.isManga ? 'YesAndRightToLeft' : 'No'}</Manga>
  <ComicVineVolumeId>${(isCvSeries && issue.series.metadataId) ? issue.series.metadataId : ''}</ComicVineVolumeId>
  <ComicVineIssueId>${(isCvIssue && issue.metadataId) ? issue.metadataId : ''}</ComicVineIssueId>
</ComicInfo>`;

        const zip = new AdmZip(issue.filePath);
        
        const existingEntry = zip.getEntries().find(e => e.entryName.toLowerCase() === 'comicinfo.xml');
        if (existingEntry) {
            zip.deleteFile(existingEntry.entryName);
        }

        zip.addFile("ComicInfo.xml", Buffer.from(xmlContent, 'utf8'));

        const tmpPath = `${issue.filePath}.tmp`;
        zip.writeZip(tmpPath);
        await fs.move(tmpPath, issue.filePath, { overwrite: true });

        return true;
    } catch (error) {
        Logger.log(`[Writer] Failed to write XML for ${issueId}: ${getErrorMessage(error)}`, 'error');
        return false;
    }
}

function escapeXml(unsafe: string | null) {
    if (!unsafe) return '';
    return unsafe.replace(/[<>&'"]/g, (c) => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
            default: return c;
        }
    });
}

export async function writeSeriesJson(seriesId: string): Promise<boolean> {
    try {
        // 1. Check if the feature is enabled in Settings
        const setting = await prisma.systemSetting.findUnique({ where: { key: 'export_series_json' } });
        if (setting?.value !== 'true') return false;

        const series = await prisma.series.findUnique({
            where: { id: seriesId },
            include: { issues: true }
        });

        if (!series || !series.folderPath || !fs.existsSync(series.folderPath)) {
            return false;
        }

        // 2. Aggregate genres/concepts from all issues in the series
        const allGenres = new Set<string>();
        for (const issue of series.issues) {
            if ((issue as any).genres) {
                try {
                    const parsed = JSON.parse((issue as any).genres);
                    if (Array.isArray(parsed)) {
                        parsed.forEach(g => { if (g !== 'NONE') allGenres.add(g); });
                    }
                } catch(e) {}
            }
        }

        // 3. Build the Komga/Kavita compatible JSON structure
        const cvUrl = (series.metadataSource === 'COMICVINE' && series.metadataId) 
            ? `https://comicvine.gamespot.com/volume/4050-${series.metadataId}/` 
            : '';

        const links = cvUrl ? [{ label: "ComicVine", url: cvUrl }] : [];

        const komgaMetadata = {
            metadata: {
                title: series.name,
                titleSort: series.name,
                status: series.status === 'Ended' ? 'ENDED' : 'ONGOING',
                summary: series.description ? series.description.replace(/(<([^>]+)>)/gi, "").trim() : "",
                publisher: series.publisher || "",
                readingDirection: series.isManga ? 'RIGHT_TO_LEFT' : 'LEFT_TO_RIGHT',
                ageRating: null,
                language: "en",
                genres: Array.from(allGenres),
                tags: [],
                totalBookCount: series.issues.length,
                links: links // <-- NEW: Injects the ComicVine URL
            }
        };

        // 4. Write it to disk
        const jsonPath = path.join(series.folderPath, 'series.json');
        await fs.writeFile(jsonPath, JSON.stringify(komgaMetadata, null, 2), 'utf-8');

        return true;
    } catch (error) {
        Logger.log(`[Writer] Failed to write series.json for ${seriesId}: ${getErrorMessage(error)}`, 'error');
        return false;
    }
}