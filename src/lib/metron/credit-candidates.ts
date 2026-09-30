// The per-issue Metron detail pass's candidates: one /issue/{id}/ request each for the writers,
// artists, characters, arcs and story title the issue list doesn't carry (Metron beta 4).
import { prisma } from '@/lib/db';

/**
 * Prisma filter for the issues the detail pass fetches for a series: Metron issues with a file on disk
 * that don't have their details yet (not DEEP_SYNCED) and aren't hand-edited. A missing issue gets its
 * details when it's downloaded or opened. Engine twin: metadata.rs DETAIL_PASS_CANDIDATES - the
 * Refresh button's count ("about N Metron requests") must match what the pass fetches.
 */
export function metronCreditCandidatesWhere(seriesId: string) {
    return {
        seriesId,
        metadataSource: 'METRON',
        metadataId: { not: null },
        matchState: { not: 'DEEP_SYNCED' },
        hasCustomMetadata: false,
        AND: [{ filePath: { not: null } }, { filePath: { not: '' } }],
    };
}

/** Settings → Metadata "Metron: Fetch Per-Issue Credits" (metron_detail_credits), off by default. */
export async function metronDetailCreditsEnabled(): Promise<boolean> {
    const row = await prisma.systemSetting.findUnique({ where: { key: 'metron_detail_credits' } });
    return row?.value === 'true';
}
