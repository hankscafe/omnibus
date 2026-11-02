// src/app/komga/opds/v1.2/search/route.ts
//
// #262: the search feed in Komga's shape. The /api/opds handler builds it, and takes the
// shape from this path (lib/opds-flavour.ts).
import { GET as opdsSearch } from '@/app/api/opds/search/route';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
    return opdsSearch(req);
}
