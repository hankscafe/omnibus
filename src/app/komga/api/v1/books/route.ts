// src/app/komga/api/v1/books/route.ts — #206 Komga facade: Paperback's optional "Continue
// Reading" section: `?sort=readProgress.readDate,desc&read_status=IN_PROGRESS&page=0&size=20`.
// Other read_status values are not something the source asks for; they answer an empty page.
import { authenticateKomga, komgaGuard, komgaJson } from '@/lib/komga/auth';
import { inProgressBooks } from '@/lib/komga/data';
import { komgaPage } from '@/lib/komga/dto';
import { parsePaging, parseReadStatus } from '@/lib/komga/query';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    return komgaGuard('books', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const sp = new URL(req.url).searchParams;
        const { page, size } = parsePaging(sp);
        if (parseReadStatus(sp) !== 'IN_PROGRESS') return komgaJson(komgaPage([], page, size, 0));
        return komgaJson(await inProgressBooks(auth.user.id, auth.libs, page, size));
    });
}
