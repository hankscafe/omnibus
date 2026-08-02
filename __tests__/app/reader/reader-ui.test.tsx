// @vitest-environment jsdom
// __tests__/app/reader/reader-ui.test.tsx
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ReaderPage from '@/app/reader/page';

// Mock hooks and routing
const backMock = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams('?path=/comics/batman-001.cbz'),
    useRouter: () => ({ back: backMock, replace: vi.fn(), push: vi.fn() })
}));

vi.mock('@/components/ui/use-toast', () => ({
    useToast: () => ({ toast: vi.fn() })
}));

// The reader reads the session for the admin-only page-flagging affordance (issue #189 Phase 2).
vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: { user: { role: 'ADMIN' } } })
}));

// Mock localforage to prevent indexedDB crash in JSDOM
vi.mock('localforage', () => ({
    default: { getItem: vi.fn(), setItem: vi.fn() }
}));

// Radix Dialog needs these in JSDOM (the Page Manager mounts in a portal).
global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn()
}));
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

describe('Component: Reader UI', () => {
    beforeEach(() => {

        // Mock API responses for pages and progress
        global.fetch = vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/reader/pages')) {
                return Promise.resolve({ ok: true, json: async () => ({ pages: ['page1.jpg', 'page2.jpg', 'page3.jpg'] }) });
            }
            if (url.includes('/api/progress')) {
                return Promise.resolve({ ok: true, json: async () => ({ currentPage: 0, isCompleted: false, bookmarks: [], issueId: 'issue-1' }) });
            }
            if (url.includes('/api/library/series')) {
                return Promise.resolve({ json: async () => ({ isManga: false, downloadedIssues: [] }) });
            }
            return Promise.resolve({ json: async () => ({}) });
        });
    });

    it('should render loading state initially', async () => {
        const { container } = render(<ReaderPage />);
        
        // Look for the loading spinner class
        expect(container.querySelector('.animate-spin')).toBeInTheDocument();

        // Wait for the component to finish loading to prevent act(...) warnings from background state updates
        await waitFor(() => {
            expect(screen.getByAltText(/^Page \d+$/)).toBeInTheDocument();
        });
    });

    it('should navigate pages on arrow key press and respect bounds', async () => {
        render(<ReaderPage />);

        // Wait for pages to load and the image to render
        await waitFor(() => {
            expect(screen.getByAltText(/^Page \d+$/)).toBeInTheDocument();
        });

        // Ensure we start on Page 1 (Using getAllByText because it exists in the toast AND scrubber)
        expect(screen.getAllByText(/Page 1/i).length).toBeGreaterThan(0);

        // Press Right Arrow to go to Page 2
        fireEvent.keyDown(window, { key: 'ArrowRight', code: 'ArrowRight' });
        await waitFor(() => {
            expect(screen.getAllByText(/Page 2/i).length).toBeGreaterThan(0);
        });

        // Press Left Arrow to go back to Page 1
        fireEvent.keyDown(window, { key: 'ArrowLeft', code: 'ArrowLeft' });
        await waitFor(() => {
            expect(screen.getAllByText(/Page 1/i).length).toBeGreaterThan(0);
        });

        // Press Left Arrow again (should NOT go out of bounds/negative)
        fireEvent.keyDown(window, { key: 'ArrowLeft', code: 'ArrowLeft' });
        await waitFor(() => {
            expect(screen.getAllByText(/Page 1/i).length).toBeGreaterThan(0);
        });
        
        // Press Right Arrow multiple times to hit the end (Page 3)
        fireEvent.keyDown(window, { key: 'ArrowRight', code: 'ArrowRight' });
        fireEvent.keyDown(window, { key: 'ArrowRight', code: 'ArrowRight' });

        await waitFor(() => {
            expect(screen.getAllByText(/Page 3/i).length).toBeGreaterThan(0);
        });
    });

    // ==== Issue #189 Phase 2: in-reader page flagging (admin) ====

    it('flags the current page, shows the review chip, and Close routes through the Page Manager', async () => {
        render(<ReaderPage />);
        await waitFor(() => {
            expect(screen.getByAltText(/^Page \d+$/)).toBeInTheDocument();
        });

        // Flag the page on screen; the review chip appears with the count.
        fireEvent.click(screen.getByTitle(/Flag page for removal/i));
        expect(await screen.findByText(/Review 1 flagged/i)).toBeInTheDocument();

        // Close with flags pending opens the Page Manager (pre-marked) instead of leaving.
        fireEvent.click(screen.getByRole('button', { name: /Close/i }));
        expect(backMock).not.toHaveBeenCalled();
        expect(await screen.findByText(/Manage Pages/i)).toBeInTheDocument();
        await waitFor(() => expect(screen.getByText(/1 of 3 pages marked/i)).toBeInTheDocument());

        // Closing the manager continues the interrupted exit.
        const dialogs = screen.getAllByRole('dialog');
        const manager = dialogs.find(d => /Manage Pages/.test(d.textContent || ''))!;
        const closeBtn = [...manager.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Close')!;
        fireEvent.click(closeBtn);
        await waitFor(() => expect(backMock).toHaveBeenCalled());
    });

    it('unflagging drops the chip, and Close leaves directly when nothing is flagged', async () => {
        render(<ReaderPage />);
        await waitFor(() => {
            expect(screen.getByAltText(/^Page \d+$/)).toBeInTheDocument();
        });

        const flagBtn = screen.getByTitle(/Flag page for removal/i);
        fireEvent.click(flagBtn);
        expect(await screen.findByText(/Review 1 flagged/i)).toBeInTheDocument();
        fireEvent.click(flagBtn);
        await waitFor(() => expect(screen.queryByText(/Review 1 flagged/i)).not.toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: /Close/i }));
        expect(backMock).toHaveBeenCalled();
        expect(screen.queryByText(/Manage Pages/i)).not.toBeInTheDocument();
    });
});