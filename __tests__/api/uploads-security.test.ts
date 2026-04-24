import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/uploads/[...path]/route';
import { NextRequest } from 'next/server';
import fs from 'fs';

// 1. Hoist our mocks
const mocks = vi.hoisted(() => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(),
    log: vi.fn()
}));

// 2. Mock the file system
vi.mock('fs', () => ({
    default: {
        existsSync: mocks.existsSync,
        readFileSync: mocks.readFileSync,
        statSync: mocks.statSync
    }
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

describe('Security: Static Uploads API', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.OMNIBUS_CONFIG_DIR = '/app/config';
    });

    const createReq = () => new NextRequest('http://localhost/api/uploads/test.jpg');

    it('should strictly block Path Traversal attacks (e.g. ../../../etc/passwd)', async () => {
        // A hacker tries to back out of the uploads directory to read a system file
        const maliciousPath = ['..', '..', '..', 'etc', 'passwd.jpg'];
        
        // This will attempt to resolve the path. path.resolve will process the '..'
        // causing it to fall outside of the base '/app/config/uploads' directory.
        const res = await GET(createReq(), { params: Promise.resolve({ path: maliciousPath }) });
        
        // Assert that the security block kicks in and returns a 403 Forbidden
        expect(res.status).toBe(403);
        expect(await res.text()).toBe('Forbidden');
    });

    it('should strictly block non-image file extensions', async () => {
        // A hacker tries to upload and execute a bash script disguised as an avatar
        const maliciousPath = ['avatars', 'hacked_script.sh'];
        
        mocks.existsSync.mockReturnValueOnce(true);
        mocks.statSync.mockReturnValueOnce({ isFile: () => true });

        const res = await GET(createReq(), { params: Promise.resolve({ path: maliciousPath }) });
        
        expect(res.status).toBe(403);
        expect(await res.text()).toContain('Forbidden file type');
    });

    it('should successfully return a valid image file', async () => {
        const validPath = ['avatars', 'user_1.jpg'];
        
        mocks.existsSync.mockReturnValueOnce(true);
        mocks.statSync.mockReturnValueOnce({ isFile: () => true });
        mocks.readFileSync.mockReturnValueOnce(Buffer.from('fake_image_data'));

        const res = await GET(createReq(), { params: Promise.resolve({ path: validPath }) });
        
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/jpeg');
        expect(res.headers.get('Cache-Control')).toContain('immutable');
    });
});