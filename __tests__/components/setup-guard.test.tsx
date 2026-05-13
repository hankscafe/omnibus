import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SetupGuard } from '@/components/setup-guard';
import { useRouter, usePathname } from 'next/navigation';

// Mock Next.js Navigation
vi.mock('next/navigation', () => ({
    useRouter: vi.fn(),
    usePathname: vi.fn()
}));

describe('Component: SetupGuard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        global.fetch = vi.fn();
    });

    it('should redirect to /setup if the database is uninitialized (requiresSetup: true)', async () => {
        const mockPush = vi.fn();
        vi.mocked(useRouter).mockReturnValue({ push: mockPush } as any);
        vi.mocked(usePathname).mockReturnValue('/');

        (global.fetch as any).mockResolvedValue({
            json: async () => ({ requiresSetup: true, forceSso: false })
        });

        render(
            <SetupGuard>
                <div data-testid="app-content">App Content</div>
            </SetupGuard>
        );

        // Wait for the fetch to resolve and the effect to trigger the redirect
        await waitFor(() => {
            expect(mockPush).toHaveBeenCalledWith('/setup');
        });

        // The children should NOT be rendered while redirecting
        expect(screen.queryByTestId('app-content')).toBeNull();
    });

    it('should safely render children if the database is already configured (requiresSetup: false)', async () => {
        const mockPush = vi.fn();
        vi.mocked(useRouter).mockReturnValue({ push: mockPush } as any);
        vi.mocked(usePathname).mockReturnValue('/');

        (global.fetch as any).mockResolvedValue({
            json: async () => ({ requiresSetup: false, forceSso: false })
        });

        render(
            <SetupGuard>
                <div data-testid="app-content">App Content</div>
            </SetupGuard>
        );

        // Wait for the loading spinner to disappear and the content to mount
        await waitFor(() => {
            expect(screen.getByTestId('app-content')).toBeInTheDocument();
        });

        // Ensure no redirect occurred
        expect(mockPush).not.toHaveBeenCalled();
    });
});