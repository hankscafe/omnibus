// __tests__/api/opds-streaming.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/opds/page/[issueId]/[pageIndex]/route';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    validateApiKey: vi.fn(),
    findUniqueIssue: vi.fn(),
    log: vi.fn(),
    getEntries: vi.fn()
}));

// 2. Mock Dependencies
vi.mock('@/lib/api-auth', () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock('@/lib/db', () => ({
    prisma: { issue: { findUnique: mocks.findUniqueIssue } }
}));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

// Mock filesystem checks
vi.mock('fs', () => ({
    default: { existsSync: vi.fn().mockReturnValue(true) }
}));

// Mock AdmZip to simulate an archive with 3 images
vi.mock('adm-zip', () => {
    return {
        default: class AdmZipMock {
            getEntries() { return mocks.getEntries(); }
        }
    };
});

// Helper to create fake Next.js Route handlers parameters
const createReq = () => new Request('http://localhost/api/opds/page/iss_1/1');
const createParams = (issueId: string, pageIndex: string) => Promise.resolve({ issueId, pageIndex });

describe('External Integration: OPDS Page Streaming Extension (PSE)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        
        // Default valid auth
        mocks.validateApiKey.mockResolvedValue({ valid: true, user: { id: 'u1', role: 'ADMIN' } } as any);
        
        // Default valid issue
        mocks.findUniqueIssue.mockResolvedValue({ id: 'iss_1', filePath: '/comics/batman.cbz' });

        // Simulate a CBZ file containing 3 valid pages and 1 junk file
        mocks.getEntries.mockReturnValue([
            { entryName: 'page_001.jpg', isDirectory: false, getData: () => Buffer.from('img1') },
            { entryName: 'page_002.png', isDirectory: false, getData: () => Buffer.from('img2') },
            { entryName: 'page_003.webp', isDirectory: false, getData: () => Buffer.from('img3') },
            { entryName: 'ComicInfo.xml', isDirectory: false, getData: () => Buffer.from('xml') } // Junk file
        ]);
    });

    it('should reject unauthorized requests', async () => {
        mocks.validateApiKey.mockResolvedValueOnce({ valid: false } as any);

        const res = await GET(createReq(), { params: createParams('iss_1', '0') }) as Response;
        expect(res.status).toBe(401);
    });

    it('should return 404 if the page index is out of bounds', async () => {
        // Request page index 5 (only 0, 1, 2 exist)
        const res = await GET(createReq(), { params: createParams('iss_1', '5') }) as Response;
        
        expect(res.status).toBe(404);
        expect(await res.text()).toBe('Page Not Found');
    });

    it('should successfully stream the requested image buffer with correct Content-Type', async () => {
        // Request page index 1 (which is page_002.png)
        const res = await GET(createReq(), { params: createParams('iss_1', '1') }) as Response;
        
        expect(res.status).toBe(200);
        // Ensure it correctly detected the PNG extension from the internal archive file
        expect(res.headers.get('Content-Type')).toBe('image/png');
        // Ensure OPDS clients are told to aggressively cache the immutable page
        expect(res.headers.get('Cache-Control')).toContain('immutable');
        
        const text = await res.text();
        expect(text).toBe('img2');
    });
});