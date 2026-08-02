import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { syncSeriesMetadata } from '@/lib/metadata-fetcher';
import path from 'path';

// 1. Hoist our mocks
const mocks = vi.hoisted(() => ({
    seriesFindFirst: vi.fn(),
    seriesUpdate: vi.fn(),
    issueFindFirst: vi.fn(),
    issueFindMany: vi.fn(), // <-- ADDED: Mock for the new deduplication check
    issueCreate: vi.fn(),
    issueUpdate: vi.fn(),
    systemSettingFindUnique: vi.fn(),
    axiosGet: vi.fn(),
    queueAdd: vi.fn(),
    existsSync: vi.fn(),
    writeFile: vi.fn()
}));

// 2. Mock Dependencies
vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findFirst: mocks.seriesFindFirst, update: mocks.seriesUpdate },
        // <-- ADDED: findMany wired to our mock
        issue: { findFirst: mocks.issueFindFirst, findMany: mocks.issueFindMany, create: mocks.issueCreate, update: mocks.issueUpdate },
        systemSetting: { findUnique: mocks.systemSettingFindUnique }
    }
}));

vi.mock('@/lib/api-client', () => ({
    apiClient: { get: mocks.axiosGet }
}));

vi.mock('@/lib/queue', () => ({
    omnibusQueue: { add: mocks.queueAdd }
}));

vi.mock('fs-extra', () => ({
    default: {
        existsSync: mocks.existsSync,
        mkdirSync: vi.fn(),
        writeFile: mocks.writeFile
    }
}));

// The shared cover-plan helper probes via plain 'fs' — wire it to the same existsSync mock so a
// single switch controls both the fetcher's folder checks and the helper's cover-file probes.
vi.mock('fs', () => ({
    default: { existsSync: mocks.existsSync }
}));

vi.mock('@/lib/utils/system-flags', () => ({ logApiUsage: vi.fn(), markSystemFlag: vi.fn() }));

describe('Metadata Pipeline: ComicVine Sync Engine', () => {
    let originalSetTimeout: typeof setTimeout;

    beforeEach(() => {

        // Bypass all the 3-second API-ban delays in the fetcher to prevent 5000ms test timeouts
        originalSetTimeout = global.setTimeout;
        vi.stubGlobal('setTimeout', (cb: (...args: unknown[]) => void) => originalSetTimeout(cb, 0));

        // Basic default mock for DB
        mocks.seriesFindFirst.mockResolvedValue({ 
            id: 'series_1', 
            metadataId: '4050-123', 
            folderPath: '/comics/Batman', 
            metadataSource: 'COMICVINE',
            year: 2016
        });
        mocks.systemSettingFindUnique.mockResolvedValue({ value: 'mock_api_key' });
        mocks.issueFindFirst.mockResolvedValue(null); // Default: assume no issues exist locally
        mocks.issueFindMany.mockResolvedValue([]);    // <-- ADDED: Default return value for duplicate check
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should successfully sync a series, queue WANTED issues, and trigger EMBED_METADATA', async () => {
        // Mock ComicVine API Volume response
        mocks.axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/volume/')) {
                return {
                    data: {
                        results: {
                            name: 'Batman',
                            start_year: '2016',
                            publisher: { name: 'DC Comics' },
                            image: { medium_url: 'http://cv.com/batman.jpg' }
                        }
                    }
                };
            }
            if (url.includes('/issues/')) {
                return {
                    data: {
                        number_of_total_results: 1,
                        results: [{
                            id: 999,
                            issue_number: '1',
                            name: 'I Am Gotham Part 1',
                            store_date: '2016-06-01'
                        }]
                    }
                };
            }
            // Catch-all mock for downloading the actual cover image buffer
            if (url.includes('batman.jpg')) {
                return { data: Buffer.from('fake_image_data') };
            }
        });

        // Always return true so fs.existsSync passes the folder check
        mocks.existsSync.mockReturnValue(true);

        const result = await syncSeriesMetadata('123', '/comics/Batman', 'COMICVINE');
        expect(result.success).toBe(true);

        // Assert 1: The series was correctly updated
        expect(mocks.seriesUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'series_1' },
            data: expect.objectContaining({
                name: 'Batman',
                publisher: 'DC Comics',
                year: 2016
            })
        }));

        // Assert 2: The missing issue was inserted into the database as WANTED
        expect(mocks.issueCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                seriesId: 'series_1',
                number: '1',
                status: 'WANTED',
                name: 'I Am Gotham Part 1'
            })
        }));

        // Assert 3: It finished by passing the series to the BullMQ XML Embedding queue
        expect(mocks.queueAdd).toHaveBeenCalledWith('EMBED_METADATA', {
            type: 'EMBED_METADATA',
            seriesId: 'series_1'
        }, expect.any(Object));
    });

    it('should fallback to local folder art if ComicVine returns no image', async () => {
        // Mock CV returning NO image
        mocks.axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/volume/')) {
                return { data: { results: { name: 'Local Indie Comic', image: null } } };
            }
            if (url.includes('/issues/')) {
                return { data: { number_of_total_results: 0, results: [] } };
            }
        });

        // Simulate that `cover.jpg` physically exists in the user's folder!
        mocks.existsSync.mockImplementation((pathStr: string) => {
            if (pathStr === '/comics/Indie') return true; 
            if (pathStr === path.join('/comics/Indie', 'cover.jpg')) return true; 
            return false;
        });

        const result = await syncSeriesMetadata('999', '/comics/Indie', 'COMICVINE');
        expect(result.success).toBe(true);

        // Assert: Omnibus intercepted the missing CV image and injected the local API proxy route instead!
        expect(mocks.seriesUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                coverUrl: `/api/library/cover?path=${encodeURIComponent(path.join('/comics/Indie', 'cover.jpg'))}`
            })
        }));
    });

    it("keeps an existing local cover in 'archive' mode instead of downloading provider art (#194 d)", async () => {
        mocks.systemSettingFindUnique.mockImplementation(async ({ where }: any) =>
            where.key === 'cover_source' ? { value: 'archive' } : { value: 'mock_api_key' });
        mocks.axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/volume/')) {
                return { data: { results: { name: 'Batman', start_year: '2016', publisher: { name: 'DC Comics' }, image: { medium_url: 'http://cv.com/batman.jpg' } } } };
            }
            if (url.includes('/issues/')) {
                return { data: { number_of_total_results: 0, results: [] } };
            }
            return { data: Buffer.from('fake_image_data') };
        });
        mocks.existsSync.mockReturnValue(true); // folder + local cover.jpg both "exist"

        const result = await syncSeriesMetadata('123', '/comics/Batman', 'COMICVINE');
        expect(result.success).toBe(true);

        // The provider image was neither downloaded nor written over the local cover...
        expect(mocks.axiosGet).not.toHaveBeenCalledWith('http://cv.com/batman.jpg', expect.anything());
        expect(mocks.writeFile).not.toHaveBeenCalled();
        // ...and the series points at the local cover file.
        expect(mocks.seriesUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                coverUrl: `/api/library/cover?path=${encodeURIComponent(path.join('/comics/Batman', 'cover.jpg'))}`
            })
        }));
    });

    it('preserves a custom cover URL verbatim and never downloads provider art over it (#194 d)', async () => {
        // Custom cover with NO folder cover file — the stored URL must survive the sync untouched.
        mocks.seriesFindFirst.mockResolvedValue({
            id: 'series_1', metadataId: '4050-123', folderPath: '/comics/Batman',
            metadataSource: 'COMICVINE', year: 2016,
            hasCustomCover: true, coverUrl: '/api/uploads/series-covers/custom.jpg'
        });
        mocks.axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/volume/')) {
                return { data: { results: { name: 'Batman', start_year: '2016', publisher: { name: 'DC Comics' }, image: { medium_url: 'http://cv.com/batman.jpg' } } } };
            }
            if (url.includes('/issues/')) {
                return { data: { number_of_total_results: 0, results: [] } };
            }
            return { data: Buffer.from('fake_image_data') };
        });
        mocks.existsSync.mockReturnValue(false);

        const result = await syncSeriesMetadata('123', '/comics/Batman', 'COMICVINE');
        expect(result.success).toBe(true);

        expect(mocks.writeFile).not.toHaveBeenCalled();
        expect(mocks.seriesUpdate.mock.calls[0][0].data.coverUrl).toBe('/api/uploads/series-covers/custom.jpg');
    });

    it('heals crossed issue ids by number instead of trusting the stored id (#194 c1)', async () => {
        // The field case: row "1" wears issue 4's id (821401, DEEP_SYNCED from the old corruption);
        // row "4" is unlinked. The sync must re-key BOTH by number and drop the stale DEEP_SYNCED.
        mocks.issueFindMany.mockResolvedValue([
            { id: 'r1', number: '1', metadataId: '821401', matchState: 'DEEP_SYNCED', hasCustomMetadata: false },
            { id: 'r4', number: '4', metadataId: null, matchState: 'MATCHED', hasCustomMetadata: false },
        ]);
        mocks.issueFindFirst.mockResolvedValue(null); // no cross-series candidates
        mocks.axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/volume/')) {
                return { data: { results: { name: 'Trauma Team', start_year: '2020', publisher: { name: 'Dark Horse' }, image: null } } };
            }
            if (url.includes('/issues/')) {
                return {
                    data: {
                        number_of_total_results: 2,
                        results: [
                            { id: 819000, issue_number: '1', name: 'One', store_date: '2020-09-01' },
                            { id: 821401, issue_number: '4', name: 'Four', store_date: '2021-02-01' },
                        ]
                    }
                };
            }
            return { data: Buffer.from('img') };
        });
        mocks.existsSync.mockReturnValue(false);

        const result = await syncSeriesMetadata('123', '/comics/Trauma Team', 'COMICVINE');
        expect(result.success).toBe(true);

        const updates = mocks.issueUpdate.mock.calls.map(c => c[0]);
        expect(updates).toHaveLength(2);
        const r1 = updates.find(u => u.where.id === 'r1');
        const r4 = updates.find(u => u.where.id === 'r4');
        // r1 re-linked to the CORRECT id for number 1 — not issue 4's — and unlocked for re-enrichment.
        expect(r1.data.metadataId).toBe('819000');
        expect(r1.data.matchState).toBe('MATCHED');
        // The identity anchor is never rewritten by the sync.
        expect('number' in r1.data).toBe(false);
        // r4 adopts its own id.
        expect(r4.data.metadataId).toBe('821401');
        // Nothing inserted — both provider issues landed on existing rows.
        expect(mocks.issueCreate).not.toHaveBeenCalled();
    });
});