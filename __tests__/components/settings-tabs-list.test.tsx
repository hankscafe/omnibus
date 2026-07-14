// __tests__/components/settings-tabs-list.test.tsx
//
// Phase 2 save-model polish: each settings tab trigger shows an amber "unsaved changes" dot
// when state owned by that tab has diverged from the last save. The list component receives
// the dirty tab values from page.tsx (computed by tabs/dirty.ts).
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import { SettingsTabsList } from '@/app/admin/settings/tabs/tabs-list';

global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn()
}));

const renderList = (dirtyTabs: string[]) => render(
    <Tabs defaultValue="metadata">
        <SettingsTabsList dirtyTabs={dirtyTabs} />
    </Tabs>
);

describe('Component: SettingsTabsList', () => {
    it('renders all 8 reorganized tab triggers', () => {
        renderList([]);
        for (const label of ['Metadata', 'Library & Files', 'Search & Indexers', 'Downloads', 'Discovery & Filtering', 'Notifications', 'Access & Security', 'System']) {
            expect(screen.getByRole('tab', { name: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toBeInTheDocument();
        }
    });

    it('shows the unsaved-changes dot only on dirty tabs', () => {
        renderList(['downloads', 'system']);

        const downloads = screen.getByRole('tab', { name: /Downloads/ });
        const system = screen.getByRole('tab', { name: /System/ });
        const metadata = screen.getByRole('tab', { name: /Metadata/ });

        expect(within(downloads).getByLabelText(/unsaved changes/i)).toBeInTheDocument();
        expect(within(system).getByLabelText(/unsaved changes/i)).toBeInTheDocument();
        expect(within(metadata).queryByLabelText(/unsaved changes/i)).not.toBeInTheDocument();
    });

    it('shows no dots when nothing is dirty', () => {
        renderList([]);
        expect(screen.queryAllByLabelText(/unsaved changes/i)).toHaveLength(0);
    });

    it('wraps into a 2-column grid on phones and restores the flex row at sm+', () => {
        // At 375px only 2 of 8 tabs fit the old horizontal-scroll bar (scrollbar hidden = no
        // affordance) and off-screen dirty dots were invisible. Mobile gets a wrapped grid with
        // every tab (and its dot) visible; sm+ keeps the original scrolling flex row.
        renderList([]);
        const list = screen.getByRole('tablist');
        expect(list.className).toContain('grid-cols-2');
        expect(list.className).toContain('sm:flex');
    });
});
