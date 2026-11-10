// @vitest-environment jsdom
// Settings → Downloads: a download client saved without a login (Transmission with RPC authentication
// off, say) has user and pass stored as null. Opening it again handed React `value={null}` on the
// User and Pass inputs - a console warning, and the inputs started out uncontrolled. They show empty
// now, like every other optional field in that dialog.
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
// A client row as /api/admin/config sends it (secrets masked; a missing login is null).
const client = (over: Record<string, unknown>) => ({
    id: 'c1', name: 'Home Transmission', type: 'transmission', protocol: 'Torrent', url: 'http://nas:9091',
    user: null, pass: null, apiKey: null, category: 'comics', remotePath: null, localPath: null, ...over,
});

const openClient = async (row: ReturnType<typeof client>) => {
    stubFetchRouter([
        ['/api/admin/config', () => ok({ settings: [], downloadClients: [row] })],
        ['/api/admin/users', () => ok([])],
        ['/api/admin/api-keys', () => ok([])],
        ['/api/admin/metadata-cache', () => ok({ entries: 0, bytes: 0 })],
    ]);
    await act(async () => { render(<SettingsPage />); });
    await settle(600);
    const card = screen.getByText(row.name as string).closest('.p-4') as HTMLElement;
    await act(async () => { fireEvent.click(within(card).getAllByRole('button')[0]); });
    await settle(25);
};
// The dialog's labels aren't wired to their inputs: the input beside a label.
const fieldBeside = (label: string) => screen.getByText(label, { selector: 'label' }).closest('div')!.querySelector('input')!;

describe('Settings → Downloads: a client without a login', () => {
    let consoleError: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        // The page opens on the tab ?tab= names.
        window.history.replaceState(null, '', '/admin/settings?tab=downloads');
        consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => { consoleError.mockRestore(); window.history.replaceState(null, '', '/'); });

    const nullValueWarnings = () => consoleError.mock.calls.filter((args: unknown[]) => args.some((a: unknown) => /should not be null/.test(String(a))));

    it('opens with empty User and Pass fields, and no null-value warning', async () => {
        await openClient(client({}));

        expect(fieldBeside('User')).toHaveValue('');
        expect(fieldBeside('Pass')).toHaveValue('');
        expect(nullValueWarnings()).toEqual([]);
    });

    it('a saved login still shows: the user name, and the masked password', async () => {
        await openClient(client({ user: 'adam', pass: '********' }));

        expect(fieldBeside('User')).toHaveValue('adam');
        expect(fieldBeside('Pass')).toHaveValue('********');
    });
});
