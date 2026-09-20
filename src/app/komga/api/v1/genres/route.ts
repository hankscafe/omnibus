// src/app/komga/api/v1/genres/route.ts — #206 Komga facade: the "genres" tag section on
// Paperback's homepage. Distinct values of Series.genres across the series the caller can see.
import { prisma } from '@/lib/db';
import { authenticateKomga, komgaGuard, komgaJson } from '@/lib/komga/auth';
import { seriesListWhere } from '@/lib/komga/data';
import { parseJsonList } from '@/lib/komga/dto';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    return komgaGuard('genres', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const rows = await prisma.series.findMany({
            where: seriesListWhere(auth.libs, { search: null, tags: [], genres: [], collectionIds: [], libraryIds: [] }),
            select: { genres: true },
        });
        const distinct = new Set<string>();
        for (const r of rows) for (const g of parseJsonList(r.genres)) distinct.add(g);
        return komgaJson([...distinct].sort((a, b) => a.localeCompare(b)));
    });
}
