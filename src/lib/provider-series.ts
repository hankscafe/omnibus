// src/lib/provider-series.ts
//
// #257: the series a set of loose collected editions belongs to, picked from the provider rather
// than from the library. A trade's owner usually isn't in the library yet — the admin has the
// trades, not the issues. The series is found by its provider key, or created the way a Smart
// Matcher match files it (same library choice, same manga detection, same folder pattern, same
// "two series never share a folder" rule), but without any file of its own: the provider sync that
// follows brings its description, credits, cover and issue list.
import path from 'path';
import { prisma } from '@/lib/db';
import { detectManga } from '@/lib/manga-detector';
import { folderOwner } from '@/lib/match-collision';
import { serverPathProblem } from '@/lib/utils/paths';
import { ensureLibraryDir } from '@/lib/utils/safe-fs';
import { seriesFolderSegments } from '@/lib/utils/naming';
import { MetronProvider } from '@/lib/metadata/providers/metron';
import { cachedCvGet } from '@/lib/metadata/metadata-cache';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

const PROVIDERS = ['COMICVINE', 'METRON'];

/** The provider's own publisher and start year, for a search result that lacked them (a Metron list
 *  row can carry no publisher) — the folder is filed by them. One call, as match-series makes it;
 *  null on any failure, and the search result's values stand. */
async function providerFacts(source: string, id: string): Promise<{ publisher: string; year: number } | null> {
    try {
        if (source === 'METRON') {
            const d = await new MetronProvider().getSeriesDetails(id);
            return d ? { publisher: d.publisher || '', year: d.year || 0 } : null;
        }
        const key = (await prisma.systemSetting.findUnique({ where: { key: 'cv_api_key' } }))?.value;
        if (!key) return null;
        const res = await cachedCvGet(`https://comicvine.gamespot.com/api/volume/4050-${id}/`, {
            params: { api_key: key, format: 'json', field_list: 'publisher,start_year' },
            headers: { 'User-Agent': 'Omnibus/1.0' },
            timeout: 4000,
        });
        const vol = res.data?.results;
        return vol ? { publisher: vol.publisher?.name || '', year: parseInt(vol.start_year, 10) || 0 } : null;
    } catch (e) {
        Logger.log(`[Provider Series] Couldn't read ${source} series ${id}: ${getErrorMessage(e)}`, 'warn');
        return null;
    }
}

export interface ProviderSeriesRef {
    metadataSource?: unknown;
    metadataId?: unknown;
    name?: unknown;
    year?: unknown;
    publisher?: unknown;
}

export type ProviderSeriesResult =
    | { series: any; created: boolean; error?: undefined }
    | { error: string; status: number; series?: undefined };

export async function findOrCreateProviderSeries(ref: ProviderSeriesRef): Promise<ProviderSeriesResult> {
    const metadataSource = String(ref?.metadataSource ?? '').trim().toUpperCase();
    const metadataId = String(ref?.metadataId ?? '').trim();
    if (!PROVIDERS.includes(metadataSource) || !/^\d+$/.test(metadataId)) {
        return { error: 'Pick the series from ComicVine or Metron.', status: 400 };
    }

    const existing = await prisma.series.findUnique({ where: { metadataSource_metadataId: { metadataSource, metadataId } } });
    if (existing) return { series: existing, created: false };

    // The search result the admin picked carries these; the provider sync after the attach corrects them.
    const name = String(ref?.name ?? '').trim();
    let year = parseInt(String(ref?.year ?? ''), 10) || 0;
    let publisherRaw = String(ref?.publisher ?? '').trim();
    if (!name) return { error: 'The picked series has no name.', status: 400 };
    if (!publisherRaw || publisherRaw === 'Unknown' || publisherRaw === 'Other' || !year) {
        const facts = await providerFacts(metadataSource, metadataId);
        if (facts?.publisher && (!publisherRaw || publisherRaw === 'Unknown' || publisherRaw === 'Other')) publisherRaw = facts.publisher;
        if (facts?.year && !year) year = facts.year;
    }
    const publisher = publisherRaw && publisherRaw !== 'Unknown' ? publisherRaw : 'Other';

    const libraries = await prisma.library.findMany();
    const isManga = await detectManga({ name, publisher: { name: publisher }, year });
    const targetLib = (isManga
        ? libraries.find(l => l.isDefault && l.isManga) || libraries.find(l => l.isManga)
        : libraries.find(l => l.isDefault && !l.isManga) || libraries.find(l => !l.isManga)) || libraries[0];
    if (!targetLib) return { error: 'No libraries configured.', status: 400 };
    const rootProblem = serverPathProblem(targetLib.path);
    if (rootProblem) {
        return { error: `Root Path of library "${targetLib.name}": ${rootProblem} Change it in Settings > Library & Files.`, status: 400 };
    }

    const setting = await prisma.systemSetting.findUnique({ where: { key: 'folder_naming_pattern' } });
    const folderPattern = setting?.value || '{Publisher}/{Series} ({Year})';
    const segments = seriesFolderSegments(folderPattern, { publisher, series: name, seriesYear: year });
    if (!segments) {
        return { error: "The folder naming pattern doesn't produce a folder inside the library for this series. Check Settings > Library & Files.", status: 400 };
    }
    const folderPath = path.join(targetLib.path, ...segments).replace(/\\/g, '/');

    const owner = await folderOwner(folderPath, []);
    if (owner) {
        const label = owner.year ? `${owner.name} (${owner.year})` : owner.name;
        return {
            error: `"${name}" would be filed as "${path.basename(folderPath)}", which already belongs to ${label}. Pick ${label} from your library instead.`,
            status: 409,
        };
    }

    // The folder first: a series row must never point at a folder that couldn't be made.
    await ensureLibraryDir(folderPath);
    const series = await prisma.series.create({
        data: {
            cvId: metadataSource === 'COMICVINE' ? parseInt(metadataId, 10) : null,
            metadataId,
            metadataSource,
            matchState: 'MATCHED',
            name,
            year,
            publisher,
            folderPath,
            isManga,
            status: 'Ongoing',
            libraryId: targetLib.id,
        },
    });
    return { series, created: true };
}
