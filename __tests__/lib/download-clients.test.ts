import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DownloadService } from '@/lib/download-clients';
import axios from 'axios';
import FormData from 'form-data'; // <-- We import this so we can spy on it!

// 1. Hoist the mocks safely
const mocks = vi.hoisted(() => ({
    axiosGet: vi.fn(),
    axiosPost: vi.fn(),
    findManyHeaders: vi.fn(),
    log: vi.fn()
}));

// 2. Mock Axios completely so no real network requests are made
vi.mock('axios', () => ({
    default: {
        get: mocks.axiosGet,
        post: mocks.axiosPost
    }
}));

// 3. Mock the Database and the Logger
vi.mock('@/lib/db', () => ({
    prisma: {
        customHeader: { findMany: mocks.findManyHeaders }
    }
}));

vi.mock('@/lib/logger', () => ({
    Logger: { log: mocks.log }
}));

vi.mock('@/lib/importer', () => ({ Importer: {} }));

describe('External Integrations: Download Clients (qBittorrent)', () => {
    const mockClient = {
        type: 'qbit',
        url: 'http://192.168.1.100:8080',
        user: 'admin',
        pass: 'adminadmin',
        category: 'comics,manga'
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.findManyHeaders.mockResolvedValue([]);
    });

    it('should successfully authenticate and submit a magnet link to qBittorrent', async () => {
        // We set up a "Spy" to watch every time your code calls FormData.append()
        const appendSpy = vi.spyOn(FormData.prototype, 'append');

        mocks.axiosPost.mockResolvedValueOnce({
            headers: { 'set-cookie': ['SID=fake_auth_cookie_123; HttpOnly;'] },
            data: 'Ok.'
        });

        mocks.axiosPost.mockResolvedValueOnce({
            data: 'Ok.'
        });

        const magnet = 'magnet:?xt=urn:btih:123456789';
        const title = 'Batman #1';

        const result = await DownloadService.addDownload(mockClient, magnet, title, 0, 0);

        expect(result.success).toBe(true);
        expect(mocks.axiosPost).toHaveBeenCalledTimes(2);

        const [loginUrl, loginBody] = mocks.axiosPost.mock.calls[0];
        expect(loginUrl).toBe('http://192.168.1.100:8080/api/v2/auth/login');
        expect(loginBody.toString()).toContain('username=admin');

        const [addUrl, _, requestConfig] = mocks.axiosPost.mock.calls[1];
        expect(addUrl).toBe('http://192.168.1.100:8080/api/v2/torrents/add');
        expect(requestConfig.headers['Cookie']).toEqual(['SID=fake_auth_cookie_123; HttpOnly;']);
        
        // FIX: Assert against our Spy to ensure the correct data was appended to the form!
        expect(appendSpy).toHaveBeenCalledWith('category', 'comics');
        expect(appendSpy).toHaveBeenCalledWith('urls', magnet);
        
        expect(mocks.log).toHaveBeenCalledWith(`[QBIT] SUCCESS: Added ${title}`, 'success');
        
        // Clean up the spy so it doesn't affect other tests
        appendSpy.mockRestore();
    });

    it('should gracefully handle a 403 Forbidden error (bad password)', async () => {
        const mockError = new Error('Request failed with status code 403');
        (mockError as any).response = { status: 403 };
        
        mocks.axiosPost.mockRejectedValueOnce(mockError);

        await expect(
            DownloadService.addDownload(mockClient, 'magnet:?xt=123', 'Batman', 0, 0)
        ).rejects.toThrow('Request failed with status code 403');

        expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining('Failed: Request failed'), 'error');
    });

    it('should gracefully handle the client being completely offline (Network Error)', async () => {
        mocks.axiosPost.mockRejectedValueOnce(new Error('ECONNREFUSED 192.168.1.100'));

        await expect(
            DownloadService.addDownload(mockClient, 'magnet:?xt=123', 'Batman', 0, 0)
        ).rejects.toThrow('ECONNREFUSED');

        expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining('Failed: ECONNREFUSED'), 'error');
    });
});