// __tests__/components/jobs-page-ownership.test.tsx
//
// Settings reorganization Phase 3: one owner per setting. The Jobs page used to WRITE
// export_series_json (force-enabling the feature when its job was scheduled), giving the
// toggle two owners — Settings → Metadata and this page. These tests pin the new contract:
// the Jobs page only reads feature state (read-only note + link to the owning settings tab)
// and its save payload contains schedules ONLY.
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ScheduledJobsPage from '@/app/admin/jobs/page';

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));
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

const configResponse = (settings: { key: string, value: string }[]) => ({
    ok: true,
    json: async () => ({ settings }),
});

describe('Jobs page: schedule-only ownership (Phase 3)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fetchMock.mockImplementation(async (url: string, init?: any) => {
            if (url === '/api/admin/config' && (!init || !init.method || init.method === 'GET')) {
                return configResponse([
                    { key: 'export_series_json', value: 'false' },
                    { key: 'cbr_conversion_enabled', value: 'false' },
                    { key: 'series_json_schedule', value: '24' },
                ]);
            }
            return { ok: true, json: async () => ({}) };
        });
    });

    it('shows a read-only note linking to Settings when the series.json feature is off', async () => {
        render(<ScheduledJobsPage />);

        expect(await screen.findByText(/series\.json export feature is turned off/i)).toBeInTheDocument();
        // The note links to the owning settings page instead of offering to flip the toggle here.
        const link = screen.getByRole('link', { name: /Settings.*Metadata/i });
        expect(link).toHaveAttribute('href', expect.stringContaining('/admin/settings'));
        // The old auto-enable copy is gone.
        expect(screen.queryByText(/will enable it automatically/i)).not.toBeInTheDocument();
    });

    it('shows the equivalent note for the CBR converter when auto-conversion is off', async () => {
        render(<ScheduledJobsPage />);

        expect(await screen.findByText(/Auto-conversion is turned off/i)).toBeInTheDocument();
        const link = screen.getByRole('link', { name: /Library & Files/i });
        expect(link).toHaveAttribute('href', expect.stringContaining('/admin/settings'));
    });

    it('never writes export_series_json — the save payload is schedules only', async () => {
        render(<ScheduledJobsPage />);
        await screen.findByText(/series\.json export feature is turned off/i);

        const saveButton = await screen.findByRole('button', { name: /Save Schedule|Save Unsaved Changes/i });
        await waitFor(() => expect(saveButton).toBeEnabled());
        fireEvent.click(saveButton);

        await waitFor(() => {
            const post = fetchMock.mock.calls.find(([url, init]: any[]) => url === '/api/admin/config' && init?.method === 'POST');
            expect(post).toBeTruthy();
            const body = JSON.parse(post![1].body);
            expect(body.settings).not.toHaveProperty('export_series_json');
            expect(body.settings).toHaveProperty('series_json_schedule');
            expect(body.settings).toHaveProperty('cbr_conversion_schedule');
            expect(body.settings).not.toHaveProperty('cbr_conversion_enabled');
        });
    });
});
