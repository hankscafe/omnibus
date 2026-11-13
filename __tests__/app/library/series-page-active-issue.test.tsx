// @vitest-environment jsdom
// The series page's selected issue (lint batch 3h, v1.4.11-beta.037): the detail panel shows the shelf row,
// topped up from GET /api/library/issue with the credits and the description the shelf rows don't carry;
// Mark Read / Unread on that issue updates the panel's Read button; and the Match Series dialog sorts by year
// (Metron's are numbers, ComicVine's text) and matches by the result's id. These pin what the page does, so
// the type pass couldn't change it.
import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ok, stubFetchRouter } from '../../helpers/fetch';

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
// One object, like next-auth's own: the reviews effect re-runs whenever the session object changes.
const sessionState = vi.hoisted(() => ({ data: { user: { id: 'u1', role: 'ADMIN' } }, status: 'authenticated' }));
vi.mock('next-auth/react', () => ({ useSession: () => sessionState }));
const params = new URLSearchParams('path=/lib/Image/Saga (2012)');
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
    useSearchParams: () => params,
}));

// A class: Radix's popper constructs one when the Match dialog's sort menu opens.
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

import SeriesPage from '@/app/library/series/page';

const FOLDER = '/lib/Image/Saga (2012)';
const issue = (id: string, n: string, over: Record<string, unknown> = {}) => ({
    id, cvId: 9000 + Number(n), name: `Saga #${n}`, isAnnual: false, isSpecial: false, specialName: null,
    attachedVolumeId: null, attachmentName: null, releaseDate: null, isCollected: false, collectionName: null, coversIssues: null,
    parsedNum: Number(n), number: n, fullPath: `${FOLDER}/Saga #00${n}.cbz`, coverUrl: `/covers/${n}.jpg`,
    writers: [], artists: [], characters: [], genres: [], storyArcs: [],
    isRead: false, readProgress: 0, isUnmatched: false, ...over,
});
type Row = ReturnType<typeof issue>;
const reply = (downloaded: Row[]) => ({
    id: 's1', seriesName: 'Saga', coverUrl: '/covers/series.jpg', cvId: 4242, metadataId: '4242', metadataSource: 'COMICVINE', path: FOLDER,
    publisher: 'Image', year: 2012, matchState: 'MATCHED',
    downloadedIssues: downloaded, missingIssues: [],
    specials: [], missingSpecials: [], collectedEditions: [], missingCollectedEditions: [], duplicates: [], coveredIssues: [],
});
const detail = (over: Record<string, unknown> = {}) => ({
    number: '2', name: 'Saga #2', releaseDate: null, universe: null,
    writers: [], artists: [], coverArtists: [], colorists: [], letterers: [], inker: [], editor: [], translator: [],
    characters: [], genres: [], storyArcs: [], teams: [], locations: [], description: '', hasCustomMetadata: false, ...over,
});

const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 25)); }); };
const click = async (el: HTMLElement) => { await act(async () => { fireEvent.click(el); }); await settle(); };

let fetchMock: ReturnType<typeof stubFetchRouter>;
const renderPage = async (downloaded: Row[], opts: { detail?: unknown; search?: unknown[] } = {}) => {
    fetchMock = stubFetchRouter([
        ['/api/library/series?', () => ok(reply(downloaded))],
        ['/api/library/issue?', () => ok(opts.detail ?? detail())],
        ['/api/search?', () => ok({ results: opts.search ?? [], hasMore: false })],
        ['/api/library/match-series', () => ok({ success: false, error: 'not in this test' })],
        ['/api/progress', () => ok({ success: true })],
        ['/api/admin/config', () => ok({ settings: [] })],
        ['/api/reviews', () => ok({ reviews: [], avgRating: '0.0', total: 0 })],
    ]);
    await act(async () => { render(<SeriesPage />); });
    await settle();
};

const readButton = () => screen.getByRole('button', { name: /^(Read|Resume) Selected$/ });

describe('Series page: the selected issue', () => {
    beforeEach(() => { localStorage.clear(); });

    it('tops the shelf row up with the issue reply: new credits added, empty lists keep the row\'s, the description shown', async () => {
        await renderPage(
            [issue('d1', '1', { isRead: true, readProgress: 100 }), issue('d2', '2', { writers: ['Brian K. Vaughan'], readProgress: 40 })],
            { detail: detail({
                artists: ['Fiona Staples'], coverArtists: ['Cover Person'], colorists: ['Color Person'], letterers: ['Fonografiks'],
                characters: ['Alana'], teams: ['The Will'], locations: ['Wreath'], genres: ['Space Opera'], storyArcs: ['Chapter Two'],
                description: '<p>Issue two synopsis</p>',
            }) },
        );

        // The first unread issue is the one selected, and its detail was asked for.
        expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/library/issue?id=d2')).toBe(true);
        expect(screen.getByText('Saga #2 Synopsis')).toBeInTheDocument();
        expect(screen.getByText('Issue two synopsis')).toBeInTheDocument();
        // The reply's writers were empty: the shelf row's stay.
        expect(screen.getByText('Brian K. Vaughan')).toBeInTheDocument();
        for (const name of ['Fiona Staples', 'Cover Person', 'Color Person', 'Fonografiks', 'Alana', 'The Will', 'Wreath', 'Space Opera', 'Chapter Two']) {
            expect(screen.getByText(name)).toBeInTheDocument();
        }
        // The main cover is the selected issue's.
        expect(screen.getByAltText('Cover')).toHaveAttribute('src', '/covers/2.jpg');
    });

    it('marking the selected issue read, then unread, updates its Read button', async () => {
        await renderPage([issue('d2', '2', { readProgress: 40 })]);

        expect(readButton()).toHaveTextContent('Resume Selected');
        expect(readButton()).toHaveClass('border-0');

        await click(screen.getByTitle('Mark Read'));
        const progress = fetchMock.mock.calls.filter(([u]) => String(u) === '/api/progress');
        expect(JSON.parse(progress[0][1].body)).toEqual({ filePath: `${FOLDER}/Saga #002.cbz`, currentPage: 100, totalPages: 100 });
        expect(readButton()).toHaveTextContent('Read Selected');
        expect(readButton()).not.toHaveClass('border-0');

        await click(screen.getByTitle('Mark Unread'));
        expect(readButton()).toHaveTextContent('Read Selected');
        expect(readButton()).not.toHaveClass('border-0');
        expect(screen.getByTitle('Mark Read')).toBeInTheDocument();
    });

    it('with no issue at all the Read button is plain and disabled, and the series cover shows', async () => {
        await renderPage([]);
        expect(readButton()).toHaveTextContent('Read Selected');
        expect(readButton()).toBeDisabled();
        expect(readButton()).not.toHaveClass('border-0');
        expect(screen.getByAltText('Cover')).toHaveAttribute('src', '/covers/series.jpg');
    });
});

describe('Series page: Match Series', () => {
    beforeEach(() => { localStorage.clear(); });

    const RESULTS = [
        { id: 4242, name: 'Saga', year: '2012', publisher: 'Image', count: 54, image: null, description: '', metadataSource: 'COMICVINE' },
        { id: 'm-77', name: 'Saga Deluxe', year: 2019, publisher: 'Image', count: 9, image: null, description: '', metadataSource: 'METRON' },
        { id: 5, name: 'Saga Old', year: '2009', publisher: 'Image', count: 3, image: null, description: '', metadataSource: 'COMICVINE' },
    ];

    const openAndSearch = async () => {
        await renderPage([issue('d1', '1')], { search: RESULTS });
        await click(screen.getByRole('button', { name: /Fix Match/ }));
        const dialog = screen.getByRole('dialog');
        await click(within(dialog).getByRole('button', { name: '' }));
        return dialog;
    };
    const titles = (dialog: HTMLElement) => within(dialog).getAllByRole('heading', { level: 4 }).map(h => h.textContent);
    const pickSort = async (dialog: HTMLElement, label: string) => {
        await act(async () => { fireEvent.keyDown(within(dialog).getByRole('combobox'), { key: 'ArrowDown' }); });
        await click(screen.getByRole('option', { name: label }));
    };

    it('sorts by year whether the provider sent a number or text', async () => {
        const dialog = await openAndSearch();
        expect(titles(dialog)).toEqual(['Saga', 'Saga Deluxe', 'Saga Old']);

        await pickSort(dialog, 'Newest Year');
        expect(titles(dialog)).toEqual(['Saga Deluxe', 'Saga', 'Saga Old']);

        await pickSort(dialog, 'Oldest Year');
        expect(titles(dialog)).toEqual(['Saga Old', 'Saga', 'Saga Deluxe']);
    });

    it("matches by the result's own id - a Metron id as text, a ComicVine id as a number", async () => {
        const dialog = await openAndSearch();
        const matchBodies = () => fetchMock.mock.calls
            .filter(([u]) => String(u) === '/api/library/match-series')
            .map(([, init]) => JSON.parse(init.body));

        await click(within(dialog).getByText('Saga Deluxe'));
        expect(matchBodies()[0]).toMatchObject({ metadataId: 'm-77', name: 'Saga Deluxe', year: '2019', publisher: 'Image', oldFolderPath: FOLDER });

        await click(within(dialog).getByText('Saga Old'));
        expect(matchBodies()[1]).toMatchObject({ metadataId: 5, name: 'Saga Old', year: '2009' });
    });
});
