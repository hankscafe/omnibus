// __tests__/api/match-series.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/library/match-series/route';
import fs from 'fs';
import axios from 'axios';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findManyLibraries: vi.fn(),
    findUniqueSetting: vi.fn(),
    findUniqueSeries: vi.fn(),
    findFirstSeries: vi.fn(),
    createSeries: vi.fn(),
    log: vi.fn(),
    getSeriesDetails: vi.fn(),
    findManySettings: vi.fn(),
    findManyRequests: vi.fn(),
    updateManyRequests: vi.fn(),
    findManyIssues: vi.fn(),
    updateManyIssues: vi.fn(),
    updateSeries: vi.fn(),
    deleteSeries: vi.fn(),
    transaction: vi.fn()
}));

// 2. Mock Server Dependencies
vi.mock('next/cache', () => ({
    revalidatePath: vi.fn(),
    revalidateTag: vi.fn()
}));

vi.mock('next-auth', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } })
}));

vi.mock('next-auth/next', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } })
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {}
}));

vi.mock('@/lib/audit-logger', () => ({
    AuditLogger: { log: vi.fn().mockResolvedValue(true) }
}));

// 3. Mock Database & App Dependencies
vi.mock('@/lib/db', () => ({
    prisma: {
        library: { findMany: mocks.findManyLibraries },
        systemSetting: { findMany: mocks.findManySettings, findUnique: mocks.findUniqueSetting },
        series: { findUnique: mocks.findUniqueSeries, findFirst: mocks.findFirstSeries, create: mocks.createSeries, update: mocks.updateSeries, delete: mocks.deleteSeries },
        issue: { findMany: mocks.findManyIssues, updateMany: mocks.updateManyIssues },
        request: { findMany: mocks.findManyRequests, updateMany: mocks.updateManyRequests },
        $transaction: mocks.transaction
    }
}));

vi.mock('axios');

vi.mock('fs', () => ({
    default: {
        existsSync: vi.fn().mockReturnValue(true),
        mkdirSync: vi.fn(),
        promises: {
            stat: vi.fn().mockResolvedValue({ isFile: () => false }),
            readdir: vi.fn().mockResolvedValue([]),
            rename: vi.fn().mockResolvedValue(true),
            mkdir: vi.fn().mockResolvedValue(true),
            rmdir: vi.fn().mockResolvedValue(true),
            writeFile: vi.fn().mockResolvedValue(true)
        }
    }
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

vi.mock('@/lib/discord', () => ({ DiscordNotifier: { sendAlert: vi.fn().mockResolvedValue(true) } }));

vi.mock('@/lib/manga-detector', () => ({ detectManga: vi.fn().mockResolvedValue(false) }));

vi.mock('@/lib/metadata/providers/metron', () => {
    return { MetronProvider: class { getSeriesDetails = mocks.getSeriesDetails } }
});

vi.mock('@/lib/queue', () => ({ omnibusQueue: { add: vi.fn() } }));

const createReq = (body: any) => new Request('http://localhost/api/library/match-series', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
});

describe('API Route: Smart Matcher (/api/library/match-series)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Setup default path access
        process.env.OMNIBUS_AWAITING_MATCH_DIR = '/unmatched';
        mocks.findManyLibraries.mockResolvedValue([{ id: 'lib_1', path: '/comics', isDefault: true }]);
        mocks.findUniqueSeries.mockResolvedValue(null);
        mocks.findFirstSeries.mockResolvedValue(null);
        mocks.findManySettings.mockResolvedValue([]);
        mocks.findManyRequests.mockResolvedValue([]);
        mocks.findManyIssues.mockResolvedValue([]);
        mocks.createSeries.mockResolvedValue({ id: 'series_123', folderPath: '/comics/Batman' });
        mocks.updateSeries.mockResolvedValue({ id: 'series_123', folderPath: '/comics/Batman' });
    });

    it('should query ComicVine by default if metadataSource is not provided', async () => {
        mocks.findUniqueSetting.mockResolvedValueOnce({ value: 'cv_api_key' });
        vi.mocked(axios.get).mockResolvedValueOnce({ data: { results: { name: 'Batman (CV)', start_year: '2016' } } } as any);

        const res = await POST(createReq({ oldFolderPath: '/unmatched/Batman', metadataId: '4050-1234' }));
        expect(res.status).toBe(200);

        expect(axios.get).toHaveBeenCalledWith(
            expect.stringContaining('comicvine'),
            expect.objectContaining({ params: expect.objectContaining({ api_key: 'cv_api_key' }) })
        );
        expect(mocks.createSeries).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ metadataSource: 'COMICVINE', name: 'Batman (CV)', year: 2016 })
        }));
    });

    it('should route to Metron if metadataSource is explicitly passed as METRON', async () => {
        mocks.getSeriesDetails.mockResolvedValueOnce({ name: 'Batman (Metron)', year: 2020, publisher: 'DC Comics', coverUrl: 'http://metron.image' });
        vi.mocked(axios.get).mockResolvedValueOnce({ data: Buffer.from('fake_image_data') } as any); // Mock the image download

        const res = await POST(createReq({ oldFolderPath: '/unmatched/Batman', metadataId: '987', metadataSource: 'METRON' }));
        expect(res.status).toBe(200);

        expect(mocks.getSeriesDetails).toHaveBeenCalledWith('987');
        
        // Ensure CV was skipped (but allow the cover image download via axios)
        expect(axios.get).not.toHaveBeenCalledWith(
            expect.stringContaining('comicvine'),
            expect.any(Object)
        );
        
        expect(mocks.createSeries).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ metadataSource: 'METRON', name: 'Batman (Metron)', year: 2020 })
        }));
    });

    it('should reject access if the oldFolderPath is outside of authorized libraries', async () => {
        // Attack attempt: Trying to rename a system file
        const res = await POST(createReq({ oldFolderPath: '/etc/shadow', metadataId: '123' }));
        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.error).toBe('Unauthorized path access');
    });
});