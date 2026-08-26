// __tests__/api/setup-check.test.ts
// The login page's public probe: requiresSetup routing, forceSso redirect, and (Adam's
// admin-controls ask, 2026-08-19) the registrationEnabled flag that hides the Register
// affordance. Display-only — the register API enforces the toggle server-side.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/setup/check/route';

const mocks = vi.hoisted(() => ({
    userCount: vi.fn(),
    settingFindUnique: vi.fn(),
    settingUpsert: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        user: { count: mocks.userCount },
        systemSetting: { findUnique: mocks.settingFindUnique, upsert: mocks.settingUpsert },
    }
}));

const settings = (map: Record<string, string>) => (args: any) =>
    Promise.resolve(map[args?.where?.key] !== undefined ? { key: args.where.key, value: map[args.where.key] } : null);

describe('API Route: GET /api/setup/check', () => {
    beforeEach(() => {
        mocks.userCount.mockResolvedValue(2);
        mocks.settingUpsert.mockResolvedValue({ key: 'setup_complete', value: 'true' });
    });

    it('reports registrationEnabled: true by default (setting absent)', async () => {
        mocks.settingFindUnique.mockImplementation(settings({ setup_complete: 'true' }));
        const res = await GET();
        const data = await res.json();
        expect(data.requiresSetup).toBe(false);
        expect(data.registrationEnabled).toBe(true);
    });

    it('reports registrationEnabled: false when the admin toggle is off', async () => {
        mocks.settingFindUnique.mockImplementation(settings({ setup_complete: 'true', allow_registration: 'false' }));
        const res = await GET();
        const data = await res.json();
        expect(data.registrationEnabled).toBe(false);
        expect(data.forceSso).toBe(false);
    });
});
