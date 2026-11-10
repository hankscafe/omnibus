// @vitest-environment jsdom
// Settings → Downloads: the download-client dialog edits one client at a time (each input writes its
// field onto the client being edited), "Save Settings" puts it in the list, and Save All Changes posts
// the list. Characterization tests written for beta.033, when the dialog's edits got real types: what an
// edited and a new client look like in the save and in a connection test.
import '@testing-library/jest-dom';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ok, stubFetchRouter } from '../../helpers/fetch';

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
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

const settle = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const SAVED = {
    id: 'c1', name: 'Home Transmission', type: 'transmission', protocol: 'Torrent', url: 'http://nas:9091',
    user: null, pass: null, apiKey: null, category: 'comics', remotePath: null, localPath: null,
};

let fetchMock: ReturnType<typeof stubFetchRouter>;
const load = async (clients: unknown[]) => {
    fetchMock = stubFetchRouter([
        ['/api/admin/config', (_u, init) => init?.method === 'POST' ? ok({ success: true }) : ok({ settings: [], downloadClients: clients })],
        ['/api/admin/test', () => ok({ success: true, message: 'Connected to qBittorrent.' })],
        ['/api/admin/users', () => ok([])],
        ['/api/admin/api-keys', () => ok([])],
        ['/api/admin/metadata-cache', () => ok({ entries: 0, bytes: 0 })],
    ]);
    await act(async () => { render(<SettingsPage />); });
    await settle(600);
};
// The dialog's labels aren't wired to their inputs: the input beside a label.
const fieldBeside = (label: string) => screen.getByText(label, { selector: 'label' }).closest('div')!.querySelector('input')!;
const type = async (label: string, value: string) => { await act(async () => { fireEvent.change(fieldBeside(label), { target: { value } }); }); };
const click = async (el: HTMLElement) => { await act(async () => { fireEvent.click(el); }); await settle(25); };
const posted = (url: string) => fetchMock.mock.calls
    .filter(([u, init]) => String(u) === url && init?.method === 'POST')
    .map(([, init]) => JSON.parse(init.body));

describe('Settings → Downloads: the client dialog', () => {
    beforeEach(() => { window.history.replaceState(null, '', '/admin/settings?tab=downloads'); });
    afterEach(() => { window.history.replaceState(null, '', '/'); });

    it('editing a saved client changes only the fields typed into, and Save All posts it', async () => {
        await load([SAVED]);
        const card = screen.getByText('Home Transmission').closest('.p-4') as HTMLElement;
        await click(within(card).getAllByRole('button')[0]);

        await type('Server URL', 'http://nas:9092');
        await type('User', 'adam');
        await type('Download Category / Label', 'comics, manga');
        await click(screen.getByRole('button', { name: 'Save Settings' }));
        await click(screen.getByRole('button', { name: /save (all|unsaved) changes/i }));

        const saves = posted('/api/admin/config');
        expect(saves).toHaveLength(1);
        expect(saves[0].downloadClients).toEqual([
            { ...SAVED, url: 'http://nas:9092', user: 'adam', category: 'comics, manga' },
        ]);
    });

    it('a new client starts from its type, a connection test sends what was typed, and Save All posts it', async () => {
        await load([]);
        await click(screen.getByText('qBittorrent'));
        expect(screen.getByText('Configure qBittorrent')).toBeInTheDocument();

        await type('Server URL', 'http://seedbox:8080');
        await act(async () => {
            fireEvent.change(screen.getByPlaceholderText('qbt_...'), { target: { value: 'qbt_secret' } });
        });
        await click(screen.getByRole('button', { name: /test connection/i }));

        const tests = posted('/api/admin/test');
        expect(tests).toHaveLength(1);
        expect(tests[0].type).toBe('clients');
        expect(tests[0].config).toMatchObject({
            clientType: 'qbit', type: 'qbit', name: 'qBittorrent', protocol: 'Torrent',
            url: 'http://seedbox:8080', apiKey: 'qbt_secret', category: 'comics', user: '', pass: '',
        });
        expect(screen.getByText('Connected to qBittorrent.')).toBeInTheDocument();

        await click(screen.getByRole('button', { name: 'Save Settings' }));
        await click(screen.getByRole('button', { name: /save (all|unsaved) changes/i }));

        const [save] = posted('/api/admin/config');
        expect(save.downloadClients).toHaveLength(1);
        expect(save.downloadClients[0]).toEqual({
            id: expect.stringMatching(/^tmp_/), type: 'qbit', name: 'qBittorrent', protocol: 'Torrent',
            url: 'http://seedbox:8080', user: '', pass: '', apiKey: 'qbt_secret', category: 'comics',
            remotePath: '', localPath: '',
        });
    });
});
