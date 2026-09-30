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
import { act, render, screen } from '@testing-library/react';
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

// The per-test timeout is the only clock left. A stalled chain can't spend it (act() returns once
// React work runs out, and the assertions fail in well under a second); it only has to outlast a
// slow-but-correct drain — up to 2.8 s measured on a loaded full-suite run vs vitest's 5 s default.
describe('LibraryPage grid pagination (scroll-saga client half)', { timeout: 15_000 }, () => {
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
