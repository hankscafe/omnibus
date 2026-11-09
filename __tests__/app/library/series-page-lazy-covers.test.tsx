// @vitest-environment jsdom
// The series page lists every issue at once - downloaded, missing, specials, collected editions - with
// no pages, so a long series used to ask for every cover the moment it opened (and an issue cover
// that isn't cached yet is rendered from the archive by the engine first). The list covers now load
// lazily: the browser fetches each one as it nears the screen. The header cover stays eager - it's
// the first thing on screen.
//
// jsdom doesn't lazy-load anything, so these pin the attributes the browser acts on.
import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ok, stubFetchRouter } from '../../helpers/fetch';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: { user: { id: 'admin_1', role: 'ADMIN' } }, status: 'authenticated' }),
}));
const params = new URLSearchParams('path=/lib/Image/Saga (2012)');
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
    useSearchParams: () => params,
}));

global.ResizeObserver = vi.fn().mockImplementation(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }));
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

import SeriesPage from '@/app/library/series/page';

const cover = (id: string) => `/api/library/cover?issue=${id}`;
const SERIES = {
    id: 'series-1', seriesName: 'Saga', coverUrl: '/api/library/cover?series=series-1', cvId: 4242, metadataId: '4242',
    metadataSource: 'COMICVINE', path: '/lib/Image/Saga (2012)', publisher: 'Image', year: 2012, matchState: 'MATCHED',
    downloadedIssues: [
        { id: 'd1', number: '1', name: 'Saga #1', coverUrl: cover('d1'), fullPath: '/lib/Image/Saga (2012)/Saga #001.cbz', isRead: false, readProgress: 0, matchState: 'MATCHED', metadataId: '9001' },
        { id: 'd2', number: '2', name: 'Saga #2', coverUrl: cover('d2'), fullPath: '/lib/Image/Saga (2012)/Saga #002.cbz', isRead: false, readProgress: 0, matchState: 'MATCHED', metadataId: '9002' },
    ],
    missingIssues: [
        { id: 'm3', number: '3', name: 'Saga #3', coverUrl: 'https://comicvine.gamespot.com/a/uploads/m3.jpg', metadataId: '9003' },
    ],
    specials: [{ id: 's1', number: '1', name: 'Saga Special', coverUrl: cover('s1'), fullPath: '/lib/Image/Saga (2012)/Saga Special.cbz' }],
    missingSpecials: [],
    collectedEditions: [{ id: 'c1', number: '1', name: 'Saga Vol. 1', coverUrl: cover('c1'), fullPath: '/lib/Image/Saga (2012)/Saga Vol. 1.cbz', coversIssues: '1-6' }],
    missingCollectedEditions: [],
    duplicates: [],
    coveredIssues: [],
};
const LIST_COVERS = [cover('d1'), cover('d2'), 'https://comicvine.gamespot.com/a/uploads/m3.jpg', cover('s1'), cover('c1')];

// The list covers on screen (the header shows the open issue's cover under alt="Cover").
const listCovers = () => Array.from(document.querySelectorAll('img'))
    .filter(img => img.getAttribute('alt') !== 'Cover' && LIST_COVERS.includes(img.getAttribute('src') ?? ''));

const renderPage = async () => {
    await act(async () => { render(<SeriesPage />); });
    await act(async () => { await new Promise(r => setTimeout(r, 25)); });
};

describe('Series page: the list covers load lazily, the header cover does not', () => {
    beforeEach(() => {
        toast.mockClear();
        localStorage.clear();
        stubFetchRouter([
            ['/api/library/series?', () => ok(SERIES)],
            ['/api/admin/config', () => ok({ settings: [] })],
            ['/api/reviews', () => ok([])],
        ]);
    });

    it('grid view: every downloaded, missing, special and collected cover is lazy', async () => {
        await renderPage();

        const imgs = listCovers();
        expect(imgs.map(i => i.getAttribute('src')).sort()).toEqual([...LIST_COVERS].sort());
        for (const img of imgs) {
            expect(img).toHaveAttribute('loading', 'lazy');
            expect(img).toHaveAttribute('decoding', 'async');
        }
    });

    it('list view: the downloaded and missing rows are lazy too', async () => {
        localStorage.setItem('omnibus-series-view', 'list');
        await renderPage();

        const rows = listCovers().filter(img => img.getAttribute('src') === cover('d1') || img.getAttribute('src')?.endsWith('m3.jpg'));
        expect(rows).toHaveLength(2);
        for (const img of rows) {
            expect(img).toHaveAttribute('loading', 'lazy');
            expect(img).toHaveAttribute('decoding', 'async');
        }
    });

    it('the header cover loads at once', async () => {
        await renderPage();

        const header = screen.getByAltText('Cover');
        expect(header).not.toHaveAttribute('loading', 'lazy');
    });
});
