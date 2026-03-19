import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

export async function parseComicInfo(filePath: string) {
    // Note: Pure Node.js cannot easily read .cbr (RAR) files without OS-level binaries.
    // This will process .cbz and .zip files, which make up 90%+ of modern digital comics.
    if (!filePath.toLowerCase().match(/\.(cbz|zip)$/)) return null;

    try {
        const zip = new AdmZip(filePath);
        const zipEntries = zip.getEntries();
        
        // Find the ComicInfo.xml file (ignoring case)
        const infoEntry = zipEntries.find(e => e.entryName.toLowerCase() === 'comicinfo.xml');

        if (!infoEntry) return null; // No embedded metadata found

        // Extract and parse the XML
        const xmlString = infoEntry.getData().toString('utf8');
        const parser = new XMLParser({ ignoreAttributes: false });
        const result = parser.parse(xmlString);

        const info = result.ComicInfo;
        if (!info) return null;

        // Magic Trick: Mylar and ComicRack often embed the ComicVine URL in the <Web> tag.
        // We can use regex to extract the exact ID so we never mismatch!
        let cvId = null;
        if (info.Web && typeof info.Web === 'string') {
            const match = info.Web.match(/(?:comicvine\.gamespot\.com|comicvine\.com)\/.*\/4050-(\d+)/i);
            if (match) cvId = parseInt(match[1]);
        }

        return {
            series: info.Series ? String(info.Series).trim() : null,
            publisher: info.Publisher ? String(info.Publisher).trim() : null,
            year: info.Volume ? parseInt(info.Volume) : null,
            summary: info.Summary ? String(info.Summary).trim() : null,
            isManga: (info.Manga === 'Yes' || info.Manga === 'YesAndRightToLeft'),
            cvId: cvId
        };
    } catch (error) {
        Logger.log(`[Metadata] Failed to parse ComicInfo in ${filePath}`, 'error');
        return null;
    }
}