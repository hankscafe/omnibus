import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/auth/register/route';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    queryRaw: vi.fn(),
    userCreate: vi.fn(),
    userFindFirst: vi.fn(),
    userUpdate: vi.fn(),
    log: vi.fn(),
    sendDiscord: vi.fn().mockResolvedValue(null),
    sendEmail: vi.fn().mockResolvedValue(null),
    hash: vi.fn().mockResolvedValue('hashed_password')
}));

// 2. Safely isolate the Database, Notifiers, and Logger
vi.mock('@/lib/db', () => ({
    prisma: {
        $queryRaw: mocks.queryRaw,
        user: {
            create: mocks.userCreate,
            findFirst: mocks.userFindFirst,
            update: mocks.userUpdate
        }
    }
}));

vi.mock('bcryptjs', () => ({ default: { hash: mocks.hash } }));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('@/lib/discord', () => ({ DiscordNotifier: { sendAlert: mocks.sendDiscord } }));
vi.mock('@/lib/mailer', () => ({ Mailer: { sendAlert: mocks.sendEmail } }));

// Helper to create a fake NextRequest
const createReq = (body: any) => new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    body: JSON.stringify(body)
});

describe('API Route: POST /api/auth/register', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

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
        expect(mocks.sendDiscord).toHaveBeenCalled();
        expect(mocks.sendEmail).toHaveBeenCalled();
    });
});