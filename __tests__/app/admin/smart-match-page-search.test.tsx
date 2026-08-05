// @vitest-environment jsdom
// Search Match (#199 round 2, concept by CapitanoNemo78): the Smart Matcher's manual match is
// search-first — type a series name, pick from the provider's results — with the classic
// exact-ID lookup demoted to an "advanced" disclosure, not removed. These tests drive the REAL
// page in jsdom and pin the new wiring end to end: dialog copy, /api/search call shape, result
// rows, pick → volume resolution → Issue Mapping auto-fill (exact issue id from the file's
// number), Load more pagination, and the fallback ID path routing through the same resolver.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));
// The metadata dialog and page manager have their own test files — stub them inert here, but keep
// every named export the page imports (the partial-mock trap: missing exports fail at import time).
vi.mock('@/components/smart-match-metadata-dialog', () => ({
    default: () => null,
    buildFolderPreview: () => '',
    shouldEmbedIssueCover: () => undefined,
    COMIC_INFO_DEFAULT_KEYS: [],
}));
vi.mock('@/components/page-manager-modal', () => ({ default: () => null }));

import SmartMatchPage from '@/app/admin/smart-match/page';

const RAW_ITEM = {
    id: 'raw_Q29uYW4', name: 'Conan & Dragonero 001',
    folderPath: '/unmatched/Conan & Dragonero 001.cbz', isRawFile: true,
};

const SEARCH_RESULT = {
    id: 16180, name: 'Conan & Dragonero', year: 2026, publisher: 'Sergio Bonelli Editore',
    count: 5, image: null, description: 'crossover', metadataSource: 'METRON',
};

const VOLUME_DETAILS = {
    id: 16180, name: 'Conan & Dragonero', volumeName: 'Conan & Dragonero', volumeId: 16180,
    publisher: 'Sergio Bonelli Editore', image: null, year: '2026', description: 'crossover',
    count: 5,
    issues: [
        { id: '171893', issue_number: '1', name: 'Conan & Dragonero (2026) #1' },
        { id: '171894', issue_number: '2', name: 'Conan & Dragonero (2026) #2' },
    ],
};

let searchCalls: string[] = [];
let detailCalls: string[] = [];

const openSearchMatchDialog = async () => {
    render(<SmartMatchPage />);
    await screen.findByText('Conan & Dragonero 001');
    fireEvent.click(screen.getByRole('button', { name: /Search Match/ }));
    await screen.findByPlaceholderText('e.g. The Amazing Spider-Man');
};

describe('Smart Matcher — Search Match dialog', () => {
    beforeEach(() => {
        searchCalls = [];
        detailCalls = [];
        toast.mockClear();
        localStorage.clear();
        stubFetchRouter([
            ['/api/admin/unmatched', () => ok([RAW_ITEM])],
            ['/api/admin/config', () => ok({
                settings: [
                    { key: 'metron_user', value: 'u' }, { key: 'metron_pass', value: 'p' },
                    { key: 'primary_metadata_source', value: 'METRON' },
                    { key: 'folder_naming_pattern', value: '{Publisher}/{Series} ({Year})' },
                    { key: 'metadata_write_comicinfo', value: 'true' },
                ],
            })],
            ['/api/admin/sweep', () => ok({})],
            ['/api/search', (u) => {
                searchCalls.push(u);
                const page = new URL(u, 'http://localhost').searchParams.get('page');
                return page === '1'
                    ? ok({ results: [SEARCH_RESULT], hasMore: true })
                    : ok({ results: [{ ...SEARCH_RESULT, id: 999, name: 'Dragonero Adventures' }], hasMore: false });
            }],
            ['/api/issue-details', (u) => { detailCalls.push(u); return ok(VOLUME_DETAILS); }],
        ]);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('searches by name, picks a result, and auto-fills the exact issue id from the file number', async () => {
        await openSearchMatchDialog();

        fireEvent.change(screen.getByPlaceholderText('e.g. The Amazing Spider-Man'), { target: { value: 'Conan & Dragonero' } });
        fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));

        // The search hits /api/search with the query, page 1, and the page's provider…
        const row = await screen.findByText('Conan & Dragonero');
        expect(searchCalls[0]).toContain('q=Conan%20%26%20Dragonero');
        expect(searchCalls[0]).toContain('page=1');
        expect(searchCalls[0]).toContain('provider=METRON');
        expect(screen.getByText(/Sergio Bonelli Editore • 2026 • 5 issues/)).toBeTruthy();

        // …and picking the row resolves the volume under the RESULT'S OWN provider and auto-maps
        // "001" → issue #1's exact provider id.
        fireEvent.click(row);
        await waitFor(() => expect(detailCalls).toHaveLength(1));
        expect(detailCalls[0]).toContain('id=16180');
        expect(detailCalls[0]).toContain('type=volume');
        expect(detailCalls[0]).toContain('provider=METRON');
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Series Selected' })));
        await waitFor(() => expect(screen.getByDisplayValue('171893')).toBeTruthy());
        expect(await screen.findByRole('button', { name: /Apply Match/ })).toBeTruthy();
    });

    it('pages further results through Load more', async () => {
        await openSearchMatchDialog();
        fireEvent.change(screen.getByPlaceholderText('e.g. The Amazing Spider-Man'), { target: { value: 'Dragonero' } });
        fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));

        fireEvent.click(await screen.findByRole('button', { name: /Load more/ }));
        await screen.findByText('Dragonero Adventures');

        expect(searchCalls).toHaveLength(2);
        expect(searchCalls[1]).toContain('page=2');
        // hasMore=false on page 2 removes the button; page 1's row is still listed above it.
        expect(screen.queryByRole('button', { name: /Load more/ })).toBeNull();
        expect(screen.getByText('Conan & Dragonero')).toBeTruthy();
    });

    it('keeps the exact-ID lookup behind the advanced disclosure, routed through the same resolver', async () => {
        await openSearchMatchDialog();

        // Hidden until disclosed…
        expect(screen.queryByPlaceholderText('e.g. 4050-12345 or 12746')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Match by exact provider ID/ }));

        // …then the classic flow: pasted CV-prefixed id is sanitized before the volume fetch.
        fireEvent.change(await screen.findByPlaceholderText('e.g. 4050-12345 or 12746'), { target: { value: '4050-16180' } });
        fireEvent.click(screen.getByRole('button', { name: /Look Up/ }));

        await waitFor(() => expect(detailCalls).toHaveLength(1));
        expect(detailCalls[0]).toContain('id=16180');
        expect(detailCalls[0]).not.toContain('4050-');
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Series Selected' })));
    });

    it('re-resolves the exact issue id from a corrected number using the picked volume\'s own list', async () => {
        await openSearchMatchDialog();
        fireEvent.change(screen.getByPlaceholderText('e.g. The Amazing Spider-Man'), { target: { value: 'Conan & Dragonero' } });
        fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));
        fireEvent.click(await screen.findByText('Conan & Dragonero'));
        await waitFor(() => expect(screen.getByDisplayValue('171893')).toBeTruthy());

        // Right series, wrong issue: the admin corrects "1" → "2" and refreshes. The rawIssues list
        // is authoritative, so no second /api/issue-details call is made.
        fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '2' } });
        fireEvent.click(screen.getByRole('button', { name: /Refresh from number/ }));

        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Issue ID updated' })));
        expect(screen.getByDisplayValue('171894')).toBeTruthy();
        expect(detailCalls).toHaveLength(1);
    });

    it('falls back to one volume fetch when the match carries no issue list', async () => {
        let detailHits = 0;
        stubFetchRouter([
            ['/api/admin/unmatched', () => ok([RAW_ITEM])],
            ['/api/admin/config', () => ok({ settings: [{ key: 'primary_metadata_source', value: 'METRON' }] })],
            ['/api/admin/sweep', () => ok({})],
            ['/api/search', () => ok({ results: [SEARCH_RESULT], hasMore: false })],
            // First call (the pick) returns a volume WITHOUT issues — the auto-scan-shaped case;
            // the refresh's fallback fetch then returns the real list.
            ['/api/issue-details', () => { detailHits++; return ok(detailHits === 1 ? { ...VOLUME_DETAILS, issues: [] } : VOLUME_DETAILS); }],
        ]);
        await openSearchMatchDialog();
        fireEvent.change(screen.getByPlaceholderText('e.g. The Amazing Spider-Man'), { target: { value: 'Conan & Dragonero' } });
        fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));
        fireEvent.click(await screen.findByText('Conan & Dragonero'));
        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Series Selected' })));

        fireEvent.change(screen.getByPlaceholderText('e.g. 1'), { target: { value: '2' } });
        fireEvent.click(screen.getByRole('button', { name: /Refresh from number/ }));

        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Issue ID updated' })));
        expect(detailHits).toBe(2);
        expect(screen.getByDisplayValue('171894')).toBeTruthy();
    });

    it('reports an empty search honestly and suggests the ID fallback', async () => {
        stubFetchRouter([
            ['/api/admin/unmatched', () => ok([RAW_ITEM])],
            ['/api/admin/config', () => ok({ settings: [{ key: 'primary_metadata_source', value: 'METRON' }] })],
            ['/api/search', () => ok({ results: [], hasMore: false })],
        ]);
        await openSearchMatchDialog();
        fireEvent.change(screen.getByPlaceholderText('e.g. The Amazing Spider-Man'), { target: { value: 'Zzz Nothing' } });
        fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));

        await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'No results' })));
    });
});
