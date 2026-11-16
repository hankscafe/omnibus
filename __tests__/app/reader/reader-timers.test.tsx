// @vitest-environment jsdom
// The reader starts syncing progress half a second after an issue loads (a 500 ms timer that sets
// isReadyToSync) - the same uncancelled timer the Jobs page had (beta.043): on beta.042's docker-publish
// run the Jobs page's copy fired after a test file's jsdom teardown and failed the run although every test
// passed. The reader's is now cancelled when the reader closes or moves to another issue, and a load that
// settles after the reader has gone starts none.
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stubFetchRouter, ok } from '../../helpers/fetch';

vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(`?path=${encodeURIComponent('/comics/Crisis/Crisis 001.cbz')}`),
    useRouter: () => ({ back: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
const sessionValue = vi.hoisted(() => ({ data: { user: { role: 'USER' } } }));
vi.mock('next-auth/react', () => ({ useSession: () => sessionValue }));
vi.mock('localforage', () => ({ default: { getItem: vi.fn(), setItem: vi.fn() } }));
global.ResizeObserver = vi.fn().mockImplementation(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }));
window.HTMLElement.prototype.scrollIntoView = vi.fn();

import ReaderPage from '@/app/reader/page';

const READY_MS = 500;
type TimerSpy = { mock: { calls: unknown[][]; results: { value: unknown }[] }; mockRestore: () => void };
const readyCalls = (spy: TimerSpy) => spy.mock.calls
    .map((call: unknown[], i: number) => ({ delay: call[1], id: spy.mock.results[i]?.value }))
    .filter((c: { delay: unknown }) => c.delay === READY_MS);
const pagesReply = () => ok({ pages: Array.from({ length: 5 }, (_, i) => `p${i + 1}.jpg`) });

describe('Reader: its ready-to-sync timer never outlives the issue', () => {
    let setSpy: TimerSpy;
    let clearSpy: TimerSpy;

    beforeEach(() => {
        setSpy = vi.spyOn(globalThis, 'setTimeout') as unknown as TimerSpy;
        clearSpy = vi.spyOn(globalThis, 'clearTimeout') as unknown as TimerSpy;
    });
    afterEach(() => {
        setSpy.mockRestore();
        clearSpy.mockRestore();
        vi.unstubAllGlobals();
    });

    it('cancels the pending timer when the reader closes', async () => {
        stubFetchRouter([
            ['/api/reader/pages', pagesReply],
            ['/api/progress/bookmarks', () => ok({ bookmarks: [] })],
            ['/api/progress', () => ok({ currentPage: 0, isCompleted: false, issueId: 'i1' })],
        ]);
        const { unmount } = render(<ReaderPage />);
        await waitFor(() => expect(screen.getByAltText(/^Page \d+$/)).toBeInTheDocument());
        await waitFor(() => expect(readyCalls(setSpy)).toHaveLength(1));
        const [{ id }] = readyCalls(setSpy);

        unmount();

        expect(clearSpy).toHaveBeenCalledWith(id);
    });

    it('starts no timer when the issue loads after the reader has closed', async () => {
        let settle: (v: unknown) => void = () => {};
        stubFetchRouter([
            ['/api/reader/pages', () => new Promise(resolve => { settle = resolve; })],
            ['/api/progress/bookmarks', () => ok({ bookmarks: [] })],
            ['/api/progress', () => ok({ currentPage: 0, isCompleted: false, issueId: 'i1' })],
        ]);
        const { unmount } = render(<ReaderPage />);

        unmount();
        settle({ ok: true, json: async () => ({ pages: ['p1.jpg'] }) });
        await new Promise(r => setTimeout(r, 10));
        await new Promise(r => setTimeout(r, 10));

        expect(readyCalls(setSpy)).toHaveLength(0);
    });
});
