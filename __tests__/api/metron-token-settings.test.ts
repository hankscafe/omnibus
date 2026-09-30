import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, POST } from '@/app/api/admin/config/route';
import { auditLog } from '../helpers/setup-global';
import { SECRET_SETTING_KEYS } from '@/lib/secret-keys';

// Metron beta 3 (#216 follow-up): Metron is retiring username/password sign-in for its API in favour
// of API tokens (metron.cloud -> Profile -> API Tokens). A token is a credential like the password:
// stored encrypted at rest, and never sent back to the browser.

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    settingFindUnique: vi.fn(),
    settingFindMany: vi.fn(),
    settingUpsert: vi.fn(),
    transaction: vi.fn(),
    syncSchedules: vi.fn(),
}));

vi.mock('next-auth/next', () => ({ getServerSession: mocks.getServerSession }));

vi.mock('@/lib/db', () => {
    const none = { findMany: async () => [] };
    return {
        prisma: {
            systemSetting: { findUnique: mocks.settingFindUnique, findMany: mocks.settingFindMany },
            $transaction: mocks.transaction,
            library: none, downloadClient: none, hosterAccount: none, indexer: none,
            customHeader: none, searchAcronym: none, discordWebhook: none,
        }
    };
});

vi.mock('@/lib/queue', () => ({ syncSchedules: mocks.syncSchedules }));
vi.mock('@/lib/encryption', () => ({
    encryptSecret: vi.fn(async (v: string) => `enc:v2:${v}`),
    decryptSecret: vi.fn(async (v: string) => v),
}));
vi.mock('@/lib/annas-test', () => ({ testAnnasArchiveKey: vi.fn() }));

const mockReq = (body: any) => ({
    json: async () => body,
    url: 'http://localhost/api/admin/config',
    headers: new Headers({ 'content-type': 'application/json' }),
}) as unknown as Request;

const saved = () => Object.fromEntries(mocks.settingUpsert.mock.calls.map(([arg]: any[]) => [arg.where.key, arg.update.value]));

describe('Settings: the Metron API token is a secret', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } });
        mocks.settingFindUnique.mockResolvedValue({ key: 'setup_complete', value: 'true' });
        mocks.transaction.mockImplementation(async (fn: any) => fn({ systemSetting: { upsert: mocks.settingUpsert } }));
        auditLog.mockResolvedValue(undefined);
        mocks.syncSchedules.mockResolvedValue(undefined);
    });

    it('is stored encrypted, like the password (the username stays plain)', async () => {
        const res = await POST(mockReq({ settings: { metron_api_token: 'tok_abc123', metron_user: 'adam' } }));

        expect(res.status).toBe(200);
        expect(saved()).toMatchObject({ metron_api_token: 'enc:v2:tok_abc123', metron_user: 'adam' });
    });

    it('a masked token on save keeps the stored one', async () => {
        await POST(mockReq({ settings: { metron_api_token: '********', metron_user: 'adam' } }));

        expect(saved()).not.toHaveProperty('metron_api_token');
    });

    it('is never sent back to the browser', async () => {
        mocks.settingFindMany.mockResolvedValue([
            { key: 'metron_api_token', value: 'tok_abc123' },
            { key: 'metron_user', value: 'adam' },
        ]);

        const res = await GET(mockReq({}));
        const { settings } = await res.json();
        const value = (key: string) => settings.find((s: any) => s.key === key)?.value;

        expect(value('metron_api_token')).toBe('********');
        expect(value('metron_user')).toBe('adam');
    });

    it('every setting stored encrypted is also masked on the way out', async () => {
        mocks.settingFindMany.mockResolvedValue([...SECRET_SETTING_KEYS].map(key => ({ key, value: `secret-${key}` })));

        const { settings } = await (await GET(mockReq({}))).json();

        expect(settings.filter((s: any) => s.value !== '********').map((s: any) => s.key)).toEqual([]);
    });
});
