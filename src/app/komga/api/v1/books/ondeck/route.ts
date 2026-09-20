// src/app/komga/api/v1/books/ondeck/route.ts — #206 Komga facade: Paperback's optional
// "On Deck" section — the next unread book in each series the caller recently finished one in.
import { authenticateKomga, komgaGuard, komgaJson } from '@/lib/komga/auth';
import { onDeckBooks } from '@/lib/komga/data';
import { parsePaging } from '@/lib/komga/query';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    return komgaGuard('books/ondeck', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const { size } = parsePaging(new URL(req.url).searchParams);
        return komgaJson(await onDeckBooks(auth.user.id, auth.libs, size));
    });
}
