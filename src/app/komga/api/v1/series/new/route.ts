// src/app/komga/api/v1/series/new/route.ts — #206 Komga facade: "Recently added series"
// (Paperback's homepage section + its View More). Newest-created first, whatever `sort` says.
import { authenticateKomga, komgaGuard, komgaJson } from '@/lib/komga/auth';
import { listSeries } from '@/lib/komga/data';
import { parsePaging, parseSeriesFilters } from '@/lib/komga/query';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    return komgaGuard('series/new', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const sp = new URL(req.url).searchParams;
        const { page, size } = parsePaging(sp);
        const result = await listSeries({
            libs: auth.libs,
            userId: auth.user.id,
            filters: parseSeriesFilters(sp),
            sort: { field: 'createdAt', dir: 'desc' },
            page,
            size,
        });
        return komgaJson(result);
    });
}
