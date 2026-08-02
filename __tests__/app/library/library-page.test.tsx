// @vitest-environment jsdom
// The library page's load/append loop — the component side of the scroll saga (v1.4.0 dupes →
// v1.4.1 tiebreakers → v1.4.2 plain-grid rewrite). The route-level tests pin the server's total
// order; until now NOTHING pinned the client half: page-windowed fetches, append-dedupe by id,
// the sentinel re-check that advances pagination, and the hasMore stop. These tests drive the
// REAL page component in jsdom, where getBoundingClientRect() is all zeros — so the v1.4.2
// after-append re-check (sentinel top < viewport+800) fires naturally after every append and
// pagination advances without simulating IntersectionObserver crossings (the observer itself is
// stubbed inert; only the re-check path drives).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ok, stubFetchRouter } from '../../helpers/fetch';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: { user: { id: 'admin_1', role: 'ADMIN' } }, status: 'authenticated' }),
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));

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

describe('LibraryPage grid pagination (scroll-saga client half)', () => {
    beforeEach(() => {
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
        render(<LibraryPage />);

        // Initial window lands…
        await screen.findByText('Series 01');
        // …then the after-append re-check advances exactly one page and the hasMore=false stop holds.
        await screen.findByText('Series 26');
        await waitFor(() => expect(listCalls).toHaveLength(2));

        expect(listCalls[0]).toContain('page=1');
        expect(listCalls[1]).toContain('page=2');
        // A settle pass: series.length changed again after page 2, the re-check ran again — the
        // hasMore guard must hold the line at two requests (no endReached storm).
        await new Promise(r => setTimeout(r, 25));
        expect(listCalls).toHaveLength(2);
        expect(toast).not.toHaveBeenCalled();
    });

    it('dedupes appended rows by id — an overlapping page window can never render twice', async () => {
        render(<LibraryPage />);
        await screen.findByText('Series 26');

        // Series 24 arrived in BOTH windows (the pg tie-order overlap shape); one card, not two.
        expect(screen.getAllByText('Series 24')).toHaveLength(1);
        expect(screen.getAllByText(/^Series \d\d$/)).toHaveLength(26); // 24 + 2 fresh, no dupes
    });
});
