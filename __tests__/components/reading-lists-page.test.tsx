// @vitest-environment jsdom
// #252 / #253 (conduit4731): the Reading Lists page loads the overview (names + counts) and then only
// the open list's items, shows where you are in a list (read / in progress / unread, "N / M read",
// Continue at the first owned unfinished entry), can hide read entries in the grouped view, and
// filters the sidebar by name.
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stubFetchRouter, ok } from '../helpers/fetch';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: 'u1', role: 'USER' } } }) }));
const navParams = vi.hoisted(() => ({ current: '' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navParams.current) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import ReadingListsPage from '@/app/reading-lists/page';
import { readerHref, READING_LIST_RETURN_KEY, READING_LIST_VIEW_KEY } from '@/lib/reading-list-nav';

const OVERVIEW = [
    { id: 'l1', name: 'Crisis', description: null, coverUrl: null, isGlobal: false, userId: 'u1', counts: { total: 4, owned: 2, read: 1 } },
    { id: 'l2', name: 'Blackest Night', description: null, coverUrl: null, isGlobal: false, userId: 'u1', counts: { total: 120, owned: 98, read: 42 } },
];
const SERIES = { id: 's1', name: 'Crisis', folderPath: '/comics/Crisis', metadataId: '42', metadataSource: 'COMICVINE' };
const linked = (id: string, number: string, filePath: string | null, progress: { isRead: boolean; readProgress: number } | null) => ({
    id: `it${id}`, order: Number(number) - 1, title: '', cvIssueId: null, metadataSource: 'COMICVINE', issueId: `i${id}`,
    issue: { id: `i${id}`, number, name: `Part ${number}`, filePath, coverUrl: null, metadataSource: 'COMICVINE', series: SERIES },
    progress,
});
const DETAIL = {
    ...OVERVIEW[0],
    items: [
        linked('1', '1', '/comics/Crisis/Crisis 001.cbz', { isRead: true, readProgress: 100 }),
        linked('2', '2', '/comics/Crisis/Crisis 002.cbz', { isRead: false, readProgress: 50 }),
        linked('3', '3', null, null),
        { id: 'it4', order: 3, title: 'Crisis #4', cvIssueId: 4004, metadataSource: 'COMICVINE', issueId: null, issue: null, progress: null },
    ],
};

let fetchMock: ReturnType<typeof stubFetchRouter>;

describe('Reading Lists page (#252, #253)', () => {
    beforeEach(() => {
        navParams.current = '';
        window.localStorage.clear();
        fetchMock = stubFetchRouter([
            [/\/api\/reading-lists\?id=l1/, () => ok(DETAIL)],
            [/\/api\/reading-lists\?id=l2/, () => ok({ ...OVERVIEW[1], items: [] })],
            ['/api/reading-lists', () => ok(OVERVIEW)],
        ]);
    });
    afterEach(() => vi.unstubAllGlobals());

    const sidebar = async () => (await screen.findByPlaceholderText('Filter lists')).closest('[data-testid="reading-list-sidebar"]') as HTMLElement;
    const expandCrisis = async () => fireEvent.click(await screen.findByRole('button', { name: /Crisis.*3 Issues/ }));

    it("shows each list's counts in the sidebar and loads only the open list's items", async () => {
        render(<ReadingListsPage />);

        expect(await within(await sidebar()).findByText(/120 Issues · 42 Read/)).toBeInTheDocument();
        await screen.findByText(/1 \/ 4 read/);
        const urls = fetchMock.mock.calls.map(([u]) => String(u));
        expect(urls.filter(u => u.includes('?id=l1'))).toHaveLength(1);
        expect(urls.some(u => u.includes('?id=l2'))).toBe(false);
    });

    it('opens Continue on the first entry you own and have not finished', async () => {
        render(<ReadingListsPage />);

        const cont = await screen.findByRole('link', { name: /Continue/ });
        expect(cont).toHaveAttribute('href', expect.stringContaining(encodeURIComponent('/comics/Crisis/Crisis 002.cbz')));
        expect(screen.getByText(/2 in your library/)).toBeInTheDocument();
    });

    it("shows each entry's state, and an issue without a file gets no Read button", async () => {
        render(<ReadingListsPage />);
        await expandCrisis();

        const row = (name: string) => screen.getByText(new RegExp(`Issue #\\d • ${name}`)).closest('[data-testid="reading-list-row"]') as HTMLElement;
        expect(within(row('Part 1')).getByTestId('reading-state')).toHaveTextContent('Read');
        expect(within(row('Part 2')).getByTestId('reading-state')).toHaveTextContent('50%');
        expect(within(row('Part 3')).queryByTestId('reading-state')).not.toBeInTheDocument();
        expect(within(row('Part 1')).getByRole('link', { name: /Read/ })).toBeInTheDocument();
        expect(within(row('Part 3')).queryByRole('link', { name: /Read/ })).not.toBeInTheDocument();
        expect(within(row('Part 3')).getByText(/Not in your library/)).toBeInTheDocument();
    });

    it('hides read entries in the grouped view and remembers the choice', async () => {
        render(<ReadingListsPage />);
        await expandCrisis();
        expect(screen.getByText(/Part 1/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('switch', { name: /Hide read/ }));

        await waitFor(() => expect(screen.queryByText(/Part 1/)).not.toBeInTheDocument());
        expect(screen.getByText(/Part 2/)).toBeInTheDocument();
        expect(window.localStorage.getItem('omnibus-reading-lists-hide-read')).toBe('true');
    });

    it('filters the sidebar by name', async () => {
        render(<ReadingListsPage />);
        const list = await sidebar();
        await within(list).findByText('Blackest Night');

        fireEvent.change(screen.getByPlaceholderText('Filter lists'), { target: { value: 'black' } });

        expect(within(list).getByText('Blackest Night')).toBeInTheDocument();
        expect(within(list).queryByText('Crisis')).not.toBeInTheDocument();
    });
});

// #270 (niddelicious): reading a list. The reader opens with the list and the entry, and coming back
// to this page (the reader's Close goes Back) finds the same list, the same view, and your place.
describe('Reading Lists page: coming back from the reader (#270)', () => {
    let scrolledTo: (string | undefined)[] = [];

    beforeEach(() => {
        navParams.current = '';
        window.localStorage.clear();
        window.sessionStorage.clear();
        window.history.replaceState(null, '', '/reading-lists');
        scrolledTo = [];
        window.HTMLElement.prototype.scrollIntoView = vi.fn(function (this: HTMLElement) { scrolledTo.push(this.dataset.itemId); });
        fetchMock = stubFetchRouter([
            [/\/api\/reading-lists\?id=l1/, () => ok(DETAIL)],
            [/\/api\/reading-lists\?id=l2/, () => ok({ ...OVERVIEW[1], items: [] })],
            ['/api/reading-lists', () => ok(OVERVIEW)],
        ]);
    });
    afterEach(() => vi.unstubAllGlobals());

    const crisisGroup = () => screen.findByRole('button', { name: /Crisis.*3 Issues/ });
    const sidebar = async () => (await screen.findByPlaceholderText('Filter lists')).closest('[data-testid="reading-list-sidebar"]') as HTMLElement;

    it("opens the reader with this list's entry, so the reader's next follows the list", async () => {
        render(<ReadingListsPage />);

        const cont = await screen.findByRole('link', { name: /Continue/ });
        expect(cont).toHaveAttribute('href', readerHref('/comics/Crisis/Crisis 002.cbz', '/comics/Crisis', { listId: 'l1', itemId: 'it2' }));
        fireEvent.click(await crisisGroup());
        const row = screen.getByText(/Issue #1 • Part 1/).closest('[data-testid="reading-list-row"]') as HTMLElement;
        expect(within(row).getByRole('link', { name: /Read/ }))
            .toHaveAttribute('href', readerHref('/comics/Crisis/Crisis 001.cbz', '/comics/Crisis', { listId: 'l1', itemId: 'it1' }));
    });

    it('keeps the open list in the address, so Back (and a reload) opens it again', async () => {
        render(<ReadingListsPage />);
        await screen.findByText(/1 \/ 4 read/);
        await waitFor(() => expect(window.location.search).toBe('?id=l1'));

        fireEvent.click(within(await sidebar()).getByText('Blackest Night'));

        await waitFor(() => expect(window.location.search).toBe('?id=l2'));
        expect(window.location.pathname).toBe('/reading-lists');
    });

    it("reloads nothing when the address gets the open list's own ?id=, and opens the list another ?id= names", async () => {
        const view = render(<ReadingListsPage />);
        await screen.findByText(/1 \/ 4 read/);
        const overviewLoads = () => fetchMock.mock.calls.filter(([u]) => /\/api\/reading-lists\?t=/.test(String(u))).length;
        expect(overviewLoads()).toBe(1);

        navParams.current = '?id=l1'; // what the page itself just wrote for the open list
        view.rerender(<ReadingListsPage />);
        await screen.findByText(/1 \/ 4 read/);
        expect(overviewLoads()).toBe(1);

        navParams.current = '?id=l2'; // a link to another list
        view.rerender(<ReadingListsPage />);
        expect(await screen.findByText('This list is empty')).toBeInTheDocument();
        expect(overviewLoads()).toBe(2);
    });

    it('remembers Grouped or Flat in this browser', async () => {
        const first = render(<ReadingListsPage />);
        await crisisGroup();
        fireEvent.click(screen.getByRole('button', { name: /Flat/ }));
        expect(window.localStorage.getItem(READING_LIST_VIEW_KEY)).toBe('flat');
        first.unmount();

        render(<ReadingListsPage />);

        // Flat lists every entry with no groups to open; "Hide read" belongs to the grouped view.
        expect(await screen.findByText('Issue #2')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Crisis.*3 Issues/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('switch', { name: /Hide read/ })).not.toBeInTheDocument();
    });

    it('opening an entry leaves a note for the way back', async () => {
        render(<ReadingListsPage />);
        fireEvent.click(await screen.findByRole('link', { name: /Continue/ }));
        expect(window.sessionStorage.getItem(READING_LIST_RETURN_KEY)).toBe('l1');
    });

    it('back from the reader: opens the group holding your Continue entry and scrolls to it, once', async () => {
        window.sessionStorage.setItem(READING_LIST_RETURN_KEY, 'l1');
        render(<ReadingListsPage />);

        await waitFor(() => expect(scrolledTo).toEqual(['it2']));
        expect(await crisisGroup()).toHaveAttribute('aria-expanded', 'true');
        expect(window.sessionStorage.getItem(READING_LIST_RETURN_KEY)).toBeNull();
    });

    it('back from the reader in the flat view scrolls to your Continue entry too', async () => {
        window.localStorage.setItem(READING_LIST_VIEW_KEY, 'flat');
        window.sessionStorage.setItem(READING_LIST_RETURN_KEY, 'l1');
        render(<ReadingListsPage />);

        await waitFor(() => expect(scrolledTo).toEqual(['it2']));
    });

    // A list can run to hundreds of entries: their covers load as they near the screen, in either view.
    // Each entry's cover sits in a fixed-size box, so a late cover never moves the place the way
    // back from the reader scrolls to.
    it('loads the entry covers lazily, grouped and flat', async () => {
        const entryCovers = () => Array.from(document.querySelectorAll('[data-item-id] img'));
        const first = render(<ReadingListsPage />);
        fireEvent.click(await crisisGroup());
        expect(entryCovers()).toHaveLength(3);
        for (const img of entryCovers()) {
            expect(img).toHaveAttribute('loading', 'lazy');
            expect(img).toHaveAttribute('decoding', 'async');
        }
        first.unmount();

        window.localStorage.setItem(READING_LIST_VIEW_KEY, 'flat');
        render(<ReadingListsPage />);
        await screen.findByText('Issue #2');
        // Flat lists every entry: the owned ones and the ones not in the library.
        expect(entryCovers()).toHaveLength(4);
        for (const img of entryCovers()) {
            expect(img).toHaveAttribute('loading', 'lazy');
            expect(img).toHaveAttribute('decoding', 'async');
        }
    });

    it("an ordinary visit keeps the groups closed and the page at the top", async () => {
        render(<ReadingListsPage />);
        await screen.findByText(/1 \/ 4 read/);

        expect(await crisisGroup()).toHaveAttribute('aria-expanded', 'false');
        expect(scrolledTo).toEqual([]);
    });
});
