// @vitest-environment jsdom
// v1.4.11-beta.027 (lint batch 3c): the Smart Matcher's payloads got real types, and five reads had to
// be rewritten to satisfy them - the auto-scan's year for a loose file, the provider label and folder
// preview of a row's suggestion, the metadata editor's seed, and the bulk mapping's cover thumbnails.
// These tests pin what each one does on the REAL page, so the rewrite is proven to change nothing
// (they pass on the page before the batch too).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { ok, stubFetchRouter, stubImmediateTimers } from '../../helpers/fetch';

const { toast, dialogProps } = vi.hoisted(() => ({ toast: vi.fn(), dialogProps: [] as any[] }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: { user: { id: 'admin_1', role: 'ADMIN' } }, status: 'authenticated' }),
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));
// The real folder preview and helpers; only the dialog itself is replaced, by a stub that records
// the props the page hands it.
vi.mock('@/components/smart-match-metadata-dialog', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('@/components/smart-match-metadata-dialog');
    return { ...actual, default: (props: any) => { dialogProps.push(props); return null; } };
});
vi.mock('@/components/page-manager-modal', () => ({ default: () => null }));

import SmartMatchPage from '@/app/admin/smart-match/page';

const CONFIG = (provider: string) => ok({
    settings: [
        { key: 'metron_user', value: 'u' }, { key: 'metron_pass', value: 'p' },
        { key: 'primary_metadata_source', value: provider },
        { key: 'folder_naming_pattern', value: '{Publisher}/{Series} ({Year})' },
        { key: 'metadata_write_comicinfo', value: 'true' },
    ],
});

const RAW = (name: string) => ({
    id: `raw_${name}`, name, folderPath: `/unmatched/${name}.cbz`, isRawFile: true,
});
const SERIES_ROW = (id: string, name: string, year: number) => ({
    id, name, year, publisher: null, folderPath: `/library/${name}`, matchState: 'UNMATCHED', isIgnored: false,
});

const METRON_RESULT = {
    id: 16180, name: 'Conan & Dragonero', year: 2026, publisher: 'Sergio Bonelli Editore',
    count: 5, image: '/api/library/cover?path=conan.jpg', description: 'crossover', metadataSource: 'METRON',
};

const lastDialog = () => dialogProps[dialogProps.length - 1];

beforeEach(() => {
    toast.mockClear();
    dialogProps.length = 0;
    localStorage.clear();
    sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('Smart Matcher - the auto-scan query year', () => {
    it('uses a folder\'s own year, else the year in its name; a loose file always takes its name\'s year', async () => {
        stubImmediateTimers(1500);
        const searches: string[] = [];
        stubFetchRouter([
            ['/api/admin/unmatched', () => ok([
                SERIES_ROW('s_zagor', 'Zagor', 1999),
                SERIES_ROW('s_mystere', 'Martin Mystere (1982)', 0),
                RAW('Dylan Dog 001 (1986)'),
            ])],
            ['/api/admin/config', () => CONFIG('METRON')],
            ['/api/admin/sweep', () => ok({})],
            ['/api/search', (u) => { searches.push(new URL(u, 'http://localhost').searchParams.get('q') || ''); return ok({ results: [], hasMore: false }); }],
        ]);
        render(<SmartMatchPage />);
        await screen.findByText('Zagor');
        fireEvent.click(screen.getByRole('button', { name: /Start Auto-Scan/ }));

        await waitFor(() => expect(searches).toHaveLength(3), { timeout: 5000 });
        expect(searches).toEqual(expect.arrayContaining(['Zagor 1999', 'Martin Mystere 1982', 'Dylan Dog 1986']));
    });
});

describe('Smart Matcher - a row\'s suggestion', () => {
    const scanWith = async (results: unknown[]) => {
        stubFetchRouter([
            ['/api/admin/unmatched', () => ok([RAW('Conan & Dragonero 001')])],
            ['/api/admin/config', () => CONFIG('METRON')],
            ['/api/admin/sweep', () => ok({})],
            ['/api/admin/match-prefill', () => ok({ hasContent: false, prefill: null })],
            ['/api/search', () => ok({ results, hasMore: false })],
        ]);
        render(<SmartMatchPage />);
        await screen.findByText('Conan & Dragonero 001');
        fireEvent.click(screen.getByRole('button', { name: /Start Auto-Scan/ }));
    };

    it('labels a NOT_FOUND row with the active provider', async () => {
        await scanWith([]);
        await screen.findByText('No confident match found.');
        expect(screen.getByText('Metron Suggestion')).toBeTruthy();
    });

    it('labels a found suggestion with the provider it came from', async () => {
        await scanWith([{ ...METRON_RESULT, metadataSource: 'COMICVINE' }]);
        await screen.findByText('Sergio Bonelli Editore • 2026');
        expect(screen.getByText('ComicVine Suggestion')).toBeTruthy();
        expect(screen.queryByText('Metron Suggestion')).toBeNull();
    });

    it('seeds the metadata editor from the suggestion, and previews the folder it will land in', async () => {
        // A ComicVine pick while the page's provider is Metron: the seed keeps the pick's own provider.
        await scanWith([{ ...METRON_RESULT, metadataSource: 'COMICVINE' }]);
        await screen.findByText('Sergio Bonelli Editore • 2026');

        fireEvent.click(screen.getByRole('button', { name: /Edit Metadata/ }));
        await waitFor(() => expect(lastDialog()?.open).toBe(true));
        expect(lastDialog().seed).toEqual({
            name: 'Conan & Dragonero', year: 2026, publisher: 'Sergio Bonelli Editore', description: 'crossover',
            image: '/api/library/cover?path=conan.jpg', metadataId: 16180, metadataSource: 'COMICVINE', credits: undefined,
        });
        expect(lastDialog().seriesMetadataId).toBe(16180);
        expect(lastDialog().metadataSource).toBe('COMICVINE');
        // An auto-scan suggestion carries no credits, so "fill from provider" has nothing to offer.
        expect(lastDialog().providerFields).toBeUndefined();

        // A saved override with only a Series Group: the preview takes the rest from the suggestion.
        act(() => { lastDialog().onSave({ seriesGroup: 'Bonelli' }); });
        await screen.findByText('Sergio Bonelli Editore/Conan & Dragonero (2026)');
    });
});

describe('Smart Matcher - bulk mapping cover thumbnails', () => {
    const bulkPick = async (source: string, issues: unknown[], coverCalls: unknown[]) => {
        stubFetchRouter([
            ['/api/admin/unmatched', () => ok([RAW('Conan & Dragonero 001'), RAW('Conan & Dragonero 002')])],
            ['/api/admin/config', () => CONFIG('METRON')],
            ['/api/admin/sweep', () => ok({})],
            ['/api/search', () => ok({ results: [{ ...METRON_RESULT, metadataSource: source }], hasMore: false })],
            ['/api/issue-details/covers', (_u, init) => { coverCalls.push(JSON.parse(init.body)); return ok({ covers: { 171893: '/cv/1.jpg', 171894: '/cv/2.jpg' } }); }],
            ['/api/issue-details', () => ok({
                id: 16180, name: 'Conan & Dragonero', volumeId: 16180, publisher: 'Sergio Bonelli Editore',
                image: null, year: '2026', description: 'crossover', count: 5, issues,
            })],
        ]);
        render(<SmartMatchPage />);
        await screen.findByText('Conan & Dragonero 001');
        fireEvent.click(screen.getByRole('button', { name: /^Select$/ }));
        fireEvent.click(screen.getByRole('button', { name: /Select All/ }));
        // The bar's Search Match (the cards' own are disabled in selection mode).
        const bulkSearch = screen.getAllByRole('button', { name: /Search Match/ }).find(b => !(b as HTMLButtonElement).disabled)!;
        fireEvent.click(bulkSearch);
        fireEvent.change(await screen.findByPlaceholderText('e.g. The Amazing Spider-Man'), { target: { value: 'Conan & Dragonero' } });
        fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));
        fireEvent.click(await screen.findByText('Conan & Dragonero'));
    };
    const thumbs = () => Array.from(document.querySelectorAll('img')).map(i => i.getAttribute('src'));

    it('uses the covers a Metron issue list already carries, with no extra call', async () => {
        const coverCalls: unknown[] = [];
        await bulkPick('METRON', [
            { id: '171893', issue_number: '1', name: '#1', image: '/metron/1.jpg' },
            { id: '171894', issue_number: '2', name: '#2', image: '/metron/2.jpg' },
        ], coverCalls);
        await waitFor(() => expect(thumbs()).toEqual(expect.arrayContaining(['/metron/1.jpg', '/metron/2.jpg'])));
        expect(coverCalls).toHaveLength(0);
    });

    it('takes the thumbnail of an image object of sizes', async () => {
        const coverCalls: unknown[] = [];
        await bulkPick('METRON', [
            { id: '171893', issue_number: '1', name: '#1', image: { thumb_url: '/obj/1-thumb.jpg', small_url: '/obj/1-small.jpg' } },
            { id: '171894', issue_number: '2', name: '#2', image: { small_url: '/obj/2-small.jpg' } },
        ], coverCalls);
        await waitFor(() => expect(thumbs()).toEqual(expect.arrayContaining(['/obj/1-thumb.jpg', '/obj/2-small.jpg'])));
        expect(coverCalls).toHaveLength(0);
    });

    it('asks the batch route once for the covers a ComicVine issue list doesn\'t carry', async () => {
        const coverCalls: unknown[] = [];
        await bulkPick('COMICVINE', [
            { id: '171893', issue_number: '1', name: '#1' },
            { id: '171894', issue_number: '2', name: '#2', image: null },
        ], coverCalls);
        await waitFor(() => expect(thumbs()).toEqual(expect.arrayContaining(['/cv/1.jpg', '/cv/2.jpg'])));
        expect(coverCalls).toEqual([{ ids: ['171893', '171894'], provider: 'COMICVINE' }]);
    });
});
