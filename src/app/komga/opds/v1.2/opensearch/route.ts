// src/app/komga/opds/v1.2/opensearch/route.ts
//
// #262: the OpenSearch description in Komga's shape. The /api/opds handler builds it, and takes the
// shape from this path (lib/opds-flavour.ts).
import { GET as opdsOpenSearch } from '@/app/api/opds/opensearch/route';

export const dynamic = 'force-dynamic';

export function GET(req: Request) {
    return opdsOpenSearch(req);
}
