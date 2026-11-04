// src/app/komga/opds/v1.2/series/route.ts
//
// #262: the series list in Komga's shape. The /api/opds handler builds it, and takes the
// shape from this path (lib/opds-flavour.ts).
import { GET as opdsSeriesList } from '@/app/api/opds/series/route';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
    return opdsSeriesList(req);
}
