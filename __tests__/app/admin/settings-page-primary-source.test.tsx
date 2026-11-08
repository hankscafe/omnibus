// @vitest-environment jsdom
// The settings page moves the primary metadata source to the other provider when the chosen one
// has no credentials and the other one does - at load, and when a key is cleared while editing.
// The decision is primarySourceFallback (settings-primary-source.test.ts); these drive the REAL
// page to pin the wiring: the effect sees the change and the save sends the moved source.
//
// A move at load happens after the unsaved-changes baseline is taken, so the page opens with
// "Save Unsaved Changes" - that's how it has always behaved, and it tells the admin something moved.
import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ok, stubFetchRouter } from '../../helpers/fetch';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: { user: { id: 'admin_1', role: 'ADMIN' } }, status: 'authenticated' }),
}));
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

global.ResizeObserver = vi.fn().mockImplementation(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }));
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

import SettingsPage from '@/app/admin/settings/page';

let fetchMock: ReturnType<typeof stubFetchRouter>;
const settle = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

// The config the page loads: /api/admin/config's `settings` rows.
const load = async (settings: Record<string, string>) => {
    fetchMock = stubFetchRouter([
        ['/api/admin/config', (_u, init) => init?.method === 'POST'
            ? ok({ success: true })
            : ok({ settings: Object.entries(settings).map(([key, value]) => ({ key, value })) })],
        ['/api/admin/users', () => ok([])],
        ['/api/admin/api-keys', () => ok([])],
        ['/api/admin/metadata-cache', () => ok({ entries: 0, bytes: 0 })],
    ]);
    await act(async () => { render(<SettingsPage />); });
    await settle(600);  // the page marks its data loaded 500 ms after the config lands
    await settle(25);
};

// What a Save sends as the settings.
const saved = async () => {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save (All|Unsaved) Changes/ })); });
    await settle(25);
    const post = fetchMock.mock.calls.find(([u, init]) => String(u).startsWith('/api/admin/config') && init?.method === 'POST');
    expect(post).toBeDefined();
    return JSON.parse(post![1].body).settings as Record<string, string>;
};

describe('SettingsPage: the primary metadata source follows the credentials', () => {
    beforeEach(() => { toast.mockClear(); });

    it('opens on ComicVine when Metron is chosen but only ComicVine has credentials', async () => {
        await load({ primary_metadata_source: 'METRON', cv_api_key: '********' });
        expect(screen.getByRole('button', { name: 'Save Unsaved Changes' })).toBeInTheDocument();
        expect((await saved()).primary_metadata_source).toBe('COMICVINE');
    });

    it('opens on Metron, with popular issues off, when ComicVine is chosen but only Metron has credentials', async () => {
        await load({ primary_metadata_source: 'COMICVINE', metron_api_token: '********', show_popular_issues: 'true' });
        const settings = await saved();
        expect(settings.primary_metadata_source).toBe('METRON');
        expect(settings.show_popular_issues).toBe('false');
    });

    it('leaves a source that has its credentials alone', async () => {
        await load({ primary_metadata_source: 'METRON', cv_api_key: '********', metron_api_token: '********' });
        expect(screen.getByRole('button', { name: 'Save All Changes' })).toBeInTheDocument();
        expect((await saved()).primary_metadata_source).toBe('METRON');
    });

    it('moves to Metron when the ComicVine key is cleared while editing', async () => {
        await load({ primary_metadata_source: 'COMICVINE', cv_api_key: 'abc123', metron_api_token: '********' });
        expect(screen.getByRole('button', { name: 'Save All Changes' })).toBeInTheDocument();
        // The key field's label isn't wired to it (no htmlFor): find the input beside the label.
        const cvKey = screen.getByText(/ComicVine API Key/).closest('div')!.querySelector('input')!;
        expect(cvKey).toHaveValue('abc123');
        await act(async () => { fireEvent.change(cvKey, { target: { value: '' } }); });
        await settle(25);
        expect((await saved()).primary_metadata_source).toBe('METRON');
    });
});
