// src/app/komga/api/v1/series/[id]/route.ts — #206 Komga facade: one series (Paperback's
// "manga details": title, status, summary, genres/tags, writers + pencillers, reading direction).
import { authenticateKomga, komgaGuard, komgaJson, komgaText } from '@/lib/komga/auth';
import { findAccessibleSeries, seriesDetail } from '@/lib/komga/data';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    return komgaGuard('series/{id}', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const { id } = await params;
        const found = await findAccessibleSeries(id, auth.libs);
        if (!found.ok) return komgaText(found.status, found.status === 404 ? 'Not Found' : 'Forbidden');
        return komgaJson(await seriesDetail(found.series, auth.user.id));
    });
}
