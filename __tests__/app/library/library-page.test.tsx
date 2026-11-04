// @vitest-environment jsdom
// The library page's load/append loop — the component side of the scroll saga (v1.4.0 dupes →
// v1.4.1 tiebreakers → v1.4.2 plain-grid rewrite). The route-level tests pin the server's total
// order; until now NOTHING pinned the client half: page-windowed fetches, append-dedupe by id,
// the sentinel re-check that advances pagination, and the hasMore stop. These tests drive the
// REAL page component in jsdom, where getBoundingClientRect() is all zeros — so the v1.4.2
// after-append re-check (sentinel top < viewport+800) fires naturally after every append and
// pagination advances without simulating IntersectionObserver crossings (the observer itself is
// stubbed inert; only the re-check path drives).
//
// Both tests render inside an awaited act() instead of polling with findBy*. Every hop in the
// chain (stubbed fetch → setSeries → re-check effect → page-2 fetch → append) is a microtask or a
// React flush, and async act() drains both until no React work is left — so both windows have
// landed when it returns, with no clock involved. The findBy* form flaked under full-suite load:
// its 1 s budget had to cover whole-page renders of 24 then 26 cards (measured 2026-09-29: page 2
// requested at ~1.05 s, Series 26 on screen at ~2.9 s — slow, never stuck).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ok, stubFetchRouter } from '../../helpers/fetch';

const toast = vi.fn();
const viewer = vi.hoisted(() => ({ role: 'ADMIN' }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: { user: { id: `${viewer.role.toLowerCase()}_1`, role: viewer.role } }, status: 'authenticated' }),
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));
// The list view is a TableVirtuoso, which renders no rows in jsdom (no viewport to measure). A plain
// table that renders every row through the page's own itemContent keeps the row markup under test.
vi.mock('react-virtuoso', async () => {
    const React = await import('react');
    return {
        TableVirtuoso: ({ data, itemContent, context }: any) =>
            React.createElement('table', null, React.createElement('tbody', null,
                data.map((item: any, i: number) => React.createElement('tr', { key: item.id ?? i }, itemContent(i, item, context))))),
    };
});

import LibraryPage from '@/app/library/page';

const makeSeries = (n: number) => ({
    id: `s${n}`,
    path: `/comics/Series ${String(n).padStart(2, '0')}`,
    name: `Series ${String(n).padStart(2, '0')}`,
    cover: null,
    publisher: 'DC',
    year: 2020,
    count: 3,
    unreadCount: 1,
    progressPercentage: 33,
    isFavorite: false,
    isPendingReq: false,
    matchState: 'MATCHED',
});

// Page 1 = a full window of 24; page 2 re-serves #24 (the pg-overlap shape from the v1.4.0 field
// regression) plus two fresh rows and ends the list.
const PAGE1 = Array.from({ length: 24 }, (_, i) => makeSeries(i + 1));
const PAGE2 = [makeSeries(24), makeSeries(25), makeSeries(26)];

let listCalls: string[] = [];

// The per-test timeout is the only clock left. A stalled chain can't spend it (act() returns once
// React work runs out, and the assertions fail in well under a second); it only has to outlast a
// slow-but-correct drain — up to 2.8 s measured on a loaded full-suite run, under the 15 s
// testTimeout in vitest.config.ts.
describe('LibraryPage grid pagination (scroll-saga client half)', () => {
    beforeEach(() => {
        viewer.role = 'ADMIN';
        listCalls = [];
        toast.mockClear();
        localStorage.clear();
        vi.stubGlobal('IntersectionObserver', class {
            observe() {} unobserve() {} disconnect() {}
        } as any);
        vi.stubGlobal('ResizeObserver', class {
            observe() {} unobserve() {} disconnect() {}
        } as any);
        window.scrollTo = vi.fn() as any;

        stubFetchRouter([
            ['/api/library/follow', () => ok({ seriesIds: [] })],
            ['/api/reading-lists', () => ok([])],
            ['/api/library?', (u) => {
                const params = new URL(u, 'http://localhost').searchParams;
                if (params.get('namesOnly')) return ok({ names: [] });
                listCalls.push(u);
                return params.get('page') === '1'
                    ? ok({ series: PAGE1, hasMore: true, publishers: ['DC'] })
                    : ok({ series: PAGE2, hasMore: false, publishers: ['DC'] });
            }],
        ]);
    });

    it('loads page 1, auto-appends page 2 via the sentinel re-check, and stops at hasMore=false', async () => {
        await act(async () => { render(<LibraryPage />); });

        // Initial window landed, then the after-append re-check advanced exactly one page (the
        // observer is inert, so nothing else could have asked for page 2)…
        expect(listCalls).toHaveLength(2);
        expect(listCalls[0]).toContain('page=1');
        expect(listCalls[1]).toContain('page=2');
        screen.getByText('Series 01');
        screen.getByText('Series 26');
        // …and the hasMore=false stop holds. series.length changed again after page 2, so the
        // re-check already ran again inside act(); the settle pass also gives any stray async
        // trigger time to show up — the guard must hold the line at two requests (no endReached storm).
        await new Promise(r => setTimeout(r, 25));
        expect(listCalls).toHaveLength(2);
        expect(toast).not.toHaveBeenCalled();
    });

    it('dedupes appended rows by id — an overlapping page window can never render twice', async () => {
        await act(async () => { render(<LibraryPage />); });

        // Page 2 was requested AND applied — without this the dedupe checks below would be vacuous.
        expect(listCalls).toHaveLength(2);
        expect(listCalls[1]).toContain('page=2');
        screen.getByText('Series 26');

        // Series 24 arrived in BOTH windows (the pg tie-order overlap shape); one card, not two.
        expect(screen.getAllByText('Series 24')).toHaveLength(1);
        expect(screen.getAllByText(/^Series \d\d$/)).toHaveLength(26); // 24 + 2 fresh, no dupes
    });
});

// Found in the v1.4.7 permission sweep: the list view's Edit Metadata button was the one opener
// of the series editor without an admin gate (the grid card and the series page had one). A
// regular user got the editor, its read of the admin settings, and a save the server refuses.
describe('LibraryPage list view: Edit Metadata is admin-only', () => {
    beforeEach(() => {
        localStorage.clear();
        localStorage.setItem('omnibus-library-view', 'list');
        vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} } as any);
        vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} } as any);
        window.scrollTo = vi.fn() as any;
        stubFetchRouter([
            ['/api/library/follow', () => ok({ seriesIds: [] })],
            ['/api/reading-lists', () => ok([])],
            ['/api/library?', (u) => new URL(u, 'http://localhost').searchParams.get('namesOnly')
                ? ok({ names: [] })
                : ok({ series: [makeSeries(1)], hasMore: false, publishers: ['DC'] })],
        ]);
    });

    it('a regular user gets the row actions but no Edit Metadata button', async () => {
        viewer.role = 'USER';
        await act(async () => { render(<LibraryPage />); });

        // The row rendered (so the absence below is about the gate, not an empty table).
        screen.getByLabelText('Add Series 01 to a reading list');
        expect(screen.queryByLabelText('Edit metadata for Series 01')).toBeNull();
    });

    it('an admin still gets Edit Metadata on the row', async () => {
        viewer.role = 'ADMIN';
        await act(async () => { render(<LibraryPage />); });

        screen.getByLabelText('Edit metadata for Series 01');
    });
});

// First-run checklist: an empty Library explains what to do (the checklist's library variant)
// instead of "No comics found matching your criteria." - which stays for a filter that matches
// nothing in a library that does have comics.
describe('LibraryPage empty state', () => {
    const emptyLibraryWith = (status: unknown) => {
        stubFetchRouter([
            ['/api/library/follow', () => ok({ seriesIds: [] })],
            ['/api/reading-lists', () => ok([])],
            ['/api/setup-status', () => ok(status)],
            ['/api/library?', (u) => new URL(u, 'http://localhost').searchParams.get('namesOnly')
                ? ok({ names: [] })
                : ok({ series: [], hasMore: false, publishers: [] })],
        ]);
    };

    beforeEach(() => {
        viewer.role = 'USER';
        localStorage.clear();
        vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
        vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
        window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    });

    it('tells a reader with an empty library how to get comics', async () => {
        emptyLibraryWith({ role: 'USER', libraryEmpty: true, canRequest: true });
        await act(async () => { render(<LibraryPage />); });

        screen.getByText(/Your library is empty/i);
        expect(screen.queryByText('No comics found matching your criteria.')).toBeNull();
    });

    it('keeps the no-match message when the library has comics but the filters match none', async () => {
        emptyLibraryWith({ role: 'USER', libraryEmpty: false, canRequest: true });
        await act(async () => { render(<LibraryPage />); });

        screen.getByText('No comics found matching your criteria.');
    });
});

// The grid card's hover actions (md+) were one row that never wrapped: an admin's four icons need
// ~146px and a reading-list view adds a fifth, but the overlay has ~116-148px at 4-8 columns, so the
// outer icons were cut off. They sit two per row under Read now, with Remove from List - the only
// one that can be left over - on a row of its own.
describe('LibraryPage grid card: hover actions fit the card', () => {
    const classes = (el: Element) => el.className.split(/\s+/);

    beforeEach(() => {
        viewer.role = 'ADMIN';
        localStorage.clear();
        localStorage.setItem('omnibus-library-view', 'grid');
        vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
        vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
        window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
        // Radix Select (the reading-list filter) calls these, and jsdom has neither.
        window.HTMLElement.prototype.scrollIntoView = vi.fn();
        window.HTMLElement.prototype.hasPointerCapture = vi.fn();
        stubFetchRouter([
            ['/api/library/follow', () => ok({ seriesIds: [] })],
            ['/api/reading-lists', () => ok([{ id: 'rl1', name: 'Events', items: [] }])],
            ['/api/library?', (u) => new URL(u, 'http://localhost').searchParams.get('namesOnly')
                ? ok({ names: [] })
                : ok({ series: [makeSeries(1)], hasMore: false, publishers: ['DC'] })],
        ]);
    });

    it("an admin's four actions sit two per row under Read", async () => {
        await act(async () => { render(<LibraryPage />); });

        const actions = screen.getByLabelText('Add Series 01 to a reading list').parentElement!;
        expect(classes(actions)).toEqual(expect.arrayContaining(['grid', 'grid-cols-2']));
        within(actions).getByLabelText('Edit metadata for Series 01');
        within(actions).getByLabelText('Refresh cover art for Series 01');
        expect(within(actions).getAllByRole('button')).toHaveLength(4);
    });

    it('in a reading list, Remove from List takes a row of its own', async () => {
        await act(async () => { render(<LibraryPage />); });
        await act(async () => { fireEvent.keyDown(screen.getByRole('combobox', { name: 'Filter by reading list' }), { key: 'ArrowDown' }); });
        await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Events' })); });

        const remove = screen.getByLabelText('Remove Series 01 from current list');
        expect(remove.parentElement).toBe(screen.getByLabelText('Add Series 01 to a reading list').parentElement);
        expect(classes(remove)).toContain('col-span-2');
    });
});
