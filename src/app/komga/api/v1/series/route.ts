// src/app/komga/api/v1/series/route.ts — #206 Komga facade: search + browse.
// `?page&size&search=&tag=&genre=&collection_id=&library_id=&sort=titleSort|lastModified,desc`
import { authenticateKomga, komgaGuard, komgaJson } from '@/lib/komga/auth';
import { listSeries } from '@/lib/komga/data';
import { parsePaging, parseSeriesFilters, parseSeriesSort } from '@/lib/komga/query';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    return komgaGuard('series', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const sp = new URL(req.url).searchParams;
        const { page, size } = parsePaging(sp);
        const result = await listSeries({
            libs: auth.libs,
            userId: auth.user.id,
            filters: parseSeriesFilters(sp),
            sort: parseSeriesSort(sp),
            page,
            size,
        });
        return komgaJson(result);
    });
}
