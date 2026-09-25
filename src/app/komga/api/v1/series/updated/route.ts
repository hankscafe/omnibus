// src/app/komga/api/v1/series/updated/route.ts — #206 Komga facade: "Recently updated series"
// (homepage section, View More, and the source's update check, which walks this list until it
// meets a metadata.lastModified older than its last run). The series that most recently gained a
// file first (Issue.fileAddedAt) — not Series.updatedAt, which every Series Monitor pass bumps, so
// the list said nothing about new issues and Paperback flagged series that had none.
import { authenticateKomga, komgaGuard, komgaJson } from '@/lib/komga/auth';
import { listSeries } from '@/lib/komga/data';
import { parsePaging, parseSeriesFilters } from '@/lib/komga/query';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    return komgaGuard('series/updated', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const sp = new URL(req.url).searchParams;
        const { page, size } = parsePaging(sp);
        const result = await listSeries({
            libs: auth.libs,
            userId: auth.user.id,
            filters: parseSeriesFilters(sp),
            sort: { field: 'fileAddedAt', dir: 'desc' },
            page,
            size,
        });
        return komgaJson(result);
    });
}
