// src/app/komga/api/v2/series/[id]/read-progress/tachiyomi/route.ts — #206 Komga facade, for
// Paperback's 0.9 "Komga" source: where the reader is up to in a series (Komga's
// TachiyomiReadProgressV2Dto). The source reads lastReadContinuousNumberSort to mark every chapter
// up to it as read, for its progress tracking and its manage-progress form.
import { authenticateKomga, komgaGuard, komgaJson, komgaError } from '@/lib/komga/auth';
import { findAccessibleSeries, tachiyomiProgress } from '@/lib/komga/data';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    return komgaGuard('v2 series/{id}/read-progress/tachiyomi', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const { id } = await params;
        const found = await findAccessibleSeries(id, auth.libs);
        if (!found.ok) return komgaError(found.status);
        return komgaJson(await tachiyomiProgress(found.series.id, auth.user.id));
    });
}
