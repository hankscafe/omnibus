// @vitest-environment jsdom
// __tests__/components/metadata-editor-lock.test.tsx
//
// Issue #194 (f): the metadata editor now surfaces the manual-edits lock (hasCustomMetadata)
// and offers a one-click unlock, and a zero-change save reports "No changes" instead of
// pretending it saved (server-side it no longer locks or embeds). These tests pin the modal
// side of that contract.
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import MetadataEditorModal from '@/components/metadata-editor-modal';

const toastMock = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({
    useToast: () => ({ toast: toastMock }),
}));

global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn()
}));
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const fetchMock = vi.fn();
global.fetch = fetchMock as any;

const issueDetail = (overrides: Record<string, any> = {}) => ({
    number: '1', name: 'Issue 1', releaseDate: '', universe: '', description: 'db description',
    writers: ['Writer One'], artists: [], coverArtists: [], colorists: [], letterers: [],
    characters: [], teams: [], locations: [], genres: [], storyArcs: [],
    hasCustomMetadata: false,
    ...overrides,
});

function mockFetch(detail: Record<string, any>, patchResult: Record<string, any> = { success: true }) {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
        if (url === '/api/admin/config') {
            return { ok: true, json: async () => ({ settings: [{ key: 'metadata_write_comicinfo', value: 'true' }] }) };
        }
        if (typeof url === 'string' && url.startsWith('/api/library/issue?id=')) {
            return { ok: true, json: async () => detail };
        }
        if (url === '/api/library/issue' && init?.method === 'PATCH') {
            return { ok: true, json: async () => patchResult };
        }
        return { ok: true, json: async () => ({}) };
    });
}

const renderModal = () => render(
    <MetadataEditorModal
        open
        onOpenChange={vi.fn()}
        mode="issue"
        issue={{ id: 'i1', number: '1', seriesName: 'Trauma Team' }}
    />
);

describe('Metadata editor lock affordance (issue #194 (f))', () => {

    it('shows the lock notice for a locked issue and unlocks via clearCustomMetadata', async () => {
        mockFetch(issueDetail({ hasCustomMetadata: true }), { success: true, unlocked: true });
        renderModal();

        expect(await screen.findByText(/Manual-edits lock is on/i)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Remove Lock/i }));

        await waitFor(() => {
            const call = fetchMock.mock.calls.find(([url, init]: any[]) =>
                url === '/api/library/issue' && init?.method === 'PATCH');
            expect(call).toBeTruthy();
            expect(JSON.parse(call![1].body)).toEqual({ issueId: 'i1', clearCustomMetadata: true });
        });
        // The notice clears in place and the user is pointed at the re-sync.
        await waitFor(() => expect(screen.queryByText(/Manual-edits lock is on/i)).not.toBeInTheDocument());
        expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Lock removed' }));
    });

    it('shows no lock notice for an unlocked issue', async () => {
        mockFetch(issueDetail());
        renderModal();

        // Wait for the form to load, then confirm the notice is absent.
        await screen.findByText(/Write changes to ComicInfo\.xml/i);
        expect(screen.queryByText(/Manual-edits lock is on/i)).not.toBeInTheDocument();
    });

    it('reports "No changes to save" when the server says the save was a no-op', async () => {
        mockFetch(issueDetail(), { success: true, changed: false, wroteToFile: false });
        renderModal();

        await screen.findByText(/Write changes to ComicInfo\.xml/i);
        fireEvent.click(screen.getByRole('button', { name: /Save Metadata/i }));

        await waitFor(() => expect(toastMock).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'No changes to save' })));
    });
});

// ==== Issue #194 (f), series side: the same lock affordance + no-op honesty in series mode ====

const seriesProps = {
    currentPath: '/lib/DC/Batman (2020)', name: 'Batman', publisher: 'DC', year: 2020,
};

function mockSeriesFetch(seriesData: Record<string, any>, updateResult: Record<string, any> = { success: true, changed: true }) {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
        if (url === '/api/admin/config') {
            return { ok: true, json: async () => ({ settings: [{ key: 'metadata_write_comicinfo', value: 'true' }] }) };
        }
        if (typeof url === 'string' && url.startsWith('/api/library/series?path=')) {
            return { ok: true, json: async () => ({
                seriesName: 'Batman', path: '/lib/DC/Batman (2020)', publisher: 'DC', year: 2020,
                description: 'stored', universe: null, seriesGroup: null, hasCustomMetadata: false,
                ...seriesData,
            }) };
        }
        if (url === '/api/library/update' && init?.method === 'POST') {
            return { ok: true, json: async () => updateResult };
        }
        return { ok: true, json: async () => ({}) };
    });
}

const renderSeriesModal = () => render(
    <MetadataEditorModal open onOpenChange={vi.fn()} mode="series" series={seriesProps as any} />
);

describe('Metadata editor lock affordance — series mode (issue #194 (f))', () => {

    it('shows the lock notice for a locked series and unlocks via clearCustomMetadata', async () => {
        mockSeriesFetch({ hasCustomMetadata: true }, { success: true, unlocked: true });
        renderSeriesModal();

        expect(await screen.findByText(/Manual-edits lock is on/i)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Remove Lock/i }));

        await waitFor(() => {
            const call = fetchMock.mock.calls.find(([url, init]: any[]) =>
                url === '/api/library/update' && init?.method === 'POST');
            expect(call).toBeTruthy();
            expect(JSON.parse(call![1].body)).toEqual({ currentPath: '/lib/DC/Batman (2020)', clearCustomMetadata: true });
        });
        await waitFor(() => expect(screen.queryByText(/Manual-edits lock is on/i)).not.toBeInTheDocument());
    });

    it('shows no lock notice for an unlocked series', async () => {
        mockSeriesFetch({ hasCustomMetadata: false });
        renderSeriesModal();

        await screen.findByText(/Write changes to ComicInfo\.xml/i);
        expect(screen.queryByText(/Manual-edits lock is on/i)).not.toBeInTheDocument();
    });

    it('reports "No changes to save" when the series save was a no-op', async () => {
        mockSeriesFetch({}, { success: true, changed: false, newPath: '/lib/DC/Batman (2020)' });
        renderSeriesModal();

        await screen.findByText(/Write changes to ComicInfo\.xml/i);
        fireEvent.click(screen.getByRole('button', { name: /Save Metadata/i }));

        await waitFor(() => expect(toastMock).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'No changes to save' })));
    });
});
