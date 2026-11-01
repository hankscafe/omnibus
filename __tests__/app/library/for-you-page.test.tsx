// @vitest-environment jsdom
// Library-aware recommendations, Beta C: the For Your Library page and the front-page shelf read the
// engine-built cache, show WHY each series is here, and offer Monitor (the monitor-only request the
// reading-list auto-build files) and Not interested (per user, undoable).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ok, err, stubFetchRouter } from '../../helpers/fetch';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/components/ui/toast', () => ({ ToastAction: (p: any) => <button onClick={p.onClick}>{p.children}</button> }));

const auth = vi.hoisted(() => ({ session: null as any }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: auth.session }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/library/for-you', useSearchParams: () => new URLSearchParams() }));

import ForYouPage from '@/app/library/for-you/page';
import { ForYouShelf, becauseLabel, seedHeadline, joinNames, dailyWindow } from '@/components/for-you-shelf';

const item = (volumeId: string, name: string, over: any = {}) => ({
    volumeId, name, startYear: 2023, publisher: 'Marvel', image: `/api/library/cover?path=${volumeId}`, countOfIssues: 36,
    description: null, siteUrl: null, score: 2.5,
    because: [{ kind: 'PERSON', id: '82750', name: 'Jed MacKay' }, { kind: 'CHARACTER', id: '1459', name: 'Cyclops' }, { kind: 'CHARACTER', id: '1462', name: 'Beast' }, { kind: 'CHARACTER', id: '2267', name: 'Hulk' }],
    metadataSource: 'COMICVINE', ...over,
});
const seeds = [
    { kind: 'PERSON', id: '58926', name: 'Scott Snyder', weight: 1, series: 2, role: 'creative' },
    { kind: 'PERSON', id: '82750', name: 'Jed MacKay', weight: 0.7, series: 1, role: 'creative' },
    { kind: 'CHARACTER', id: '1459', name: 'Cyclops', weight: 1, series: 9, role: 'character' },
    { kind: 'CHARACTER', id: '1440', name: 'Wolverine', weight: 0.9, series: 10, role: 'character' },
];
const response = (items: any[], over: any = {}) => ({ builtAt: '2026-09-13T12:46:33Z', reason: null, seeds, items, total: items.length, nextOffset: null, ...over });

describe('for-you helpers', () => {
    it('labels the reasons with a count for the rest, and interleaves seed kinds for the headline', () => {
        expect(becauseLabel(item('1', 'x').because, 2)).toBe('Jed MacKay, Cyclops +2');
        expect(becauseLabel(item('1', 'x').because, 3)).toBe('Jed MacKay, Cyclops, Beast +1');
        expect(becauseLabel([], 2)).toBe('');
        expect(seedHeadline(seeds as any, 3)).toEqual(['Scott Snyder', 'Cyclops', 'Jed MacKay']);
        expect(joinNames(['A'])).toBe('A');
        expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
    });

    it('rotates a daily window through the ranked list and wraps at the end', () => {
        const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        expect(dailyWindow(items, 7, 0)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(dailyWindow(items, 7, 1)).toEqual([8, 9, 10, 1, 2, 3, 4]);
        expect(dailyWindow([1, 2, 3], 7, 5)).toEqual([1, 2, 3]);
    });
});

describe('/library/for-you', () => {
    let requests: any[];
    let dismissals: { method: string; body: any }[];
    let triggers: any[];

    beforeEach(() => {
        vi.clearAllMocks();
        requests = []; dismissals = []; triggers = [];
        auth.session = { user: { id: 'u1', role: 'USER', canRequest: true } };
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    const setup = (items: any[], over: any = {}) => stubFetchRouter([
        ['/api/recommendations/for-you/dismiss', (_u: string, init?: any) => { dismissals.push({ method: init.method, body: JSON.parse(init.body) }); return ok({ success: true }); }],
        ['/api/recommendations/for-you', () => ok(response(items, over))],
        ['/api/request', (_u: string, init?: any) => { requests.push(JSON.parse(init.body)); return ok({ success: true, message: 'Subscribed! Omnibus will automatically download future issues.' }); }],
        ['/api/admin/jobs/trigger', (_u: string, init?: any) => { triggers.push(JSON.parse(init.body)); return ok({ success: true }); }],
    ]);

    it('shows every recommendation with its reasons, and the seeds it was built from', async () => {
        setup([item('1', 'Avengers'), item('2', 'X-Men by Jed MacKay')]);
        render(<ForYouPage />);
        expect(await screen.findByRole('heading', { level: 1, name: /For Your Library/ })).toBeTruthy();
        expect(await screen.findByText('Avengers')).toBeTruthy();
        const card = screen.getByTestId('for-you-card-1');
        expect(within(card).getByText(/Because you collect Jed MacKay, Cyclops, Beast \+1/)).toBeTruthy();
        expect(within(card).getByText(/2023 · Marvel · 36 issues/)).toBeTruthy();
        // Seeds as chips, creators and characters apart.
        expect(screen.getByText('Scott Snyder')).toBeTruthy();
        expect(screen.getByText('Wolverine')).toBeTruthy();
        expect(screen.getByText(/2 series/)).toBeTruthy();
    });

    // Monitor was flex-1 beside a fixed-width Not interested, so in a 146-225px grid card it got
    // whatever was left (~40-70px) and its label was crushed. The two stack, each full width, the way
    // the front-page shelf's hover overlay already does.
    it("the grid card stacks Monitor over Not interested, each full width", async () => {
        setup([item('1', 'Avengers')]);
        render(<ForYouPage />);
        const card = await screen.findByTestId('for-you-card-1');
        const monitor = within(card).getByRole('button', { name: 'Monitor Avengers' });
        const dismiss = within(card).getByRole('button', { name: 'Not interested in Avengers' });
        const classes = (el: Element) => el.className.split(/\s+/);

        expect(monitor.parentElement).toBe(dismiss.parentElement);
        expect(classes(monitor.parentElement!)).toContain('flex-col');
        expect(classes(monitor)).toContain('w-full');
        expect(classes(dismiss)).toContain('w-full');
    });

    it("Monitor files the reading-list's monitor-only request payload and takes the card off the page", async () => {
        setup([item('158000', 'Avengers'), item('2', 'Other')]);
        render(<ForYouPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Monitor Avengers' }));
        await waitFor(() => expect(requests).toHaveLength(1));
        expect(requests[0]).toEqual({
            cvId: 158000, name: 'Avengers', type: 'volume', year: '2023', publisher: 'Marvel',
            image: '/api/library/cover?path=158000', metadataSource: 'COMICVINE', monitorOnly: true,
        });
        await waitFor(() => expect(screen.queryByTestId('for-you-card-158000')).toBeNull());
        expect(screen.getByTestId('for-you-card-2')).toBeTruthy();
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Monitoring Avengers' }));
    });

    it('a refused Monitor keeps the card and says why', async () => {
        stubFetchRouter([
            ['/api/recommendations/for-you', () => ok(response([item('1', 'Avengers')]))],
            ['/api/request', () => err(403, { error: "You don't have permission to make requests." })],
        ]);
        render(<ForYouPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Monitor Avengers' }));
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive', description: "You don't have permission to make requests." })));
        expect(screen.getByTestId('for-you-card-1')).toBeTruthy();
    });

    it('Not interested records a dismissal, hides the card, and Undo puts it back where it was', async () => {
        setup([item('1', 'First'), item('2', 'Avengers'), item('3', 'Third')]);
        render(<ForYouPage />);
        expect(await screen.findByText(/3 series ·/)).toBeTruthy();
        fireEvent.click(await screen.findByRole('button', { name: 'Not interested in Avengers' }));
        await waitFor(() => expect(dismissals).toEqual([{ method: 'POST', body: { volumeId: '2', source: 'COMICVINE' } }]));
        await waitFor(() => expect(screen.queryByTestId('for-you-card-2')).toBeNull());
        expect(screen.getByText(/2 series ·/)).toBeTruthy();
        const call = toast.mock.calls.find(c => c[0]?.title === 'Hidden from your recommendations');
        expect(call).toBeTruthy();
        // The toast's Undo action deletes the dismissal and restores the card in its old slot.
        const { container } = render(call![0].action);
        fireEvent.click(within(container).getByText('Undo'));
        await waitFor(() => expect(dismissals[1]).toEqual({ method: 'DELETE', body: { volumeId: '2', source: 'COMICVINE' } }));
        await waitFor(() => expect(screen.getByTestId('for-you-card-2')).toBeTruthy());
        const order = screen.getAllByTestId(/for-you-card-/).map(el => el.getAttribute('data-testid'));
        expect(order).toEqual(['for-you-card-1', 'for-you-card-2', 'for-you-card-3']);
        expect(screen.getByText(/3 series ·/)).toBeTruthy();
    });

    it('a user without the Request permission sees Not interested but never Monitor', async () => {
        auth.session = { user: { id: 'u2', role: 'USER', canRequest: false } };
        setup([item('1', 'Avengers')]);
        render(<ForYouPage />);
        await screen.findByText('Avengers');
        expect(screen.queryByRole('button', { name: /^Monitor/ })).toBeNull();
        expect(screen.getByRole('button', { name: 'Not interested in Avengers' })).toBeTruthy();
    });

    it('before the first build an admin can start one; a member is told to wait', async () => {
        auth.session = { user: { id: 'a1', role: 'ADMIN' } };
        setup([], { builtAt: null, seeds: [] });
        render(<ForYouPage />);
        expect(await screen.findByText('Nothing built yet')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Build recommendations now' }));
        await waitFor(() => expect(triggers).toEqual([{ job: 'for_you' }]));
    });

    it('explains an empty build in the engine\'s own terms', async () => {
        setup([], { reason: 'no_credits', seeds: [] });
        render(<ForYouPage />);
        expect(await screen.findByText('Your series need a metadata sync first')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Build recommendations now' })).toBeNull();
    });
});

describe('front-page shelf', () => {
    beforeEach(() => { vi.clearAllMocks(); auth.session = { user: { id: 'u1', role: 'USER', canRequest: true } }; });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('renders up to seven cards under the same bare heading and See All link the sibling shelves use', async () => {
        const items = Array.from({ length: 10 }, (_, i) => item(String(i + 1), `Series ${i + 1}`));
        stubFetchRouter([['/api/recommendations/for-you', () => ok(response(items))]]);
        render(<ForYouShelf />);
        const heading = await screen.findByRole('heading', { level: 2, name: 'For Your Library' });
        expect(heading.querySelector('svg')).toBeNull(); // no icon, like Recently Added
        expect(screen.queryByText(/Series you don.t have/)).toBeNull(); // no subtitle, like the others (cards keep their own reason line)
        expect(screen.getAllByRole('button', { name: /^Monitor / })).toHaveLength(7);
        // Desktop + mobile See All, both to the page, styled as the sibling shelves' links.
        const links = screen.getAllByRole('link', { name: 'See every recommendation for your library' }) as HTMLAnchorElement[];
        expect(links).toHaveLength(2);
        expect(links.every(l => l.getAttribute('href') === '/library/for-you')).toBe(true);
        expect(links.every(l => l.textContent?.trim().startsWith('See All'))).toBe(true);
    });

    it('stays out of the way when nothing has been built', async () => {
        stubFetchRouter([['/api/recommendations/for-you', () => ok({ builtAt: null, seeds: [], items: [], total: 0, nextOffset: null })]]);
        const { container } = render(<ForYouShelf />);
        await new Promise(r => setTimeout(r, 30));
        expect(container.textContent).toBe('');
    });
});
