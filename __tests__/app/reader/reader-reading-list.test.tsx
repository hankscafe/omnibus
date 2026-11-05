// @vitest-environment jsdom
// #270 (niddelicious): reading a Reading List. Opened from a list, the reader's next issue is the
// list's next entry you have a file for - whatever its series - not the series' next issue; opened
// anywhere else it stays the series' next. Closing saves the page you're on before leaving, so the
// list's Continue point is right when you get back to it.
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stubFetchRouter, ok, err } from '../../helpers/fetch';
import { readerHref } from '@/lib/reading-list-nav';

const nav = vi.hoisted(() => ({ params: '', back: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(nav.params),
    useRouter: () => ({ back: nav.back, replace: nav.replace, push: vi.fn() }),
}));
const toastMock = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { role: 'USER' } } }) }));
vi.mock('localforage', () => ({ default: { getItem: vi.fn(), setItem: vi.fn() } }));
global.ResizeObserver = vi.fn().mockImplementation(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }));
window.HTMLElement.prototype.scrollIntoView = vi.fn();

import ReaderPage from '@/app/reader/page';

const CRISIS_1 = '/comics/Crisis/Crisis 001.cbz';
const CRISIS_2 = '/comics/Crisis/Crisis 002.cbz';
const FLASH_7 = '/comics/Flash/Flash 007.cbz';
const issue = (filePath: string | null, series: string, number: string) =>
    ({ filePath, number, series: { name: series, folderPath: `/comics/${series}` } });
const LIST = {
    id: 'L1', name: 'Final Night',
    items: [
        { id: 'it1', issue: issue(CRISIS_1, 'Crisis', '1') },
        { id: 'it2', issue: null },                          // unlinked: nothing to read
        { id: 'it3', issue: issue(null, 'Superman', '4') },  // linked, not in the library yet
        { id: 'it4', issue: issue(FLASH_7, 'Flash', '7') },
    ],
};

type Progress = { currentPage: number; isCompleted: boolean; issueId: string };
let events: string[] = [];
let listResponse: () => ReturnType<typeof ok> = () => ok(LIST);
let progressGet: Progress = { currentPage: 0, isCompleted: false, issueId: 'i1' };
let pageCount = 3;

const open = (query: string) => {
    nav.params = query;
    render(<ReaderPage />);
};
const atLastPage = async () => {
    await waitFor(() => expect(screen.getByAltText(/^Page \d+$/)).toBeInTheDocument());
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getAllByText(/Page 3/i).length).toBeGreaterThan(0));
};
const fromList = (item = 'it1') => `?path=${encodeURIComponent(CRISIS_1)}&series=${encodeURIComponent('/comics/Crisis')}&list=L1&item=${item}`;

describe('Reader: next issue from a Reading List (#270)', () => {
    beforeEach(() => {
        events = [];
        listResponse = () => ok(LIST);
        progressGet = { currentPage: 0, isCompleted: false, issueId: 'i1' };
        nav.back.mockReset().mockImplementation(() => { events.push('back'); });
        nav.replace.mockReset();
        toastMock.mockReset();
        stubFetchRouter([
            ['/api/reader/pages', () => ok({ pages: ['p1.jpg', 'p2.jpg', 'p3.jpg'] })],
            ['/api/progress/bookmark', () => ok({ bookmarks: [] })],
            ['/api/progress', (_u, init) => {
                if (init?.method === 'POST') { events.push(`progress:${JSON.parse(init.body).currentPage}`); return ok({ success: true }); }
                return ok(progressGet);
            }],
            ['/api/library/series', () => ok({ id: 's1', isManga: false, downloadedIssues: [
                { fullPath: CRISIS_1, name: 'Crisis 001', parsedNum: 1 },
                { fullPath: CRISIS_2, name: 'Crisis 002', parsedNum: 2 },
            ] })],
            ['/api/reading-lists', () => listResponse()],
            ['/api/reader/preferences', () => ok({ settings: null })],
        ]);
    });
    afterEach(() => vi.unstubAllGlobals());

    it("opens the list's next entry you have a file for, from its own series, and says what it skipped", async () => {
        open(fromList());
        await atLastPage();

        fireEvent.click(await screen.findByRole('button', { name: /Next in List/ }));

        expect(nav.replace).toHaveBeenCalledWith(readerHref(FLASH_7, '/comics/Flash', { listId: 'L1', itemId: 'it4' }));
        expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
            title: expect.stringContaining('Final Night'),
            description: expect.stringMatching(/Flash #7.*skipped 2/),
        }));
    });

    it("stays with the series' next issue when the reader wasn't opened from a list", async () => {
        open(`?path=${encodeURIComponent(CRISIS_1)}&series=${encodeURIComponent('/comics/Crisis')}`);
        await atLastPage();

        fireEvent.click(await screen.findByRole('button', { name: /Next Issue/ }));

        expect(nav.replace).toHaveBeenCalledWith(readerHref(CRISIS_2, '/comics/Crisis'));
        const fetched = vi.mocked(global.fetch).mock.calls.map(([u]) => String(u));
        expect(fetched.some(u => u.startsWith('/api/reading-lists'))).toBe(false);
    });

    it("ends with the list: nothing next after its last entry you have a file for, even though the series goes on", async () => {
        listResponse = () => ok({ ...LIST, items: LIST.items.slice(0, 3) });
        open(fromList());
        await atLastPage();

        expect(screen.queryByRole('button', { name: /Next (in List|Issue)/ })).not.toBeInTheDocument();
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        expect(nav.replace).not.toHaveBeenCalled();
    });

    it("falls back to the series when the issue is no longer in the list", async () => {
        listResponse = () => ok({ ...LIST, items: LIST.items.slice(1) });
        open(fromList());
        await atLastPage();

        fireEvent.click(await screen.findByRole('button', { name: /Next Issue/ }));
        expect(nav.replace).toHaveBeenCalledWith(readerHref(CRISIS_2, '/comics/Crisis'));
    });

    it("falls back to the series when the list can't be loaded (deleted, or no longer shared with you)", async () => {
        listResponse = () => err(404, { error: 'Not found' });
        open(fromList());
        await atLastPage();

        fireEvent.click(await screen.findByRole('button', { name: /Next Issue/ }));
        expect(nav.replace).toHaveBeenCalledWith(readerHref(CRISIS_2, '/comics/Crisis'));
    });
});

describe('Reader: closing saves the page you are on (#270)', () => {
    beforeEach(() => {
        events = [];
        pageCount = 3;
        progressGet = { currentPage: 0, isCompleted: false, issueId: 'i1' };
        nav.back.mockReset().mockImplementation(() => { events.push('back'); });
        stubFetchRouter([
            ['/api/reader/pages', () => ok({ pages: Array.from({ length: pageCount }, (_, i) => `p${i + 1}.jpg`) })],
            ['/api/progress/bookmark', () => ok({ bookmarks: [] })],
            ['/api/progress', (_u, init) => {
                if (init?.method === 'POST') { events.push(`progress:${JSON.parse(init.body).currentPage}`); return ok({ success: true }); }
                return ok(progressGet);
            }],
        ]);
    });
    afterEach(() => vi.unstubAllGlobals());

    const loadedAndSyncing = async () => {
        open(`?path=${encodeURIComponent(CRISIS_1)}`);
        await waitFor(() => expect(screen.getByAltText(/^Page \d+$/)).toBeInTheDocument());
        // the reader starts saving progress half a second after an issue opens
        await act(async () => { await new Promise(r => setTimeout(r, 650)); });
    };

    it('writes a page turned just before Close, before leaving', async () => {
        await loadedAndSyncing();
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        await waitFor(() => expect(screen.getAllByText(/Page 2/i).length).toBeGreaterThan(0));

        fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));

        await waitFor(() => expect(events).toContain('back'));
        expect(events.slice(0, events.indexOf('back'))).toContain('progress:1');
    });

    it("Mark as Read just before Close stays read: Close doesn't write the page on screen over it", async () => {
        pageCount = 10; // page 2 of 10 is nowhere near finished
        await loadedAndSyncing();
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        await waitFor(() => expect(screen.getAllByText(/Page 2/i).length).toBeGreaterThan(0));
        fireEvent.click(screen.getByRole('button', { name: /Mark as Read/ }));
        await waitFor(() => expect(events).toContain('progress:10'));

        fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));

        await waitFor(() => expect(events).toContain('back'));
        expect(events.filter(e => e.startsWith('progress:'))).toEqual(['progress:10']);
    });

    it("writes nothing when you close on the page the issue opened at (a finished issue stays finished)", async () => {
        progressGet = { currentPage: 3, isCompleted: true, issueId: 'i1' };
        await loadedAndSyncing();

        fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));

        await waitFor(() => expect(events).toContain('back'));
        expect(events.filter(e => e.startsWith('progress:'))).toEqual([]);
    });
});
