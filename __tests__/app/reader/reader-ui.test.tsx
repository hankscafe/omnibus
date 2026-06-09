// __tests__/app/reader/reader-ui.test.tsx
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ReaderPage from '@/app/reader/page';

// Mock hooks and routing
vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams('?path=/comics/batman-001.cbz'),
    useRouter: () => ({ back: vi.fn(), replace: vi.fn() })
}));

vi.mock('@/components/ui/use-toast', () => ({
    useToast: () => ({ toast: vi.fn() })
}));

// Mock localforage to prevent indexedDB crash in JSDOM
vi.mock('localforage', () => ({
    default: { getItem: vi.fn(), setItem: vi.fn() }
}));

describe('Component: Reader UI', () => {
    beforeEach(() => {
        vi.clearAllMocks();

        // Mock API responses for pages and progress
        global.fetch = vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/reader/pages')) {
                return Promise.resolve({ json: async () => ({ pages: ['page1.jpg', 'page2.jpg', 'page3.jpg'] }) });
            }
            if (url.includes('/api/progress')) {
                return Promise.resolve({ ok: true, json: async () => ({ currentPage: 0, isCompleted: false, bookmarks: [] }) });
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
            expect(screen.getByAltText('Page')).toBeInTheDocument();
        });
    });

    it('should navigate pages on arrow key press and respect bounds', async () => {
        render(<ReaderPage />);

        // Wait for pages to load and the image to render
        await waitFor(() => {
            expect(screen.getByAltText('Page')).toBeInTheDocument();
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
});