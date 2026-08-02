// @vitest-environment jsdom
// __tests__/components/page-manager-modal.test.tsx
//
// Issue #189 Phase 1: the Page Manager grid marks pages by entry NAME, refuses marking every
// page, requires an explicit confirmation before the destructive POST, walks a multi-issue
// queue sequentially, and shows the CBZ-only notice for RAR/7z files instead of a grid.
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PageManagerModal from '@/components/page-manager-modal';

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

const PAGES = ['001.jpg', '002.jpg', '003.jpg', '004.jpg'];

function mockFetch({ pages = PAGES, removeResult = { success: true, newPageCount: 2, removed: 2 } } = {}) {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
        if (typeof url === 'string' && url.startsWith('/api/reader/pages')) {
            return { ok: true, json: async () => ({ pages }) };
        }
        if (url === '/api/library/issue/pages' && init?.method === 'POST') {
            return { ok: true, json: async () => removeResult };
        }
        return { ok: true, json: async () => ({}) };
    });
}

const cbzTarget = { issueId: 'i1', filePath: '/comics/S/S 001.cbz', label: 'Series #1' };
const cbrTarget = { issueId: 'i2', filePath: '/comics/S/S 002.cbr', label: 'Series #2' };

describe('Page Manager modal (issue #189)', () => {
    beforeEach(() => {
        mockFetch();
    });

    it('renders the page grid, marks by click, and posts entry names after explicit confirm', async () => {
        render(<PageManagerModal open onOpenChange={vi.fn()} queue={[cbzTarget]} />);

        expect(await screen.findByTitle('001.jpg')).toBeInTheDocument();
        fireEvent.click(screen.getByTitle('001.jpg'));
        fireEvent.click(screen.getByTitle('003.jpg'));
        expect(screen.getByText(/2 of 4 pages marked/i)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Delete 2 Pages/i }));
        // Nothing posted until the confirmation dialog is accepted.
        expect(fetchMock.mock.calls.some(([u]: any[]) => u === '/api/library/issue/pages')).toBe(false);
        expect(await screen.findByText(/Delete these pages\?/i)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /^Delete Pages$/i }));

        await waitFor(() => {
            const call = fetchMock.mock.calls.find(([u, init]: any[]) => u === '/api/library/issue/pages' && init?.method === 'POST');
            expect(call).toBeTruthy();
            const body = JSON.parse(call![1].body);
            expect(body.issueId).toBe('i1');
            expect(body.entryNames.sort()).toEqual(['001.jpg', '003.jpg']);
        });
        expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Pages removed' }));
    });

    it('disables deletion when every page is marked — at least one must remain', async () => {
        render(<PageManagerModal open onOpenChange={vi.fn()} queue={[cbzTarget]} />);
        await screen.findByTitle('001.jpg');
        for (const p of PAGES) fireEvent.click(screen.getByTitle(p));

        expect(screen.getByText(/at least one page must remain/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Delete 4 Pages/i })).toBeDisabled();
    });

    it('loads the grid for RAR files with the repack-as-CBZ note, and deletion works (Phase 2)', async () => {
        render(<PageManagerModal open onOpenChange={vi.fn()} queue={[cbrTarget]} />);

        expect(await screen.findByTitle('001.jpg')).toBeInTheDocument();
        expect(screen.getByText(/rewrites this file as/i)).toBeInTheDocument();
        fireEvent.click(screen.getByTitle('002.jpg'));
        expect(screen.getByRole('button', { name: /Delete 1 Page/i })).toBeEnabled();
    });

    it('pre-marks initialMarked pages from the reader handoff, dropping stale names (Phase 2)', async () => {
        render(<PageManagerModal open onOpenChange={vi.fn()} queue={[cbzTarget]} initialMarked={['002.jpg', 'ghost.jpg']} />);

        expect(await screen.findByTitle('002.jpg')).toBeInTheDocument();
        expect(screen.getByText(/1 of 4 pages marked/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Delete 1 Page/i })).toBeEnabled();
    });

    it('walks a multi-issue queue: applying advances to the next issue', async () => {
        render(<PageManagerModal open onOpenChange={vi.fn()} queue={[cbzTarget, { ...cbzTarget, issueId: 'i9', label: 'Series #9' }]} />);

        expect(await screen.findByText(/Issue 1 of 2/i)).toBeInTheDocument();
        fireEvent.click(await screen.findByTitle('002.jpg'));
        fireEvent.click(screen.getByRole('button', { name: /Delete 1 Page$/i }));
        fireEvent.click(await screen.findByRole('button', { name: /^Delete Pages$/i }));

        expect(await screen.findByText(/Issue 2 of 2/i)).toBeInTheDocument();
        expect(screen.getByText(/Series #9/)).toBeInTheDocument();
    });

    it('a tile\'s sweep control opens the series sweep for that page (Phase 3)', async () => {
        render(<PageManagerModal open onOpenChange={vi.fn()} queue={[cbzTarget]} />);
        await screen.findByTitle('001.jpg');

        fireEvent.click(screen.getAllByTitle(/Remove this page everywhere in the series/i)[0]);
        expect(await screen.findByText(/Remove This Page Everywhere/i)).toBeInTheDocument();
        // Candidate fetch returns nothing in this harness — the sweep lands on an empty review.
        expect(await screen.findByText(/No identical copies found/i)).toBeInTheDocument();
    });

    it('skip advances without posting anything', async () => {
        const onOpenChange = vi.fn();
        render(<PageManagerModal open onOpenChange={onOpenChange} queue={[cbzTarget, { ...cbzTarget, issueId: 'i9', label: 'Series #9' }]} />);

        await screen.findByText(/Issue 1 of 2/i);
        fireEvent.click(screen.getByRole('button', { name: /Skip to Next/i }));
        expect(await screen.findByText(/Issue 2 of 2/i)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Finish/i }));
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(fetchMock.mock.calls.some(([u]: any[]) => u === '/api/library/issue/pages')).toBe(false);
    });
});
