// src/app/komga/opds/v1.2/catalog/route.ts
//
// #262: the catalog root in Komga's shape. The /api/opds handler builds it, and takes the
// shape from this path (lib/opds-flavour.ts).
import { GET as opdsCatalog } from '@/app/api/opds/route';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
    return opdsCatalog(req);
}
