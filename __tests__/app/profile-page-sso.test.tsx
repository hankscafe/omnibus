// @vitest-environment jsdom
// The profile page's half of the SSO contract (beta.028): an account managed by the identity
// provider has no local password, so the page labels the 2FA and password controls "Managed by your
// Identity Provider." and disables them. The route never sent the flag before beta.028 (see
// __tests__/api/user-profile-route.test.ts); this pins that the page acts on it once it does.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ok, stubFetchRouter } from '../helpers/fetch';

vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: { user: { id: 'user_1', role: 'USER', name: 'reader' } }, status: 'authenticated', update: vi.fn() }),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/ThemeProvider', () => ({ useColorTheme: () => ({ colorTheme: 'default', setColorTheme: vi.fn() }) }));
vi.mock('@/components/profile-updates-section', () => ({ ProfileUpdatesSection: () => null }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));

import ProfilePage from '@/app/profile/page';

const profileReply = (isSsoUser: boolean) => ({
    user: { username: 'reader', role: 'USER', avatar: null, banner: null, createdAt: '2026-01-02T03:04:05.000Z', isSsoUser },
    stats: { total: 0, active: 0, pendingApproval: 0, completed: 0, failed: 0, historyStarted: 0, historyCompleted: 0, completionRate: 0 },
    recentRequests: [], recentHistory: [], trophies: [],
});

const renderWith = async (isSsoUser: boolean) => {
    stubFetchRouter([
        ['/api/user/profile', () => ok(profileReply(isSsoUser))],
        ['/api/request', () => ok([])],
        ['/api/reading-lists', () => ok([])],
        ['/api/user/2fa', () => ok({ enabled: false })],
        ['/api/user/api-keys', () => ok([])],
        ['/api/user/analytics', () => ok({})],
        ['/api/profile/koreader', () => ok([])],
    ]);
    render(<ProfilePage />);
    // The security cards live in the collapsed "Settings & Security" section.
    fireEvent.click(await screen.findByRole('button', { name: /Settings & Security/ }));
    await screen.findByRole('button', { name: /Change Password/ });
};

const button = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('Profile page - SSO accounts', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => vi.unstubAllGlobals());

    it('disables 2FA and Change Password for an account the identity provider manages', async () => {
        await renderWith(true);

        expect(screen.getAllByText('Managed by your Identity Provider.')).toHaveLength(2);
        expect(button(/Enable 2FA/).disabled).toBe(true);
        expect(button(/Change Password/).disabled).toBe(true);
    });

    it('leaves both enabled for a local account', async () => {
        await renderWith(false);

        await waitFor(() => expect(screen.queryByText('Managed by your Identity Provider.')).toBeNull());
        expect(screen.getByText('Update your local account password.')).toBeTruthy();
        expect(button(/Enable 2FA/).disabled).toBe(false);
        expect(button(/Change Password/).disabled).toBe(false);
    });
});
