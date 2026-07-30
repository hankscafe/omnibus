// src/lib/utils/cover-url.ts
//
// Width variants for /api/library/cover: appending &w=<whitelisted> asks the route for a cached
// WebP thumbnail instead of the full stored file (which is often a raw 1-4MB first-page scan).
// Only the proxy route understands the param — absolute provider URLs, data: URIs, and anything
// else pass through untouched. Widths must stay in the route's ALLOWED_WIDTHS whitelist; unknown
// values are ignored server-side (full-size bytes), so drift here fails soft but wastes the win.

/** Library grid/list variant: 8-col grid ≈ 160-230px CSS cells, so 480 covers DPR 2-3 crisply. */
export const COVER_GRID_WIDTH = 480;

export function coverSrc(url: string, width: number): string {
    if (!url.startsWith('/api/library/cover?')) return url;
    return `${url}&w=${width}`;
}
