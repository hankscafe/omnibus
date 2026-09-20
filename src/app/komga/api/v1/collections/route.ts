// src/app/komga/api/v1/collections/route.ts — #206 Komga facade: the caller's own collections as
// Komga collections (a search filter in Paperback; the section hides itself when there are ≤ 1).
import { prisma } from '@/lib/db';
import { authenticateKomga, komgaGuard, komgaJson } from '@/lib/komga/auth';
import { komgaPage, toCollectionDto } from '@/lib/komga/dto';
import { parsePaging } from '@/lib/komga/query';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    return komgaGuard('collections', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const { page, size } = parsePaging(new URL(req.url).searchParams, 100);
        const rows = await prisma.collection.findMany({ where: { userId: auth.user.id }, orderBy: { name: 'asc' } });
        const slice = rows.slice(page * size, page * size + size);
        return komgaJson(komgaPage(slice.map(toCollectionDto), page, size, rows.length));
    });
}
