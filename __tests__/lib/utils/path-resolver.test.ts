import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveRemotePath } from '../../../src/lib/utils/path-resolver';
import path from 'path';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findUnique: vi.fn(),
    log: vi.fn()
}));

// 2. Mock the DB and Logger
vi.mock('../../../src/lib/db', () => ({
    prisma: {
        systemSetting: { findUnique: mocks.findUnique }
    }
}));

vi.mock('../../../src/lib/logger', () => ({
    Logger: { log: mocks.log }
}));

describe('Utility: Path Resolver', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should return the original path if no mappings exist in the database', async () => {
        mocks.findUnique.mockResolvedValue(null);
        
        const result = await resolveRemotePath('/downloads/comic.cbz');
        expect(result).toBe('/downloads/comic.cbz');
    });

    it('should translate a mapped Docker path to a local Windows OS path', async () => {
        // Simulate the database returning a mapping rule
        const fakeMappings = JSON.stringify([
            { remote: '/downloads/', local: 'C:\\Data\\Downloads\\' }
        ]);
        mocks.findUnique.mockResolvedValue({ value: fakeMappings });

        // Simulate a file coming back from qBittorrent running in a Docker container
        const result = await resolveRemotePath('/downloads/Batman/issue_1.cbz');
        
        // We use path.normalize so the test passes regardless of whether Vitest is running on Mac/Linux or Windows!
        const expected = path.normalize('C:/Data/Downloads/Batman/issue_1.cbz');
        expect(result).toBe(expected);
    });

    it('should gracefully handle malformed JSON in the database', async () => {
        mocks.findUnique.mockResolvedValue({ value: 'INVALID_JSON_DATA' });

        const result = await resolveRemotePath('/downloads/comic.cbz');
        // Should not crash, just returns the original path
        expect(result).toBe('/downloads/comic.cbz');
    });

    it('should gracefully handle database connection errors', async () => {
        mocks.findUnique.mockRejectedValue(new Error('DB Connection Failed'));

        const result = await resolveRemotePath('/downloads/comic.cbz');
        
        // Should catch the error, log it, and return the original path
        expect(result).toBe('/downloads/comic.cbz');
        expect(mocks.log).toHaveBeenCalled(); 
    });
});