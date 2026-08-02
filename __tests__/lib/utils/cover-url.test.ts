// coverSrc must only decorate the proxy route — absolute provider URLs, data: URIs (used by lab
// seeds), and non-cover API paths pass through untouched, or the browser would request nonsense.
import { describe, it, expect } from 'vitest';
import { coverSrc, COVER_GRID_WIDTH } from '@/lib/utils/cover-url';

describe('coverSrc', () => {
    it('appends the width to proxy cover URLs', () => {
        expect(coverSrc('/api/library/cover?path=%2Fdata%2Fcomics%2FSaga', 480))
            .toBe('/api/library/cover?path=%2Fdata%2Fcomics%2FSaga&w=480');
    });

    it('decorates issueId proxy URLs too (the route ignores w there, harmlessly)', () => {
        expect(coverSrc('/api/library/cover?issueId=abc', 480))
            .toBe('/api/library/cover?issueId=abc&w=480');
    });

    it('preserves existing extra params like the &v= cache-buster', () => {
        expect(coverSrc('/api/library/cover?path=x&v=123', 480))
            .toBe('/api/library/cover?path=x&v=123&w=480');
    });

    it('passes absolute URLs and data URIs through untouched', () => {
        expect(coverSrc('https://comicvine.gamespot.com/a/cover.jpg', 480))
            .toBe('https://comicvine.gamespot.com/a/cover.jpg');
        expect(coverSrc('data:image/svg+xml;base64,abcd', 480))
            .toBe('data:image/svg+xml;base64,abcd');
    });

    it('exports a whitelisted grid width', () => {
        // Must stay inside the route's ALLOWED_WIDTHS whitelist or the grid silently loses the win.
        expect([160, 320, 480, 640, 1024]).toContain(COVER_GRID_WIDTH);
    });
});
