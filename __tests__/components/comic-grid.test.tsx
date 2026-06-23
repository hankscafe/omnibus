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
        vi.clearAllMocks();

        global.fetch = vi.fn(async (url: string) => {
            if (url.includes('/api/library/ids')) {
                return {
                    ok: true,
                    json: async () => ({
                        series: [],
                        monitored: [],
                        issues: [100], // Mock Issue ID 100 as owned
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