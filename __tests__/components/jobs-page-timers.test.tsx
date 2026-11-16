// @vitest-environment jsdom
// The Jobs page takes its unsaved-changes baseline half a second after its settings load (a 500 ms timer that
// sets isDataLoaded). Nothing cancelled that timer, and it was started even when the load settled after the
// page had gone: on beta.042's docker-publish run (43749082618) it fired after jobs-page-ownership.test.tsx's
// jsdom was torn down, threw "window is not defined" inside React, and failed the run although every test
// passed - so the web image wasn't published. Leaving the page now cancels it, and a late load starts none.
import '@testing-library/jest-dom';
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ScheduledJobsPage from '@/app/admin/jobs/page';

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));
vi.mock('@/components/ui/use-toast', () => ({
    useToast: () => ({ toast: vi.fn() }),
}));

global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn()
}));
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const fetchMock = vi.fn();
global.fetch = fetchMock as unknown as typeof fetch;
const configReply = { ok: true, json: async () => ({ settings: [] }) };

const BASELINE_MS = 500;
/** What these tests read of a spy on setTimeout / clearTimeout. */
type TimerSpy = { mock: { calls: unknown[][]; results: { value: unknown }[] }; mockRestore: () => void };
/** The page's baseline timers: setTimeout calls with its half-second delay. */
const baselineCalls = (spy: TimerSpy) => spy.mock.calls
    .map((call: unknown[], i: number) => ({ delay: call[1], id: spy.mock.results[i]?.value }))
    .filter((c: { delay: unknown }) => c.delay === BASELINE_MS);

describe('Jobs page: its baseline timer never outlives the page', () => {
    let setSpy: TimerSpy;
    let clearSpy: TimerSpy;

    beforeEach(() => {
        fetchMock.mockImplementation(async () => configReply);
        setSpy = vi.spyOn(globalThis, 'setTimeout') as unknown as TimerSpy;
        clearSpy = vi.spyOn(globalThis, 'clearTimeout') as unknown as TimerSpy;
    });
    afterEach(() => {
        setSpy.mockRestore();
        clearSpy.mockRestore();
    });

    it('cancels the pending timer when the page goes away', async () => {
        const { unmount } = render(<ScheduledJobsPage />);
        await waitFor(() => expect(baselineCalls(setSpy)).toHaveLength(1));
        const [{ id }] = baselineCalls(setSpy);

        unmount();

        expect(clearSpy).toHaveBeenCalledWith(id);
    });

    it('starts no timer when the load settles after the page has gone', async () => {
        let settle: (v: unknown) => void = () => {};
        fetchMock.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
        const { unmount } = render(<ScheduledJobsPage />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/config'));

        unmount();
        settle(configReply);
        await new Promise(r => setTimeout(r, 10));
        await new Promise(r => setTimeout(r, 10));

        expect(baselineCalls(setSpy)).toHaveLength(0);
    });

    it('still takes the baseline under StrictMode, whose development double mount unmounts the page once', async () => {
        render(<React.StrictMode><ScheduledJobsPage /></React.StrictMode>);

        await waitFor(() => expect(baselineCalls(setSpy).length).toBeGreaterThan(0));
    });
});
