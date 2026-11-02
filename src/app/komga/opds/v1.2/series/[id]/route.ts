// src/app/komga/opds/v1.2/series/[id]/route.ts
//
// #262: a series' feed in Komga's shape. The /api/opds handler builds it, and takes the
// shape from this path (lib/opds-flavour.ts).
import { GET as opdsSeries } from '@/app/api/opds/series/[id]/route';

export const dynamic = 'force-dynamic';

export function GET(req: Request, context: { params: Promise<{ id: string }> }) {
    return opdsSeries(req, context);
}
