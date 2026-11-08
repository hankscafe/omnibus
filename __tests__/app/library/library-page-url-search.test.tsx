// @vitest-environment jsdom
// The library page's search box and the address's ?q= (a "search the library" link, the header
// search). The page copies ?q= into the box only when the ADDRESS changes: the effect that does it
// reads the current search to compare, but must not re-run when that search changes - if it did,
// every search you type would be put back to the address's ?q= the moment its 500 ms debounce
// landed. That is the trap in the effect's exhaustive-deps warning (the "fix" the rule suggests is
// exactly that regression), so these pin both halves.
//
// useSearchParams here returns ONE URLSearchParams until a test swaps it, like Next does for an
// unchanged address (the other library-page tests return a new one per render, which re-runs every
// searchParams effect on every render and can't tell the two cases apart).
//
// Waits are separate act() calls: state set inside an act() only lands when that act ends.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ok, stubFetchRouter } from '../../helpers/fetch';

const toast = vi.fn();
const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: { user: { id: 'user_1', role: 'USER' } }, status: 'authenticated' }),
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => nav.params,
}));
import LibraryPage from '@/app/library/page';

let searches: string[] = [];
const box = () => screen.getByLabelText('Search text box') as HTMLInputElement;
const settle = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

describe('LibraryPage search box vs the address ?q=', () => {
    beforeEach(() => {
        searches = [];
        toast.mockClear();
        localStorage.clear();
        nav.params = new URLSearchParams('q=batman');
        vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
        vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
        window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
        stubFetchRouter([
            ['/api/library/follow', () => ok({ seriesIds: [] })],
            ['/api/reading-lists', () => ok([])],
            ['/api/library?', (u) => {
                const params = new URL(u, 'http://localhost').searchParams;
                if (params.get('namesOnly')) return ok({ names: [] });
                searches.push(params.get('q') ?? '');
                return ok({ series: [], hasMore: false, publishers: [] });
            }],
        ]);
    });

    it('opens with the search the address carries', async () => {
        await act(async () => { render(<LibraryPage />); });
        expect(box().value).toBe('batman');
        expect(searches[0]).toBe('batman');
    });

    it('a new ?q= in the address replaces the search', async () => {
        let view!: ReturnType<typeof render>;
        await act(async () => { view = render(<LibraryPage />); });
        await settle(150);  // past the page's 100 ms first-render window, which skips filter reloads
        nav.params = new URLSearchParams('q=robin');
        await act(async () => { view.rerender(<LibraryPage />); });
        await settle(25);
        expect(box().value).toBe('robin');
        expect(searches.at(-1)).toBe('robin');
    });

    it('a typed search is not put back to the address ?q= when its debounce lands', async () => {
        let view!: ReturnType<typeof render>;
        await act(async () => { view = render(<LibraryPage />); });
        await act(async () => { fireEvent.change(box(), { target: { value: 'superman' } }); });
        await settle(650);  // the 500 ms debounce fires and sets the search the page loads with
        await settle(25);   // ...and anything that reacts to it gets its own act to land in
        expect(box().value).toBe('superman');
        expect(searches.at(-1)).toBe('superman');

        // A re-render with the address unchanged (same URLSearchParams) leaves it alone too.
        await act(async () => { view.rerender(<LibraryPage />); });
        await settle(25);
        expect(box().value).toBe('superman');
        expect(searches.at(-1)).toBe('superman');
    });

    // The one job no other effect does: a non-empty ?q= is also copied by the effect above it, but
    // only this one clears the box when the address arrives with no ?q= (the Library link in the
    // nav). It must compare against the search as it is NOW, not as it was when the page opened.
    it('an address with no ?q= clears a typed search', async () => {
        nav.params = new URLSearchParams();
        let view!: ReturnType<typeof render>;
        await act(async () => { view = render(<LibraryPage />); });
        await act(async () => { fireEvent.change(box(), { target: { value: 'superman' } }); });
        await settle(650);
        await settle(25);
        expect(searches.at(-1)).toBe('superman');

        nav.params = new URLSearchParams();  // navigated to /library again: a new, empty address
        await act(async () => { view.rerender(<LibraryPage />); });
        await settle(25);
        expect(box().value).toBe('');
        expect(searches.at(-1)).toBe('');
    });
});
