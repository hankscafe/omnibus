import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InteractiveSearchModal } from '@/components/interactive-search-modal';

// Mock the toaster to prevent UI rendering crashes
vi.mock('@/components/ui/use-toast', () => ({
    useToast: () => ({ toast: vi.fn() })
}));

describe('Component: InteractiveSearchModal', () => {
    beforeEach(() => {
        // Mock the search API endpoint returning empty results
        global.fetch = vi.fn().mockResolvedValue({ 
            json: async () => ({ prowlarr: [], getcomics: [] }) 
        });
        
        // Radix UI Dialog requires ResizeObserver and PointerEvent polyfills in JSDOM
        global.ResizeObserver = vi.fn().mockImplementation(() => ({
            observe: vi.fn(),
            unobserve: vi.fn(),
            disconnect: vi.fn(),
        }));
        window.PointerEvent = class PointerEvent extends Event {} as any;
    });

    it('should optimize the initial query by stripping subtitles and appending the year', () => {
        const comicData = {
            cvId: 123,
            year: '1988',
            publisher: 'DC Comics',
            image: '',
            type: 'volume' as const
        };

        render(
            <InteractiveSearchModal
                isOpen={true}
                onClose={vi.fn()}
                initialQuery="Batman: The Killing Joke (1988)"
                comicData={comicData}
            />
        );

        // The search box should have aggressively stripped the subtitle and isolated the year
        const searchInput = screen.getByRole('textbox');
        expect(searchInput).toHaveValue('Batman 1988');
    });
    
    it('should correctly pad issue numbers during optimization', () => {
        const comicData = {
            cvId: 123,
            year: '2016',
            publisher: 'DC Comics',
            image: '',
            type: 'issue' as const
        };

        render(
            <InteractiveSearchModal
                isOpen={true}
                onClose={vi.fn()}
                initialQuery="Batman Issue #1"
                comicData={comicData}
            />
        );

        // Base name is "Batman", issue "1" -> "001", year "2016"
        const searchInput = screen.getByRole('textbox');
        expect(searchInput).toHaveValue('Batman 001 2016');
    });
});