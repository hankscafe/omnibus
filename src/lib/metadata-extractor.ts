import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { Logger } from './logger';

export async function parseComicInfo(filePath: string) {
    if (!filePath.toLowerCase().match(/\.(cbz|zip)$/)) return null;

    try {
        const zip = new AdmZip(filePath);
        const zipEntries = zip.getEntries();
        
        const infoEntry = zipEntries.find(e => e.entryName.toLowerCase() === 'comicinfo.xml');
        if (!infoEntry) return null; 

        const xmlString = infoEntry.getData().toString('utf8');
        const parser = new XMLParser({ ignoreAttributes: false });
        const result = parser.parse(xmlString);

        const info = result.ComicInfo;
        if (!info) return null;

        let cvId = null;
        if (info.Web && typeof info.Web === 'string') {
            const match = info.Web.match(/(?:comicvine\.gamespot\.com|comicvine\.com)\/.*\/4050-(\d+)/i);
            if (match) cvId = parseInt(match[1]);
        }
        
        const splitList = (str: any) => str ? String(str).split(',').map(s => s.trim()).filter(Boolean) : [];

        return {
            series: info.Series ? String(info.Series).trim() : null,
            title: info.Title ? String(info.Title).trim() : null,
            number: info.Number ? String(info.Number).trim() : null,
            publisher: info.Publisher ? String(info.Publisher).trim() : null,
            year: info.Volume ? parseInt(info.Volume) : null,
            summary: info.Summary ? String(info.Summary).trim() : null,
            writers: splitList(info.Writer),
            artists: splitList(info.Penciller),
            characters: splitList(info.Characters),
            isManga: (info.Manga === 'Yes' || info.Manga === 'YesAndRightToLeft'),
            cvId: cvId
        };
    } catch (error) {
        Logger.log(`[Metadata] Failed to parse ComicInfo in ${filePath}`, 'error');
        return null;
    }
}