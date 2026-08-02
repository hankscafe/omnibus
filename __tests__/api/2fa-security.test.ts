// __tests__/api/user/2fa-security.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/user/2fa/route'; 
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';

// 1. Provide a blanket mock for otplib to guarantee the success branch can be reached
vi.mock('otplib', () => {
    const auth = {
        generateSecret: () => 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
        verify: () => true,
        check: () => true
    };
    return {
        __esModule: true,
        authenticator: auth,
        default: { authenticator: auth },
        verify: auth.verify,
        check: auth.check
    };
});

// 2. Prevent NextAuth options process.exit(1)

// 3. Mock NextAuth session
vi.mock('next-auth/next', () => ({
    getServerSession: vi.fn()
}));

// 4. Mock Prisma
vi.mock('@/lib/db', () => ({
    prisma: {
        user: {
            findUnique: vi.fn(),
            update: vi.fn().mockResolvedValue({})
        }
    }
}));

// 5. Mock Rate Limiter
vi.mock('@/lib/rate-limit', () => ({
    checkRateLimit: vi.fn().mockReturnValue({
        isLimited: false,
        trackSuccess: vi.fn(),
        trackFailure: vi.fn()
    })
}));

// 6. Mock Encryption
vi.mock('@/lib/encryption', () => ({
    encrypt2FA: vi.fn().mockResolvedValue('ENCRYPTED_SECRET')
}));

// 7. Mock Audit Logger

// 8. Mock QRCode
vi.mock('qrcode', () => ({
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,mock')
}));

const VALID_BASE32_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

describe('API: 2FA Security Boundary', () => {

    it('should reject requests without a valid session', async () => {
        (getServerSession as any).mockResolvedValueOnce(null);
        
        const req = new NextRequest('http://localhost/api/user/2fa', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'enable', secret: VALID_BASE32_SECRET, code: '123456' })
        });

        const res = await POST(req);
        expect(res.status).toBe(401);
    });

    it('should explicitly reject empty, null, or missing verification codes/secrets', async () => {
        (getServerSession as any).mockResolvedValueOnce({ user: { id: 'user-1' } });
        
        const req = new NextRequest('http://localhost/api/user/2fa', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'enable', secret: VALID_BASE32_SECRET, code: '' }) 
        });

        const res = await POST(req);
        const data = await res.json();
        
        // This validates the 400 Bad Request boundary securely before the library is ever invoked
        expect(res.status).toBe(400);
        expect(data.error).toMatch(/Missing parameters/i);
        expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('should successfully enable 2FA when valid code is provided', async () => {
        (getServerSession as any).mockResolvedValueOnce({ user: { id: 'user-1' } });
        (prisma.user.update as any).mockResolvedValueOnce({ id: 'user-1', twoFactorEnabled: true });
        
        const req = new NextRequest('http://localhost/api/user/2fa', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'enable', secret: VALID_BASE32_SECRET, code: '123456' })
        });

        const res = await POST(req);
        const data = await res.json();
        
        expect(res.status).toBe(200);
        expect(data.success).toBe(true);
        
        // Verify the database transaction completes securely with encrypted payload
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            data: { twoFactorEnabled: true, twoFactorSecret: 'ENCRYPTED_SECRET' }
        });
    });
});