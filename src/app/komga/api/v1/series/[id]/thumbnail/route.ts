// src/app/komga/api/v1/series/[id]/thumbnail/route.ts — #206 Komga facade: the series cover,
// served in-process by the cover route (see lib/komga/cover.ts for why not a redirect).
import { prisma } from '@/lib/db';
import { canAccessLibraryId } from '@/lib/library-access';
import { authenticateKomga, komgaGuard, komgaText } from '@/lib/komga/auth';
import { coverQueryFor, delegateCover } from '@/lib/komga/cover';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    return komgaGuard('series/{id}/thumbnail', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const { id } = await params;
        const series = await prisma.series.findUnique({
            where: { id },
            select: { id: true, libraryId: true, folderPath: true, coverUrl: true },
        });
        if (!series) return komgaText(404, 'Not Found');
        if (!canAccessLibraryId(auth.libs, series.libraryId)) return komgaText(403, 'Forbidden');
        // No stored cover → the series folder (the cover route picks cover.jpg & friends there).
        return delegateCover(req, coverQueryFor(series.coverUrl) ?? { path: series.folderPath });
    });
}
