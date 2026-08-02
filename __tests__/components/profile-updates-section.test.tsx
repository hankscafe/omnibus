// @vitest-environment jsdom
// Profile "Updates" section (nav entries removed per Adam — the profile is the doorway to
// /library/updates now). Pinned: renders the newest followed-series arrivals with unread count,
// caps at 9, collapse toggle hides the grid and persists, empty feed shows the explainer, and
// the View All link targets the full page.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProfileUpdatesSection } from '@/components/profile-updates-section';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const item = (id: string, seriesName: string, isRead = false) => ({
    id, seriesName, number: '1', filePath: `/f/${id}.cbz`, seriesPath: '/f',
    coverUrl: null, createdAt: new Date().toISOString(), isRead,
});

describe('ProfileUpdatesSection', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ items: [item('a', 'Saga'), item('b', 'Kaiju No. 8', true)] }),
        }));
    });

    it('renders arrivals with the unread count and the View All link', async () => {
        render(<ProfileUpdatesSection />);

        expect(await screen.findByText('Saga')).toBeDefined();
        expect(screen.getByText('Kaiju No. 8')).toBeDefined();
        expect(screen.getByText('1 unread')).toBeDefined();
        const link = screen.getByRole('link', { name: /view all updates/i });
        expect(link.getAttribute('href')).toBe('/library/updates');
    });

    it('caps the section at 9 items', async () => {
        (fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({ items: Array.from({ length: 20 }, (_, i) => item(`i${i}`, `Series ${i}`)) }),
        });

        render(<ProfileUpdatesSection />);

        await screen.findByText('Series 0');
        expect(screen.queryByText('Series 8')).not.toBeNull();
        expect(screen.queryByText('Series 9')).toBeNull();
    });

    it('collapses on header click and persists the choice', async () => {
        render(<ProfileUpdatesSection />);
        await screen.findByText('Saga');

        fireEvent.click(screen.getByRole('button', { name: /updates/i }));

        expect(screen.queryByText('Saga')).toBeNull();
        expect(localStorage.getItem('omnibus_profile_updates_open')).toBe('0');
    });

    it('starts collapsed when the persisted state says so', async () => {
        localStorage.setItem('omnibus_profile_updates_open', '0');
        render(<ProfileUpdatesSection />);

        // Header renders (with the unread badge), content stays hidden.
        await waitFor(() => expect(screen.getByRole('button', { name: /updates/i })).toBeDefined());
        expect(screen.queryByText('Saga')).toBeNull();
    });

    it('shows the follow explainer when there are no arrivals', async () => {
        (fetch as any).mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });

        render(<ProfileUpdatesSection />);

        expect(await screen.findByText(/appear here/i)).toBeDefined();
    });
});
