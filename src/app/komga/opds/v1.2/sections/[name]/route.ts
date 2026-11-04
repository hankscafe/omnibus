// src/app/komga/opds/v1.2/sections/[name]/route.ts
//
// #262: one of the catalog root's sections in Komga's shape. The /api/opds handler builds it, and takes the
// shape from this path (lib/opds-flavour.ts).
import { GET as opdsSection } from '@/app/api/opds/sections/[name]/route';

export const dynamic = 'force-dynamic';

export function GET(req: Request, context: { params: Promise<{ name: string }> }) {
    return opdsSection(req, context);
}
