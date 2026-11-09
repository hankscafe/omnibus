// @vitest-environment jsdom
// __tests__/components/comic-grid.test.tsx
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComicGrid } from '@/components/comic-grid';

// 1. Mock NextAuth
vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: { user: { role: 'USER', canRequest: true } } })
}));

// 2. Mock UI Dependencies
vi.mock('@/components/ui/use-toast', () => ({
    useToast: () => ({ toast: vi.fn() })
}));

// Radix UI Dialog polyfills
global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn()
}));
window.PointerEvent = class PointerEvent extends Event {} as any;
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

describe('Component: ComicGrid', () => {
    beforeEach(() => {

        global.fetch = vi.fn(async (url: string) => {
            if (url.includes('/api/library/ids')) {
                return {
                    ok: true,
                    json: async () => ({
                        series: [],
                        monitored: [],
                        issues: [100], // Mock Issue ID 100 as owned
                        covered: [102], // #203 COLLECTED coverage: 102 is reprinted in an owned trade
                        requests: [
                            { volumeId: 200, name: 'Spider-Man #1', status: 'PENDING' }
                        ]
                    })
                };
            }
            if (url.includes('/api/discover')) {
                return {
                    ok: true,
                    json: async () => ({
                        results: [
                            { id: 100, volumeId: 50, name: 'Batman #1', image: 'batman.jpg', issueNumber: '1' },
                            { id: 101, volumeId: 200, name: 'Spider-Man #1', image: 'spiderman.jpg', issueNumber: '1' },
                            { id: 102, volumeId: 300, name: 'Superman #1', image: 'superman.jpg', issueNumber: '1' }
                        ],
                        nextOffset: null
                    })
                };
            }
            if (url.includes('/api/issue-details')) {
                return { ok: true, json: async () => ({ id: 102, name: 'Superman #1', description: 'Man of Steel' }) };
            }
            if (url.includes('/api/series-issues')) {
                return { ok: true, json: async () => ({ results: [] }) };
            }
            return { ok: true, json: async () => ({ success: true }) };
        }) as any;
    });

    it('should render correct status badges based on library tracking data', async () => {
        render(<ComicGrid title="New Releases" type="new" />);

        // Wait for the grid images to paint and the status check to complete
        await waitFor(() => {
            expect(screen.getByAltText('Batman #1')).toBeInTheDocument();
        });

        // Use waitFor here because status badges are rendered AFTER the second fetch (ids) resolves
        await waitFor(() => {
            expect(screen.getAllByTitle('In Library')[0]).toBeInTheDocument();
            expect(screen.getAllByTitle('Requested')[0]).toBeInTheDocument();
        });
    });

    // #203 COLLECTED coverage: an issue reprinted in an owned trade is neither "In Library" nor
    // something to bulk-request — it wears its own badge.
    it('badges an issue an owned collected edition covers as covered, not as in the library', async () => {
        render(<ComicGrid title="New Releases" type="new" />);
        await waitFor(() => expect(screen.getByAltText('Superman #1')).toBeInTheDocument());

        await waitFor(() => {
            expect(screen.getAllByTitle('In a collection you own')[0]).toBeInTheDocument();
        });
        // Exactly one card is "In Library" (Batman); Superman is covered, not owned.
        expect(screen.getAllByTitle('In Library')).toHaveLength(1);
    });

    // The details dialog's strip of the volume's other issues can be long: those covers load as they
    // near the screen. The dialog's own cover is on screen at once, so it doesn't wait.
    it('loads the related-issue covers lazily, and the dialog cover at once', async () => {
        const base = global.fetch as unknown as (url: string) => Promise<unknown>;
        global.fetch = vi.fn(async (url: string) => url.includes('/api/series-issues')
            ? { ok: true, json: async () => ({ results: [{ id: 7, name: 'Superman #2', image: 'superman2.jpg', issueNumber: '2' }] }) }
            : base(url)) as unknown as typeof fetch;
        render(<ComicGrid title="New Releases" type="new" />);
        await waitFor(() => expect(screen.getByLabelText('View details for Superman #1')).toBeInTheDocument());

        fireEvent.click(screen.getByLabelText('View details for Superman #1'));

        const related = await screen.findByAltText('Superman #2');
        expect(related).toHaveAttribute('loading', 'lazy');
        expect(related).toHaveAttribute('decoding', 'async');
        // The card in the grid (already lazy) and the dialog's cover share the name; the dialog's is eager.
        const dialogCover = screen.getAllByAltText('Superman #1').find(img => img.getAttribute('src') === 'superman.jpg' && !img.closest('[aria-label="View details for Superman #1"]'));
        expect(dialogCover).toBeDefined();
        expect(dialogCover).not.toHaveAttribute('loading', 'lazy');
    });

    it('should fire a POST request to /api/request when the Request button is clicked in the modal', async () => {
        render(<ComicGrid title="New Releases" type="new" />);

        await waitFor(() => {
            expect(screen.getByLabelText('View details for Superman #1')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByLabelText('View details for Superman #1'));

        // Wait for modal details fetch
        await waitFor(() => {
            expect(screen.getByText('Request Issue')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByText('Request Issue'));

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith('/api/request', expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('"cvId":300') 
            }));
        });
    });
});