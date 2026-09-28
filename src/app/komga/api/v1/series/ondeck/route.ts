// src/app/komga/api/v1/series/ondeck/route.ts — #206 Komga facade: "View More" on Paperback's On
// Deck section. The source's getViewMoreItems asks for `/series/<section id>` for every homepage
// section; this answers the series behind the On Deck books (the static segment wins over
// series/[id], whose 404 used to surface as `JSON Parse error: Unexpected identifier "Not"`).
import { authenticateKomga, komgaGuard, komgaJson } from '@/lib/komga/auth';
import { onDeckSeries } from '@/lib/komga/data';
import { parsePaging } from '@/lib/komga/query';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    return komgaGuard('series/ondeck', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const { page, size } = parsePaging(new URL(req.url).searchParams);
        return komgaJson(await onDeckSeries(auth.user.id, auth.libs, page, size));
    });
}
