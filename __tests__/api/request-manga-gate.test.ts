// __tests__/api/request-manga-gate.test.ts
//
// Manga filtering on requests/downloads. Two contracts:
// 1. A new manga_requests_enabled setting (default ON, absent row = enabled) gates request
//    creation: when off, a request detected as manga is rejected before any rows are written.
// 2. Detection precedence: an existing Series row's isManga flag (set by the scanner's full
//    waterfall incl. ComicInfo) is authoritative — detectManga is only the fallback, because the
//    request-time payload (name+publisher only) is the weakest detection input we have.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST, PATCH } from '@/app/api/request/route';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { detectManga } from '@/lib/manga-detector';
import { searchAndDownload } from '@/lib/automation';

vi.mock('next-auth/jwt', () => ({ getToken: vi.fn() }));
vi.mock('@/lib/automation', () => ({
    searchAndDownload: vi.fn().mockResolvedValue(undefined),
    processAutomationQueue: vi.fn()
}));
vi.mock('@/lib/trophy-evaluator', () => ({ evaluateTrophies: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/manga-detector', () => ({ detectManga: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/metadata-fetcher', () => ({ syncSeriesMetadata: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findUnique: vi.fn() },
        request: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
        series: { upsert: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
        systemSetting: { findUnique: vi.fn(), findMany: vi.fn() }
    }
}));

// Settings lookup keyed by name; override per-test for the manga gate.
const settingsByKey = (overrides: Record<string, string | null> = {}) => async ({ where }: any) => {
    if (where.key in overrides) {
        const v = overrides[where.key];
        return v === null ? null : { key: where.key, value: v };
    }
    return { key: where.key, value: 'dummy' };
};

const issueRequest = (name = 'Naruto #700') => new NextRequest('http://localhost/api/request', {
    method: 'POST',
    body: JSON.stringify({ type: 'issue', name, cvId: 123, publisher: 'Shueisha', year: '1999' })
});

describe('API: request manga gate (POST)', () => {
    beforeEach(() => {
        (getToken as any).mockResolvedValue({ id: 'admin-1', role: 'ADMIN', autoApproveRequests: true, name: 'Admin' });
        (prisma.user.findUnique as any).mockResolvedValue({ id: 'admin-1', role: 'ADMIN', canRequest: true, autoApproveRequests: true });
        (prisma.systemSetting.findUnique as any).mockImplementation(settingsByKey());
        (prisma.systemSetting.findMany as any).mockResolvedValue([]);
        (prisma.series.findUnique as any).mockResolvedValue(null);
        (prisma.request.create as any).mockResolvedValue({ id: 'req-1', status: 'PENDING' });
        (prisma.request.findFirst as any).mockResolvedValue(null);
    });

    it('rejects a manga request with 403 when manga_requests_enabled is off', async () => {
        (prisma.systemSetting.findUnique as any).mockImplementation(settingsByKey({ manga_requests_enabled: 'false' }));
        (detectManga as any).mockResolvedValue(true);

        const res = await POST(issueRequest());
        const data = await res.json();

        expect(res.status).toBe(403);
        expect(data.error).toMatch(/manga/i);
        expect(prisma.request.create).not.toHaveBeenCalled();
        expect(prisma.series.upsert).not.toHaveBeenCalled();
        expect(searchAndDownload).not.toHaveBeenCalled();
    });

    it('allows manga requests by default (no setting row)', async () => {
        (prisma.systemSetting.findUnique as any).mockImplementation(settingsByKey({ manga_requests_enabled: null }));
        (detectManga as any).mockResolvedValue(true);

        const res = await POST(issueRequest());

        expect(res.status).toBe(200);
        expect(prisma.request.create).toHaveBeenCalled();
    });

    it('still allows non-manga requests when the gate is on', async () => {
        (prisma.systemSetting.findUnique as any).mockImplementation(settingsByKey({ manga_requests_enabled: 'false' }));
        (detectManga as any).mockResolvedValue(false);

        const res = await POST(issueRequest('Batman #1'));

        expect(res.status).toBe(200);
        expect(prisma.request.create).toHaveBeenCalled();
    });

    it('trusts an existing Series.isManga=true over re-detection and applies the gate', async () => {
        (prisma.systemSetting.findUnique as any).mockImplementation(settingsByKey({ manga_requests_enabled: 'false' }));
        (prisma.series.findUnique as any).mockResolvedValue({ id: 'ser-1', isManga: true });

        const res = await POST(issueRequest());

        expect(res.status).toBe(403);
        expect(detectManga).not.toHaveBeenCalled();
    });

    it('trusts an existing Series.isManga=false (scanner verdict) without re-detection', async () => {
        (prisma.systemSetting.findUnique as any).mockImplementation(settingsByKey({ manga_requests_enabled: 'false' }));
        // The scanner's full waterfall (incl. ComicInfo + AniList) said NOT manga; a weaker
        // request-time re-detection must not override it.
        (prisma.series.findUnique as any).mockResolvedValue({ id: 'ser-1', isManga: false });
        (detectManga as any).mockResolvedValue(true);

        const res = await POST(issueRequest());

        expect(res.status).toBe(200);
        expect(detectManga).not.toHaveBeenCalled();
        expect(prisma.request.create).toHaveBeenCalled();
    });
});

describe('API: request approval reuses the stored Series.isManga (PATCH)', () => {
    beforeEach(() => {
        (getToken as any).mockResolvedValue({ id: 'admin-1', role: 'ADMIN', name: 'Admin' });
        (prisma.systemSetting.findUnique as any).mockImplementation(settingsByKey());
        (prisma.request.update as any).mockResolvedValue({});
        (prisma.request.count as any).mockResolvedValue(0);
    });

    it('passes the stored isManga to searchAndDownload without re-detecting', async () => {
        (prisma.request.findUnique as any).mockResolvedValue({
            id: 'req-9', userId: 'user-1', volumeId: '555', metadataSource: 'COMICVINE',
            activeDownloadName: 'Naruto #700', downloadLink: null,
            createdAt: new Date(), user: { username: 'reader', email: null }
        });
        (prisma.series.findFirst as any).mockResolvedValue({
            id: 'ser-1', name: 'Naruto', year: 1999, publisher: 'VIZ Media', description: '', isManga: true
        });

        const res = await PATCH(new NextRequest('http://localhost/api/request', {
            method: 'PATCH',
            body: JSON.stringify({ id: 'req-9', status: 'PENDING' })
        }));

        expect(res.status).toBe(200);
        expect(detectManga).not.toHaveBeenCalled();
        // searchAndDownload(id, searchName, year, publisher, isManga, skipIndexers)
        expect(searchAndDownload).toHaveBeenCalledWith('req-9', 'Naruto #700', '1999', 'VIZ Media', true, false);
    });

    it('falls back to detection when no Series row exists', async () => {
        (prisma.request.findUnique as any).mockResolvedValue({
            id: 'req-9', userId: 'user-1', volumeId: '0', metadataSource: 'COMICVINE',
            activeDownloadName: 'Mystery Book #1', downloadLink: null,
            createdAt: new Date(), user: { username: 'reader', email: null }
        });
        (detectManga as any).mockResolvedValue(false);

        const res = await PATCH(new NextRequest('http://localhost/api/request', {
            method: 'PATCH',
            body: JSON.stringify({ id: 'req-9', status: 'PENDING' })
        }));

        expect(res.status).toBe(200);
        expect(detectManga).toHaveBeenCalled();
        expect(searchAndDownload).toHaveBeenCalledWith('req-9', 'Mystery Book #1', '', '', false, false);
    });
});
