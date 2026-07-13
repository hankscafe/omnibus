// __tests__/api/request/request-engine.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/request/route';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { searchAndDownload } from '@/lib/automation';

// Mock Dependencies
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn() }));
vi.mock('@/lib/automation', () => ({ 
    searchAndDownload: vi.fn().mockResolvedValue(undefined), 
    processAutomationQueue: vi.fn() 
}))
vi.mock('@/lib/notifications', () => ({ SystemNotifier: { sendAlert: vi.fn().mockResolvedValue(true) } }));
vi.mock('@/lib/trophy-evaluator', () => ({ evaluateTrophies: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/manga-detector', () => ({ detectManga: vi.fn().mockResolvedValue(false) }));

vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findUnique: vi.fn() },
        request: { create: vi.fn(), findFirst: vi.fn() },
        series: { upsert: vi.fn(), findUnique: vi.fn() },
        systemSetting: { findUnique: vi.fn() }
    }
}));

describe('API: Request Engine boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (prisma.user.findUnique as any).mockResolvedValue({ id: 'user-1' });
        (prisma.systemSetting.findUnique as any).mockResolvedValue({ value: 'dummy-key' });
    });

    it('should assign PENDING_APPROVAL status to standard users without auto-approve rights', async () => {
        // Standard user (Sidekick): may request, but no auto-approve. The gate now reads the DB user.
        (getToken as any).mockResolvedValueOnce({ id: 'user-1', role: 'USER', autoApproveRequests: false });
        (prisma.user.findUnique as any).mockResolvedValue({ id: 'user-1', role: 'USER', canRequest: true, autoApproveRequests: false });

        (prisma.request.create as any).mockResolvedValueOnce({ id: 'req-1', status: 'PENDING_APPROVAL' });

        const req = new NextRequest('http://localhost/api/request', {
            method: 'POST',
            body: JSON.stringify({ type: 'issue', name: 'Batman #1', cvId: 123, publisher: 'DC', year: '2016' })
        });

        const res = await POST(req);
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.status).toBe('PENDING_APPROVAL');
        // Ensure the downloader wasn't triggered
        expect(searchAndDownload).not.toHaveBeenCalled(); 
        expect(prisma.request.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: 'PENDING_APPROVAL' })
            })
        );
    });

    it('should assign PENDING status and trigger downloader for Admins/Auto-Approve users', async () => {
        // Admin user (bypasses the request gate, auto-approves).
        (getToken as any).mockResolvedValueOnce({ id: 'admin-1', role: 'ADMIN', autoApproveRequests: true });
        (prisma.user.findUnique as any).mockResolvedValue({ id: 'admin-1', role: 'ADMIN', canRequest: true, autoApproveRequests: true });

        (prisma.request.create as any).mockResolvedValueOnce({ id: 'req-2', status: 'PENDING' });

        const req = new NextRequest('http://localhost/api/request', {
            method: 'POST',
            body: JSON.stringify({ type: 'issue', name: 'Batman #1', cvId: 123, publisher: 'DC', year: '2016' })
        });

        const res = await POST(req);
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.status).toBe('PENDING');
        // Ensure the downloader WAS triggered
        expect(searchAndDownload).toHaveBeenCalled();
        expect(prisma.request.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: 'PENDING' })
            })
        );
    });

    it('should reject a user WITHOUT the Request permission (Civilian) with 403', async () => {
        (getToken as any).mockResolvedValueOnce({ id: 'civ-1', role: 'USER', autoApproveRequests: false });
        (prisma.user.findUnique as any).mockResolvedValue({ id: 'civ-1', role: 'USER', canRequest: false, autoApproveRequests: false });

        const req = new NextRequest('http://localhost/api/request', {
            method: 'POST',
            body: JSON.stringify({ type: 'issue', name: 'Batman #1', cvId: 123, publisher: 'DC', year: '2016' })
        });

        const res = await POST(req);

        expect(res.status).toBe(403);
        // The request was never created and the downloader never fired.
        expect(prisma.request.create).not.toHaveBeenCalled();
        expect(searchAndDownload).not.toHaveBeenCalled();
    });
});