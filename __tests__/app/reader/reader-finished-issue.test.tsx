// @vitest-environment jsdom
// Opening an issue you had finished used to mark it unread: it opens at page 1, and the progress
// sync wrote that page about two seconds later whether or not you turned one - and the progress
// API counts page 1 as not finished. Read badges, the Reading List's count and Continue point,
// History, Continue Reading, the Komga facade and KOReader all saw it as unread afterwards.
// A finished issue now stays finished until you turn a page (a re-read). Unfinished and new issues
// keep their save on open (that is what puts an opened issue on Continue Reading).
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stubFetchRouter, ok } from '../../helpers/fetch';

vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(`?path=${encodeURIComponent('/comics/Crisis/Crisis 001.cbz')}`),
    useRouter: () => ({ back: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { role: 'USER' } } }) }));
vi.mock('localforage', () => ({ default: { getItem: vi.fn(), setItem: vi.fn() } }));
global.ResizeObserver = vi.fn().mockImplementation(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }));
window.HTMLElement.prototype.scrollIntoView = vi.fn();

import ReaderPage from '@/app/reader/page';

type Progress = { currentPage: number; isCompleted: boolean; issueId: string };
let progressGet: Progress;
let writes: number[] = [];

// The reader starts syncing half a second after an issue opens and writes 1.5 s after the last
// change. Two separate waits: React applies the state set inside act() when the act ends, so the
// "ready" flag must land (first act) before the 1.5 s sync can start and fire (second act).
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const pastTheSync = async () => { await wait(700); await wait(1900); };
const opened = async () => {
    render(<ReaderPage />);
    await waitFor(() => expect(screen.getByAltText(/^Page \d+$/)).toBeInTheDocument());
};

describe('Reader: opening a finished issue', () => {
    beforeEach(() => {
        writes = [];
        stubFetchRouter([
            ['/api/reader/pages', () => ok({ pages: Array.from({ length: 20 }, (_, i) => `p${i + 1}.jpg`) })],
            ['/api/progress/bookmarks', () => ok({ bookmarks: [] })],
            ['/api/progress', (_u, init) => {
                if (init?.method === 'POST') { writes.push(JSON.parse(init.body).currentPage); return ok({ success: true }); }
                return ok(progressGet);
            }],
        ]);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('leaves it finished when you only look: nothing is written', async () => {
        progressGet = { currentPage: 20, isCompleted: true, issueId: 'i1' };
        await opened();
        expect(screen.getByAltText('Page 1')).toBeInTheDocument();

        await pastTheSync();

        expect(writes).toEqual([]);
    });

    it('turning a page starts a re-read: that page is written', async () => {
        progressGet = { currentPage: 20, isCompleted: true, issueId: 'i1' };
        await opened();
        await wait(700);

        fireEvent.keyDown(window, { key: 'ArrowRight' });
        await wait(1900);

        expect(writes).toEqual([1]);
    });

    it('an unfinished issue still saves the page it opened at, as before', async () => {
        progressGet = { currentPage: 5, isCompleted: false, issueId: 'i1' };
        await opened();
        expect(screen.getByAltText('Page 6')).toBeInTheDocument();

        await pastTheSync();

        expect(writes).toEqual([5]);
    });

    it('a new issue still gets its first save on open, as before (Continue Reading lists it)', async () => {
        progressGet = { currentPage: 0, isCompleted: false, issueId: 'i1' };
        await opened();

        await pastTheSync();

        expect(writes).toEqual([0]);
    });
});
