// src/app/komga/api/v1/libraries/route.ts
//
// #206 — the Komga-compatible facade for Paperback (iOS). Paperback's pre-installed "Paperback"
// source is a Komga REST client: it appends /api/v1 to the Server URL the user enters and sends
// HTTP Basic on every request. With Server URL = http://<omnibus>:3000/komga those requests land
// here. Email = the Omnibus username, Password = a per-user API key (Profile → Manage API Keys).
//
// GET /libraries is what its "Try settings" button calls: 200 → "Successful connection!".
import { prisma } from '@/lib/db';
import { authenticateKomga, komgaGuard, komgaJson } from '@/lib/komga/auth';
import { toLibraryDto } from '@/lib/komga/dto';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    return komgaGuard('libraries', async () => {
        const auth = await authenticateKomga(req);
        if (!auth.ok) return auth.response;
        const libraries = await prisma.library.findMany({
            where: auth.libs === 'ALL' ? {} : { id: { in: auth.libs } },
            orderBy: { name: 'asc' },
        });
        return komgaJson(libraries.map(toLibraryDto));
    });
}
