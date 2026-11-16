// @vitest-environment jsdom
// The series page's Community Reviews (beta.045, list item 9 of the f975e230 hand-off - item 10, found in
// beta.037's pass): Submit Review never looked at the save's answer, so a refused save said "Review Saved!",
// and it put whatever the reviews re-read answered into the list - a re-read answering { error } left the
// list undefined and the page errored on its next render. A refused save now says so, and a failed re-read
// keeps the reviews already shown.
import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { err, ok, stubFetchRouter } from '../../helpers/fetch';

const toastMock = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => toastMock }));
// One object, like next-auth's own: the reviews effect re-runs whenever the session object changes.
const sessionState = vi.hoisted(() => ({ data: { user: { id: 'u1', role: 'ADMIN' } }, status: 'authenticated' }));
vi.mock('next-auth/react', () => ({ useSession: () => sessionState }));
const params = new URLSearchParams('path=/lib/Image/Saga (2012)');
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
    useSearchParams: () => params,
}));

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

import SeriesPage from '@/app/library/series/page';

const FOLDER = '/lib/Image/Saga (2012)';
const SERIES = {
    id: 's1', seriesName: 'Saga', coverUrl: '/covers/series.jpg', cvId: 4242, metadataId: '4242', metadataSource: 'COMICVINE', path: FOLDER,
    publisher: 'Image', year: 2012, matchState: 'MATCHED',
    downloadedIssues: [], missingIssues: [],
    specials: [], missingSpecials: [], collectedEditions: [], missingCollectedEditions: [], duplicates: [], coveredIssues: [],
};
const EXISTING = {
    id: 'r1', seriesId: 's1', userId: 'u2', rating: 4, text: 'A space opera done right.',
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', user: { username: 'marko', avatar: null },
};

const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 25)); }); };

let fetchMock: ReturnType<typeof stubFetchRouter>;
const renderPage = async (routes: { save: () => unknown; reread: () => unknown }) => {
    let reads = 0;
    fetchMock = stubFetchRouter([
        ['/api/library/series?', () => ok(SERIES)],
        ['/api/admin/config', () => ok({ settings: [] })],
        ['/api/reviews', (_u, init) => {
            if (init?.method === 'POST') return routes.save();
            reads += 1;
            return reads === 1 ? ok({ reviews: [EXISTING], avgRating: '4.0', total: 1 }) : routes.reread();
        }],
    ]);
    await act(async () => { render(<SeriesPage />); });
    await settle();
};
const submitFourStars = async () => {
    const form = screen.getByText('Leave a Review').parentElement as HTMLElement;
    await act(async () => { fireEvent.click(form.querySelectorAll('svg')[3]); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Submit Review/ })); });
    await settle();
};
const toastTitles = () => toastMock.toast.mock.calls.map(([t]) => t?.title);

describe('Series page: saving a review', () => {
    beforeEach(() => { toastMock.toast.mockClear(); localStorage.clear(); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('keeps the page and the reviews shown when the re-read after a save fails', async () => {
        await renderPage({ save: () => ok({ success: true }), reread: () => err(500, { error: 'database is locked' }) });
        expect(screen.getByText('A space opera done right.')).toBeInTheDocument();

        await submitFourStars();

        expect(toastTitles()).toContain('Review Saved!');
        expect(screen.getByText('Community Reviews')).toBeInTheDocument();
        expect(screen.getByText('A space opera done right.')).toBeInTheDocument();
        expect(screen.getByText('4.0 / 5')).toBeInTheDocument();
    });

    it('shows the list and the average as the server has them after a save', async () => {
        const mine = { ...EXISTING, id: 'r2', userId: 'u1', rating: 4, text: null, user: { username: 'adam', avatar: null } };
        await renderPage({ save: () => ok({ success: true }), reread: () => ok({ reviews: [mine, EXISTING], avgRating: '4.0', total: 2 }) });

        await submitFourStars();

        expect(screen.getByText('adam')).toBeInTheDocument();
        expect(screen.getByText('(2 ratings)')).toBeInTheDocument();
    });

    it("says a refused save failed, with the server's reason, and doesn't re-read", async () => {
        await renderPage({ save: () => err(400, { error: 'Rating must be between 1 and 5.' }), reread: () => ok({ reviews: [], avgRating: '0.0', total: 0 }) });

        await submitFourStars();

        expect(toastTitles()).not.toContain('Review Saved!');
        expect(toastMock.toast).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Failed to save review', description: 'Rating must be between 1 and 5.', variant: 'destructive',
        }));
        const reviewReads = fetchMock.mock.calls.filter(([u, init]) => String(u).startsWith('/api/reviews') && init?.method !== 'POST');
        expect(reviewReads).toHaveLength(1);
        expect(screen.getByText('A space opera done right.')).toBeInTheDocument();
    });
});
