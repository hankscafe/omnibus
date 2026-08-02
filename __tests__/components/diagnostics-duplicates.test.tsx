// @vitest-environment jsdom
// __tests__/components/diagnostics-duplicates.test.tsx
//
// Issue #196: the Duplicate Resolver pre-marked a REAL comic for deletion when crossed records put
// two different issues (files 001 and 004) into one "duplicate" group. These tests pin the guard UI:
// suspected-mispair groups render the warning + per-file parsed numbers, default to keeping every
// copy (nothing pre-marked delete, group delete disabled, Resolve All skips them), and offer a
// one-click Refresh Metadata steer that queues the series re-sync.
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DiagnosticsPage from '@/app/admin/diagnostics/page';

vi.mock('@/components/ui/use-toast', () => ({
    useToast: () => ({ toast: vi.fn() }),
}));

global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn()
}));
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const fetchMock = vi.fn();
global.fetch = fetchMock as any;

const mispairGroup = {
    seriesId: 's-blackout',
    seriesName: 'Cyberpunk 2077: Blackout',
    seriesMetadataId: '143306',
    seriesMetadataSource: 'COMICVINE',
    issueNumber: '4',
    suspectedMispair: true,
    files: [
        { id: 'f4', path: '/comics/DH/Blackout/Cyberpunk 2077 Blackout 004 (2022).cbz', name: 'Cyberpunk 2077 Blackout 004 (2022).cbz', size: 48 * 1024 * 1024, parsedNumber: '4' },
        { id: 'f1', path: '/comics/DH/Blackout/Cyberpunk 2077 Blackout 001 (2022).cbz', name: 'Cyberpunk 2077 Blackout 001 (2022).cbz', size: 52 * 1024 * 1024, parsedNumber: '1' },
    ],
};

const trueDupGroup = {
    seriesId: 's-saga',
    seriesName: 'Saga',
    seriesMetadataId: '56789',
    seriesMetadataSource: 'COMICVINE',
    issueNumber: '1',
    suspectedMispair: false,
    files: [
        { id: 'small', path: '/comics/Image/Saga/Saga 001.cbz', name: 'Saga 001.cbz', size: 10 * 1024 * 1024, parsedNumber: '1' },
        { id: 'large', path: '/comics/Image/Saga/Saga 01 (digital).cbz', name: 'Saga 01 (digital).cbz', size: 20 * 1024 * 1024, parsedNumber: '1' },
    ],
};

// Renders the page, opens the Duplicates tab, and runs the scan against the mocked groups.
async function openDuplicatesTab() {
    render(<DiagnosticsPage />);
    fireEvent.click(screen.getByRole('button', { name: /^Duplicates$/i }));
    fireEvent.click(screen.getByRole('button', { name: /Find Duplicates/i }));
    await screen.findByText(/Found 2 duplicate groups/i);
}

describe('Duplicate Resolver mispair guard (issue #196)', () => {
    beforeEach(() => {
        fetchMock.mockImplementation(async (url: string, init?: any) => {
            if (url === '/api/admin/diagnostics') {
                const body = JSON.parse(init?.body || '{}');
                if (body.action === 'scan-duplicates') {
                    return { ok: true, json: async () => ({ duplicates: [mispairGroup, trueDupGroup] }) };
                }
            }
            return { ok: true, json: async () => ({}) };
        });
    });

    it('warns on the mispair group and shows each file\'s own filename number', async () => {
        await openDuplicatesTab();

        expect(screen.getByText(/Suspected mispair/i)).toBeInTheDocument();
        expect(screen.getByText(/different comics/i)).toBeInTheDocument();
        expect(screen.getByText(/filename says #1/i)).toBeInTheDocument();
        expect(screen.getByText(/filename says #4/i)).toBeInTheDocument();
        // The true-duplicate group carries no warning.
        expect(screen.getAllByText(/Suspected mispair/i)).toHaveLength(1);
    });

    it('defaults the mispair group to keeping every copy — nothing pre-marked, group delete disabled', async () => {
        await openDuplicatesTab();

        const mispairCard = screen.getByText('Cyberpunk 2077: Blackout').closest('div.rounded-lg') as HTMLElement;
        // No file pre-marked for deletion and none marked keep — the keep-all radio holds the state.
        expect(within(mispairCard).queryAllByText(/^Delete$/)).toHaveLength(0);
        expect(within(mispairCard).queryAllByText(/^Keep$/)).toHaveLength(0);
        expect(within(mispairCard).getByLabelText(/Keep all copies/i)).toBeChecked();
        expect(within(mispairCard).getByRole('button', { name: /Delete 0 in this group/i })).toBeDisabled();

        // The true duplicate keeps the old behavior: largest copy pre-selected as keeper, other marked delete.
        const dupCard = screen.getByText('Saga').closest('div.rounded-lg') as HTMLElement;
        expect(within(dupCard).getByText(/^Keep$/)).toBeInTheDocument();
        expect(within(dupCard).getByText(/^Delete$/)).toBeInTheDocument();
        expect(within(dupCard).getByRole('button', { name: /Delete 1 in this group/i })).toBeEnabled();
    });

    it('Resolve All only offers the true-duplicate files, skipping the mispair group', async () => {
        await openDuplicatesTab();

        fireEvent.click(screen.getByRole('button', { name: /Resolve All/i }));
        // Confirmation counts 1 file (the Saga non-keeper) — the mispair group contributes nothing.
        expect(await screen.findByText(/Delete 1 duplicate file across 2 groups/i)).toBeInTheDocument();
    });

    it('queues a metadata refresh for the mispaired series via the steer button', async () => {
        await openDuplicatesTab();

        fireEvent.click(screen.getByRole('button', { name: /Refresh Metadata/i }));
        await waitFor(() => {
            const call = fetchMock.mock.calls.find(([url]: any[]) => url === '/api/library/refresh-metadata');
            expect(call).toBeTruthy();
            expect(JSON.parse(call![1].body)).toEqual({ metadataId: '143306', metadataSource: 'COMICVINE' });
        });
    });

    it('an explicit keeper choice on a mispair group re-enables deletion (override stays possible)', async () => {
        await openDuplicatesTab();

        const mispairCard = screen.getByText('Cyberpunk 2077: Blackout').closest('div.rounded-lg') as HTMLElement;
        const keeperRadio = within(mispairCard).getAllByRole('radio').find(r => (r as HTMLInputElement).name.startsWith('keep-') && !(r.parentElement?.textContent || '').match(/all copies/i));
        fireEvent.click(keeperRadio!);
        expect(within(mispairCard).getByRole('button', { name: /Delete 1 in this group/i })).toBeEnabled();
    });
});
