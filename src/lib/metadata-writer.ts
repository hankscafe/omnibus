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

        // 1. Parse JSON arrays back into strings
        const writers = issue.writers ? JSON.parse(issue.writers).join(', ') : '';
        const artists = issue.artists ? JSON.parse(issue.artists).join(', ') : '';
        const characters = issue.characters ? JSON.parse(issue.characters).join(', ') : '';

        // 2. Handle Genres
        const genreList: string[] = [];
        if ((issue as any).genres) {
            try { genreList.push(...JSON.parse((issue as any).genres)); } catch(e) {}
        }
        if (issue.series.isManga && !genreList.includes('Manga')) {
            genreList.push('Manga');
        }
        const genres = genreList.join(', ');

        // Parse Story Arcs (Filter out our hidden NONE flag)
        const storyArcsList: string[] = [];
        if ((issue as any).storyArcs) {
            try { 
                const parsed = JSON.parse((issue as any).storyArcs);
                if (Array.isArray(parsed)) storyArcsList.push(...parsed.filter(a => a !== "NONE"));
            } catch(e) {}
        }
        const storyArcs = storyArcsList.join(', ');

        // 3. Extract specific date parts
        let year = issue.series.year?.toString() || '';
        let month = '';
        let day = '';
        if (issue.releaseDate) {
            const parts = issue.releaseDate.split('-');
            year = parts[0] || year;
            month = parts[1] || '';
            day = parts[2] || '';
        }

        const cvUrl = issue.series.cvId > 0 
            ? `https://comicvine.gamespot.com/volume/4050-${issue.series.cvId}/` 
            : '';

        // 4. Build the ComicInfo.xml string
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
  <ComicVineVolumeId>${issue.series.cvId > 0 ? issue.series.cvId : ''}</ComicVineVolumeId>
  <ComicVineIssueId>${issue.cvId > 0 ? issue.cvId : ''}</ComicVineIssueId>
</ComicInfo>`;

        // 5. Safely write to the CBZ using AdmZip
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