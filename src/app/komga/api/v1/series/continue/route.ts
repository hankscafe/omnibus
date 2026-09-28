// src/app/komga/api/v1/series/continue/route.ts — #206 Komga facade: "View More" on Paperback's
// Continue Reading section. The source's getViewMoreItems asks for `/series/<section id>` for
// every homepage section; this answers each series with an unfinished book, most recently read
// first (the static segment wins over series/[id], whose 404 used to surface as
// `JSON Parse error: Unexpected identifier "Not"`).
import { authenticateKomga, komgaGuard, komgaJson } from '@/lib/komga/auth';
import { inProgressSeries } from '@/lib/komga/data';
import { parsePaging } from '@/lib/komga/query';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    return komgaGuard('series/continue', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const { page, size } = parsePaging(new URL(req.url).searchParams);
        return komgaJson(await inProgressSeries(auth.user.id, auth.libs, page, size));
    });
}
