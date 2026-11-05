// @vitest-environment jsdom
// Page bookmarks in the reader. From v1.0.7-beta.004 the reader loaded and saved them at
// /api/progress/bookmark while the route is /api/progress/bookmarks, so every open 404'd (read as
// "no bookmarks") and the button did nothing - not even an error. Bookmarks show as the filled
// button on a bookmarked page and as marks on the page slider; there is no profile list of them.
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stubFetchRouter, ok, err } from '../../helpers/fetch';

vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(`?path=${encodeURIComponent('/comics/Crisis/Crisis 001.cbz')}`),
    useRouter: () => ({ back: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));
const toastMock = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { role: 'USER' } } }) }));
vi.mock('localforage', () => ({ default: { getItem: vi.fn(), setItem: vi.fn() } }));
global.ResizeObserver = vi.fn().mockImplementation(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }));
window.HTMLElement.prototype.scrollIntoView = vi.fn();

import ReaderPage from '@/app/reader/page';

const FILE = '/comics/Crisis/Crisis 001.cbz';
type Call = { method: string; body: { filePath: string; pageIndex: number } };
let saved: number[] = [];
let writes: Call[] = [];
let failWrites = false;

const button = () => screen.getByTitle('Bookmark Page');
const isMarked = () => button().className.includes('text-yellow-400');
const opened = async () => {
    render(<ReaderPage />);
    await waitFor(() => expect(screen.getByAltText('Page 1')).toBeInTheDocument());
};

describe('Reader: page bookmarks', () => {
    beforeEach(() => {
        saved = [];
        writes = [];
        failWrites = false;
        toastMock.mockReset();
        stubFetchRouter([
            ['/api/reader/pages', () => ok({ pages: ['p1.jpg', 'p2.jpg', 'p3.jpg'] })],
            ['/api/progress/bookmarks', (url, init) => {
                if (!init?.method || init.method === 'GET') {
                    expect(new URL(url, 'http://localhost').searchParams.get('path')).toBe(FILE);
                    return ok({ bookmarks: saved.map(pageIndex => ({ pageIndex })) });
                }
                writes.push({ method: init.method, body: JSON.parse(init.body) });
                return failWrites ? err(500, { error: 'disk full' }) : ok({ success: true });
            }],
            // after the bookmarks route: '/api/progress' would also match '/api/progress/bookmark…'
            ['/api/progress', () => ok({ currentPage: 0, isCompleted: false, issueId: 'i1' })],
        ]);
    });
    afterEach(() => vi.unstubAllGlobals());

    it("shows the file's saved bookmarks: the button filled on a bookmarked page, a mark on the slider", async () => {
        saved = [0, 2];
        await opened();

        await waitFor(() => expect(isMarked()).toBe(true));
        expect(document.querySelectorAll('.bg-yellow-400.rounded-full')).toHaveLength(2);
        fireEvent.keyDown(window, { key: 'ArrowRight' });
        await waitFor(() => expect(screen.getByAltText('Page 2')).toBeInTheDocument());
        expect(isMarked()).toBe(false);
    });

    it('the button adds the page through the route, and takes it out again', async () => {
        await opened();

        fireEvent.click(button());
        await waitFor(() => expect(isMarked()).toBe(true));
        expect(writes).toEqual([{ method: 'POST', body: { filePath: FILE, pageIndex: 0 } }]);
        expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Bookmark Added' }));
        // it is marked on the page slider - there is no list of bookmarks on the profile page
        expect(toastMock.mock.calls.at(-1)?.[0].description).not.toMatch(/profile/i);

        fireEvent.click(button());
        await waitFor(() => expect(isMarked()).toBe(false));
        expect(writes[1]).toEqual({ method: 'DELETE', body: { filePath: FILE, pageIndex: 0 } });
        expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Bookmark Removed' }));
    });

    it("says so when the bookmark can't be saved, and leaves the page as it was", async () => {
        failWrites = true;
        await opened();

        fireEvent.click(button());

        await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive', description: expect.stringContaining('disk full') })));
        expect(isMarked()).toBe(false);
    });
});
