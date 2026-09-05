// @vitest-environment jsdom
// /library/issues as a linkable destination. The page's filters used to be pure component state,
// so /library/issues?status=WANTED — the "missing issues" entry point (field report by
// robotshavehearts2, who never found the Wanted select) — would have opened on the whole library.
// These tests pin the two directions: a deep link lands ALREADY filtered with a single fetch and
// no self-rewrite, and a filter the user changes is written back to the URL so the view is
// shareable.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ok, stubFetchRouter } from '../../helpers/fetch';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const nav = vi.hoisted(() => ({
    params: new URLSearchParams(),
    push: vi.fn(),
    replace: vi.fn(),
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: nav.push, replace: nav.replace }),
    usePathname: () => '/library/issues',
    useSearchParams: () => nav.params,
}));

import LibraryIssuesPage from '@/app/library/issues/page';

const emptyPage = { issues: [], nextCursor: null, hasMore: false, publishers: ['DC Comics'] };

describe('/library/issues — URL as filter state', () => {
    let issueFetches: string[];

    beforeEach(() => {
        vi.clearAllMocks();
        issueFetches = [];
        nav.params = new URLSearchParams();
        stubFetchRouter([['/api/library/issues', (url: string) => { issueFetches.push(url); return ok(emptyPage); }]]);
        // jsdom implements neither; the page calls both on filter changes / list growth.
        vi.stubGlobal('scrollTo', vi.fn());
        vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} });
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('lands a ?status=WANTED deep link already filtered, with one fetch and no self-rewrite', async () => {
        nav.params = new URLSearchParams('status=WANTED');

        render(<LibraryIssuesPage />);

        // The page says what it is, rather than "All Issues" with a select quietly set.
        expect(await screen.findByRole('heading', { level: 1, name: /Missing Issues/ })).toBeTruthy();
        await waitFor(() => expect(issueFetches).toHaveLength(1));
        expect(issueFetches[0]).toContain('status=WANTED');
        // Seeding from the URL must not turn around and rewrite the URL.
        expect(nav.replace).not.toHaveBeenCalled();
    });

    it('never forwards a value it does not recognise', async () => {
        nav.params = new URLSearchParams('status=BOGUS&sort=nope');

        render(<LibraryIssuesPage />);

        expect(await screen.findByRole('heading', { level: 1, name: /All Issues/ })).toBeTruthy();
        await waitFor(() => expect(issueFetches).toHaveLength(1));
        expect(issueFetches[0]).not.toContain('status=');
        expect(issueFetches[0]).toContain('sort=release_desc');
    });

    it('seeds a search from the URL into the FIRST fetch, not a second one after the debounce', async () => {
        nav.params = new URLSearchParams('q=Batman');

        render(<LibraryIssuesPage />);

        await waitFor(() => expect(issueFetches).toHaveLength(1));
        expect(issueFetches[0]).toContain('q=Batman');
        expect((screen.getByLabelText('Search issues') as HTMLInputElement).value).toBe('Batman');
        // Outlast the 400ms debounce: a seeded search must not trigger a narrower reload.
        await new Promise(r => setTimeout(r, 550));
        expect(issueFetches).toHaveLength(1);
        expect(nav.replace).not.toHaveBeenCalled();
    });

    it('writes a changed filter back to the URL, on top of what the link carried', async () => {
        nav.params = new URLSearchParams('status=WANTED');
        render(<LibraryIssuesPage />);
        await waitFor(() => expect(issueFetches).toHaveLength(1));

        fireEvent.change(screen.getByLabelText('Search issues'), { target: { value: 'Batman' } });

        // After the debounce: one more fetch carrying the search, and the URL updated with
        // `replace` (a filter change is not a history entry) and no scroll jump.
        await waitFor(() => expect(issueFetches).toHaveLength(2));
        expect(issueFetches[1]).toContain('status=WANTED');
        expect(issueFetches[1]).toContain('q=Batman');
        await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/library/issues?status=WANTED&q=Batman', { scroll: false }));
        expect(nav.push).not.toHaveBeenCalled();
    });
});
