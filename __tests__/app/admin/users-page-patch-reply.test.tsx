// @vitest-environment jsdom
// Admin → Users: a permission change shows the account as the PATCH answers it (the page swaps
// `data.user` into its list). Since beta.032 that answer is the GET's row shape (AdminUserRow) and
// nothing more - no password hash, TOTP secret or sessionVersion - so everything the row shows has to
// come from those fields alone.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ok, stubFetchRouter } from '../../helpers/fetch';

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: { user: { id: 'u_admin', role: 'ADMIN' } }, status: 'authenticated' }),
}));

import AdminUsersPage from '@/app/admin/users/page';

const ROW = {
    id: 'u_2', username: 'reader', email: 'reader@example.test', role: 'USER',
    isApproved: true, autoApproveRequests: false, canRequest: true, canDownload: false, canCreateGlobalLists: false,
    createdAt: '2026-01-02T03:04:05.000Z', twoFactorEnabled: true, libraryAccess: [{ libraryId: 'lib_comics' }],
};
const LIBRARIES = [
    { id: 'lib_comics', name: 'Comics', isManga: false, isDefault: true },
    { id: 'lib_manga', name: 'Manga', isManga: true, isDefault: false },
];

describe('Admin Users page: the PATCH reply replaces the row', () => {
    let fetchMock: ReturnType<typeof stubFetchRouter>;

    beforeEach(() => {
        toast.mockClear();
        fetchMock = stubFetchRouter([
            ['/api/admin/users', (_u, init) => {
                if (init?.method !== 'PATCH') return ok([ROW]);
                const { id: _id, ...changes } = JSON.parse(init.body);
                return ok({ success: true, user: { ...ROW, ...changes } });
            }],
            ['/api/admin/libraries', () => ok(LIBRARIES)],
            ['/api/admin/config', () => ok({ settings: [] })],
        ]);
    });

    const downloadSwitch = () => screen.getAllByText('Download')
        .map((el) => el.closest('label')?.querySelector('[role="switch"]'))
        .find((el): el is HTMLElement => !!el)!;

    it('a Download toggle shows the answered row: switch on, tier re-derived, the rest unchanged', async () => {
        await act(async () => { render(<AdminUsersPage />); });
        expect(screen.getAllByText('reader').length).toBeGreaterThan(0);
        expect(downloadSwitch().getAttribute('aria-checked')).toBe('false');
        expect(screen.getAllByText('Custom').length).toBeGreaterThan(0);
        expect(screen.queryAllByText('Sidekick')).toHaveLength(0);

        await act(async () => { fireEvent.click(downloadSwitch()); });

        const patches = fetchMock.mock.calls
            .filter(([u, init]) => String(u) === '/api/admin/users' && init?.method === 'PATCH')
            .map(([, init]) => JSON.parse(init.body));
        expect(patches).toEqual([{ id: 'u_2', canDownload: true }]);
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'User Updated' }));

        expect(downloadSwitch().getAttribute('aria-checked')).toBe('true');
        // canRequest + canDownload, no auto-approve / global lists = the Sidekick preset.
        expect(screen.getAllByText('Sidekick').length).toBeGreaterThan(0);
        expect(screen.getAllByText('reader@example.test').length).toBeGreaterThan(0);
        expect(screen.getAllByTitle('Reset 2FA').length).toBeGreaterThan(0);
        expect(screen.getAllByText(/Libs \(1\/2\)/).length).toBeGreaterThan(0);
    });
});
