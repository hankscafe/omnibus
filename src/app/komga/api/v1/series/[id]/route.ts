// src/app/komga/api/v1/series/[id]/route.ts — #206 Komga facade: one series (Paperback's
// "manga details": title, status, summary, genres/tags, writers + pencillers, reading direction).
import { authenticateKomga, komgaGuard, komgaJson, komgaError } from '@/lib/komga/auth';
import { findAccessibleSeries, seriesDetail } from '@/lib/komga/data';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    return komgaGuard('series/{id}', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const { id } = await params;
        const found = await findAccessibleSeries(id, auth.libs);
        if (!found.ok) return komgaError(found.status);
        return komgaJson(await seriesDetail(found.series, auth.user.id));
    });
}

// Any other method on this [id] segment: Next's own 405 has an empty body a client can't parse, so
// answer it the Komga way instead (#206 round 4). (POST /series/list has its own static route.)
export async function POST(req: Request) {
    return komgaError(405, new URL(req.url).pathname.replace(/^\/komga/, ''));
}
