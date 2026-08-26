import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/auth/register/route';
import { discordSendAlert } from '../helpers/setup-global';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    queryRaw: vi.fn(),
    userCreate: vi.fn(),
    userFindFirst: vi.fn(),
    userUpdate: vi.fn(),
    userCount: vi.fn(),
    settingFindUnique: vi.fn().mockResolvedValue(null),
    log: vi.fn(),
    sendDiscord: vi.fn().mockResolvedValue(null),
    sendEmail: vi.fn().mockResolvedValue(null),
    hash: vi.fn().mockResolvedValue('hashed_password')
}));

// 2. Safely isolate the Database, Notifiers, and Logger
vi.mock('@/lib/db', () => ({
    prisma: {
        $queryRaw: mocks.queryRaw,
        $transaction: vi.fn().mockResolvedValue([]),
        user: {
            create: mocks.userCreate,
            findFirst: mocks.userFindFirst,
            update: mocks.userUpdate,
            count: mocks.userCount
        },
        systemSetting: { findUnique: mocks.settingFindUnique },
        // Library seeding on registration (Phase 2) touches these.
        library: { findMany: vi.fn().mockResolvedValue([]) },
        userLibraryAccess: { deleteMany: vi.fn(), createMany: vi.fn() }
    }
}));

vi.mock('bcryptjs', () => ({ default: { hash: mocks.hash } }));
vi.mock('@/lib/mailer', () => ({ Mailer: { sendAlert: mocks.sendEmail } }));

// Helper to create a fake NextRequest
const createReq = (body: any) => new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    body: JSON.stringify(body)
});

describe('API Route: POST /api/auth/register', () => {

    it('should reject a weak password', async () => {
        const req = createReq({ username: 'TestUser', email: 'test@test.com', password: 'weak' });
        const res = await POST(req);
        
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('Password must be at least 12 characters');
    });

    it('should promote the very first user in the database to ADMIN', async () => {
        const req = createReq({ username: 'AdminUser', email: 'admin@test.com', password: 'SuperSecretPassword123!' });
        
        // 1. Simulate NO existing users with this email/username
        mocks.queryRaw.mockResolvedValueOnce([]);
        // 2. Simulate creating the user
        mocks.userCreate.mockResolvedValueOnce({ id: 'user_1', username: 'AdminUser' });
        // 3. Simulate this user being the oldest (first) in the DB
        mocks.userFindFirst.mockResolvedValueOnce({ id: 'user_1' });
        // 4. The promotion update returns the promoted admin (consumed by library seeding).
        mocks.userUpdate.mockResolvedValueOnce({ id: 'user_1', username: 'AdminUser', role: 'ADMIN', isApproved: true });
        
        const res = await POST(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        
        // Assert they got the Admin success message
        expect(data.message).toBe('Admin account created successfully.');
        
        // Assert the update function was called to promote them!
        expect(mocks.userUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'user_1' },
            data: expect.objectContaining({ role: 'ADMIN', isApproved: true })
        }));
        
        // Assert we DID NOT send an approval required email to admins (since this IS the admin)
        expect(mocks.sendEmail).not.toHaveBeenCalled();
    });

    it('should assign standard USER role to subsequent registrations and send alerts', async () => {
        const req = createReq({ username: 'StandardUser', email: 'user@test.com', password: 'SuperSecretPassword123!' });
        
        mocks.queryRaw.mockResolvedValueOnce([]);
        // This is the second user registering
        mocks.userCreate.mockResolvedValueOnce({ id: 'user_2', username: 'StandardUser' });
        // The DB says user_1 is the oldest, NOT user_2
        mocks.userFindFirst.mockResolvedValueOnce({ id: 'user_1' });
        
        const res = await POST(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        
        // Assert they got the standard pending approval message
        expect(data.message).toContain('Please wait for an admin to approve your account');
        
        // Assert they were NOT promoted
        expect(mocks.userUpdate).not.toHaveBeenCalled();
        
        // Assert Discord and Email alerts WERE sent to the admins
        expect(discordSendAlert).toHaveBeenCalled();
        expect(mocks.sendEmail).toHaveBeenCalled();
    });
});
// Adam's admin-controls ask (2026-08-19): admins can turn OFF self-registration while keeping
// Admin -> Users manual creation. The gate lives in this route (server-side enforcement; the login
// page only hides the affordance) and NEVER blocks a zero-user install's first-admin bootstrap.
describe('allow_registration gate', () => {
    const settingImpl = (allowValue: string | null) => (args: any) =>
        Promise.resolve(args?.where?.key === 'allow_registration' && allowValue !== null ? { value: allowValue } : null);

    it('refuses registration with 403 when disabled and users already exist', async () => {
        mocks.settingFindUnique.mockImplementation(settingImpl('false'));
        mocks.userCount.mockResolvedValue(3);

        const res = await POST(createReq({ username: 'Newcomer', email: 'new@test.com', password: 'SuperSecretPassword123!' }));
        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.error).toContain('Self-registration is disabled');
        expect(mocks.userCreate).not.toHaveBeenCalled();
    });

    it('still creates the FIRST admin on a zero-user install even when disabled (bootstrap exemption)', async () => {
        mocks.settingFindUnique.mockImplementation(settingImpl('false'));
        mocks.userCount.mockResolvedValue(0);
        mocks.queryRaw.mockResolvedValueOnce([]);
        mocks.userCreate.mockResolvedValueOnce({ id: 'user_boot', username: 'FirstAdmin' });
        mocks.userFindFirst.mockResolvedValueOnce({ id: 'user_boot' });
        mocks.userUpdate.mockResolvedValueOnce({ id: 'user_boot', username: 'FirstAdmin', role: 'ADMIN', isApproved: true });

        const res = await POST(createReq({ username: 'FirstAdmin', email: 'boot@test.com', password: 'SuperSecretPassword123!' }));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.message).toBe('Admin account created successfully.');
    });

    it('stays open by default when the setting row is absent', async () => {
        mocks.settingFindUnique.mockImplementation(settingImpl(null));
        mocks.queryRaw.mockResolvedValueOnce([]);
        mocks.userCreate.mockResolvedValueOnce({ id: 'user_n', username: 'Normal' });
        mocks.userFindFirst.mockResolvedValueOnce({ id: 'someone_else' });

        const res = await POST(createReq({ username: 'Normal', email: 'n@test.com', password: 'SuperSecretPassword123!' }));
        expect(res.status).toBe(200);
        expect(mocks.userCreate).toHaveBeenCalled();
    });
});
