// @vitest-environment jsdom
// #260: a request waiting on a manual GetComics download put Download Manually, Upload File,
// Interactive Search and Retry GetComics in one right-aligned row that never wrapped. On a phone the
// row was wider than the card and ran off its left edge, so the first buttons (and Series, when the
// series is in the library) couldn't be tapped. The lab walk found it at every width below lg too:
// from sm to md the four in one row (~600px) are wider than the card, and from md, where the buttons
// move beside the title, the whole row (~740px) ran off the card's right edge and squeezed the title
// to nothing. The row now wraps, and the four GetComics buttons sit two per line until lg, taking only
// the width they need from md; from lg the card has room for one row.
// The same walk found Unmatched Finished Downloads doing it too: the "Link to request..." dropdown
// lists every request, grew to its longest name and pushed Link off the right edge; it now shrinks to
// the row.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { ok, stubFetchRouter } from '../../helpers/fetch';

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: { user: { id: 'admin_1', role: 'ADMIN' } }, status: 'authenticated' }),
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/admin',
}));

import AdminPage from '@/app/admin/page';

const manual = {
    id: 'r1', status: 'MANUAL_DDL', seriesName: 'Batman #1', activeDownloadName: 'Batman #1', userName: 'reader',
    createdAt: '2026-10-29T12:00:00.000Z', imageUrl: null, progress: 0, retryCount: 0,
    downloadLink: 'https://getcomics.org/dls/batman-1', seriesPath: '/library/DC Comics/Batman (2016)',
};

// Whole class tokens, so 'sm:flex' is never satisfied by 'sm:flex-row' or 'flex-wrap' by 'md:flex-wrap'.
const classes = (el: Element) => el.className.split(/\s+/);

describe('Admin dashboard: request buttons fit a phone (#260)', () => {
    let downloads: Record<string, string>[];

    beforeEach(() => {
        downloads = [];
        stubFetchRouter([
            ['/api/admin/requests', () => ok([manual])],
            ['/api/admin/stats', () => ok({ success: true, totalRequests: 1, completed30d: 0, failed30d: 0, totalUsers: 1 })],
            ['/api/admin/active-downloads', () => ok({ success: true, activeDownloads: downloads })],
            ['/api/admin/health', () => ok({ checks: [] })],
        ]);
    });

    // The GetComics buttons' own group, and the request's whole button row around it.
    const renderManualRow = async () => {
        await act(async () => { render(<AdminPage />); });
        const group = screen.getByRole('link', { name: /download manually/i }).parentElement!;
        return { group, row: group.parentElement! };
    };

    it("the request's button row wraps instead of running off the card", async () => {
        const { row } = await renderManualRow();

        expect(classes(row)).toContain('flex-wrap');
        within(row).getByRole('link', { name: /series/i });
    });

    it('the four GetComics buttons sit two per line until lg, and in one row from lg up', async () => {
        const { group } = await renderManualRow();

        expect(classes(group)).toEqual(expect.arrayContaining(['grid', 'grid-cols-2', 'w-full', 'md:w-auto', 'lg:flex']));
        within(group).getByRole('button', { name: /upload file/i });
        within(group).getByRole('button', { name: /interactive search/i });
        within(group).getByRole('button', { name: /retry getcomics/i });
    });

    it("an unmatched download's request dropdown shrinks to the row, keeping Link on screen", async () => {
        downloads = [{ id: 'hash1', name: 'Batman.001.2016.Digital.cbz', progress: '100', status: 'completed', clientName: 'qBittorrent', size: '48 MB' }];
        await act(async () => { render(<AdminPage />); });

        const select = screen.getByDisplayValue('Link to request...');
        expect(classes(select)).toEqual(expect.arrayContaining(['flex-1', 'min-w-0']));
        within(select.parentElement!).getByRole('button', { name: 'Link' });
    });
});
