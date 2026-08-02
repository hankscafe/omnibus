import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DownloadService } from '@/lib/download-clients';
import axios from 'axios';
import FormData from 'form-data'; // <-- We import this so we can spy on it!
import { loggerLog } from '../helpers/setup-global';

// 1. Hoist the mocks safely
const mocks = vi.hoisted(() => ({
    axiosGet: vi.fn(),
    axiosPost: vi.fn(),
    findManyHeaders: vi.fn(),
    settingFindUnique: vi.fn(),
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
        customHeader: { findMany: mocks.findManyHeaders },
        systemSetting: { findUnique: mocks.settingFindUnique }
    }
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

        const [loginUrl, loginBody, loginConfig] = mocks.axiosPost.mock.calls[0];
        expect(loginUrl).toBe('http://192.168.1.100:8080/api/v2/auth/login');
        expect(loginBody.toString()).toContain('username=admin');
        // Strict qBittorrent CSRF configs 403 the login without a matching Referer/Origin (issue #193).
        expect(loginConfig.headers['Referer']).toBe('http://192.168.1.100:8080');
        expect(loginConfig.headers['Origin']).toBe('http://192.168.1.100:8080');

        const [addUrl, _, requestConfig] = mocks.axiosPost.mock.calls[1];
        expect(addUrl).toBe('http://192.168.1.100:8080/api/v2/torrents/add');
        // The SID is extracted cleanly — attributes like HttpOnly no longer leak into the Cookie header.
        expect(requestConfig.headers['Cookie']).toBe('SID=fake_auth_cookie_123');
        
        // FIX: Assert against our Spy to ensure the correct data was appended to the form!
        expect(appendSpy).toHaveBeenCalledWith('category', 'comics');
        expect(appendSpy).toHaveBeenCalledWith('urls', magnet);
        
        expect(loggerLog).toHaveBeenCalledWith(`[QBIT] SUCCESS: Added ${title}`, 'success');
        
        // Clean up the spy so it doesn't affect other tests
        appendSpy.mockRestore();
    });

    it('routes manga to the SECOND configured category, comics to the first', async () => {
        // category = "comics,manga": a comics add uses "comics" (covered above); a manga add must use "manga"
        // so the two land under their own category/label in the client.
        const appendSpy = vi.spyOn(FormData.prototype, 'append');
        mocks.axiosPost
            .mockResolvedValueOnce({ headers: { 'set-cookie': ['SID=x'] }, data: 'Ok.' })  // auth.login
            .mockResolvedValueOnce({ data: 'Ok.' });                                          // add

        await DownloadService.addDownload(mockClient, 'magnet:?xt=urn:btih:1', 'Naruto #1', 0, 0, true);

        expect(appendSpy).toHaveBeenCalledWith('category', 'manga');
        appendSpy.mockRestore();
    });

    it('translates a login 403 into the IP-ban explanation (issue #193 — a 403 is the ban, not bad credentials)', async () => {
        const mockError = new Error('Request failed with status code 403');
        (mockError as any).response = { status: 403 };

        mocks.axiosPost.mockRejectedValueOnce(mockError);

        await expect(
            DownloadService.addDownload(mockClient, 'magnet:?xt=123', 'Batman', 0, 0)
        ).rejects.toThrow(/banned this IP after failed login attempts/);

        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('banned this IP'), 'error');
    });

    it('rejects a "Fails." login body (wrong credentials come back as HTTP 200) instead of a misleading later 403', async () => {
        // qBittorrent answers wrong credentials with HTTP 200 + "Fails." and NO cookie — the old
        // code sailed past this and the torrents/add call then failed with an opaque 403.
        mocks.axiosPost.mockResolvedValueOnce({ headers: {}, data: 'Fails.' });

        await expect(
            DownloadService.addDownload(mockClient, 'magnet:?xt=123', 'Batman', 0, 0)
        ).rejects.toThrow(/rejected the username\/password/);

        // No second call — the failure is caught AT login, not after it.
        expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('accepts qBittorrent 5.2\'s login shape: 204, EMPTY body, renamed QBT_SID_<port> cookie (issue #193)', async () => {
        // Shapes recorded from a live qBittorrent 5.2.3 (also covered end-to-end by the opt-in
        // __tests__/integration/qbit-live.test.ts): success is NO LONGER 200 + "Ok." + SID.
        mocks.axiosPost.mockResolvedValueOnce({
            status: 204,
            data: '',
            headers: { 'set-cookie': ['QBT_SID_8084=UOSXKevJgxmEEVMVMItfcFHDSoz9UYam; HttpOnly; SameSite=Lax; path=/'] }
        });
        mocks.axiosPost.mockResolvedValueOnce({ data: 'Ok.' }); // torrents/add

        const result = await DownloadService.addDownload(mockClient, 'magnet:?xt=urn:btih:52', 'Batman #52', 0, 0);

        expect(result.success).toBe(true);
        const [, , requestConfig] = mocks.axiosPost.mock.calls[1];
        expect(requestConfig.headers['Cookie']).toBe('QBT_SID_8084=UOSXKevJgxmEEVMVMItfcFHDSoz9UYam');
    });

    it('maps qBittorrent 5.2\'s wrong-credentials shape (HTTP 401) to the credential message, not the ban', async () => {
        const mockError = new Error('Request failed with status code 401');
        (mockError as any).response = { status: 401 };
        mocks.axiosPost.mockRejectedValueOnce(mockError);

        await expect(
            DownloadService.addDownload(mockClient, 'magnet:?xt=123', 'Batman', 0, 0)
        ).rejects.toThrow(/rejected the username\/password \(HTTP 401\)/);

        // One attempt only — hammering a 401 walks straight into the IP ban.
        expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    });

    it('uses stateless Bearer auth when an API key is configured (qBittorrent 5.2+) — no login call at all', async () => {
        const keyClient = { ...mockClient, apiKey: 'qbt_abcdefghijklmnopqrstuvwxyz12' };
        mocks.axiosPost.mockResolvedValueOnce({ data: 'Ok.' }); // torrents/add only

        const result = await DownloadService.addDownload(keyClient, 'magnet:?xt=urn:btih:9', 'Saga #1', 0, 0);

        expect(result.success).toBe(true);
        // Exactly ONE post — torrents/add. The login endpoint is never touched, so an API-key
        // client can never trigger qBittorrent's failed-login IP ban.
        expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
        const [addUrl, _, requestConfig] = mocks.axiosPost.mock.calls[0];
        expect(addUrl).toBe('http://192.168.1.100:8080/api/v2/torrents/add');
        expect(requestConfig.headers['Authorization']).toBe('Bearer qbt_abcdefghijklmnopqrstuvwxyz12');
        expect(requestConfig.headers['Cookie']).toBeUndefined();
    });

    it('should gracefully handle the client being completely offline (Network Error)', async () => {
        mocks.axiosPost.mockRejectedValueOnce(new Error('ECONNREFUSED 192.168.1.100'));

        await expect(
            DownloadService.addDownload(mockClient, 'magnet:?xt=123', 'Batman', 0, 0)
        ).rejects.toThrow('ECONNREFUSED');

        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('Failed: ECONNREFUSED'), 'error');
    });

    const delugeClient = { type: 'deluge', url: 'http://192.168.1.50:8112', user: 'admin', pass: 'deluge', category: 'comics' };

    it('adds a magnet to Deluge using the correct core.add_torrent_magnet method (regression: was "magents")', async () => {
        mocks.axiosPost
            .mockResolvedValueOnce({ headers: { 'set-cookie': ['_session_id=abc'] }, data: { result: true } }) // auth.login
            .mockResolvedValueOnce({ data: { result: 'torrent_hash_123' } });                                  // add

        const result = await DownloadService.addDownload(delugeClient, 'magnet:?xt=urn:btih:abc', 'Batman #1', 0, 0);

        expect(result.success).toBe(true);
        expect(mocks.axiosPost.mock.calls[1][1].method).toBe('core.add_torrent_magnet');
    });

    it('labels the Deluge torrent with the configured category so a shared instance can be filtered', async () => {
        // qBit/SAB/NZBGet set their native category on add; Deluge has no category, so Omnibus tags the
        // torrent with the configured category as a Label-plugin label. Without this, Omnibus's own comics
        // torrents would be unlabeled and the category-filtered active-downloads list would hide them.
        mocks.axiosPost
            .mockResolvedValueOnce({ headers: { 'set-cookie': ['_session_id=abc'] }, data: { result: true } })  // auth.login
            .mockResolvedValueOnce({ data: { result: 'torrent_hash_123' } })                                     // add (returns torrent id)
            .mockResolvedValueOnce({ data: { result: null } })                                                   // label.add
            .mockResolvedValueOnce({ data: { result: true } });                                                  // label.set_torrent

        const result = await DownloadService.addDownload(delugeClient, 'magnet:?xt=urn:btih:abc', 'Batman #1', 0, 0);

        expect(result.success).toBe(true);
        const setLabelCall = mocks.axiosPost.mock.calls.find(c => c[1]?.method === 'label.set_torrent');
        expect(setLabelCall).toBeTruthy();
        expect(setLabelCall![1].params).toEqual(['torrent_hash_123', 'comics']);
    });

    it('does not fail the add when the Deluge Label plugin is unavailable (best-effort labeling)', async () => {
        // label.add / label.set_torrent return a 200 JSON-RPC error when the plugin is off; the add must
        // still succeed (the labeling is best-effort, not a hard requirement).
        mocks.axiosPost
            .mockResolvedValueOnce({ headers: { 'set-cookie': ['_session_id=abc'] }, data: { result: true } })  // auth.login
            .mockResolvedValueOnce({ data: { result: 'torrent_hash_123' } })                                     // add
            .mockRejectedValueOnce(new Error('Unknown method label.add'))                                        // label.add throws
            .mockRejectedValueOnce(new Error('Unknown method label.set_torrent'));                               // label.set_torrent throws

        const result = await DownloadService.addDownload(delugeClient, 'magnet:?xt=urn:btih:abc', 'Batman #1', 0, 0);

        expect(result.success).toBe(true);
    });

    it('does not force the Deluge save path to the category string (download_location quirk)', async () => {
        mocks.axiosPost
            .mockResolvedValueOnce({ headers: { 'set-cookie': ['_session_id=abc'] }, data: { result: true } })  // auth.login
            .mockResolvedValueOnce({ data: { result: 'torrent_hash_123' } })                                     // add
            .mockResolvedValueOnce({ data: { result: null } })                                                   // label.add
            .mockResolvedValueOnce({ data: { result: true } });                                                  // label.set_torrent

        await DownloadService.addDownload(delugeClient, 'magnet:?xt=urn:btih:abc', 'Batman #1', 0, 0);

        // The add options (params[1] of the add call) must NOT pin download_location to "comics".
        const addOptions = mocks.axiosPost.mock.calls[1][1].params[1];
        expect(addOptions.download_location).toBeUndefined();
    });

    it('throws on a Deluge HTTP-200 JSON-RPC error instead of reporting false success', async () => {
        mocks.axiosPost
            .mockResolvedValueOnce({ headers: { 'set-cookie': ['_session_id=abc'] }, data: { result: true } }) // auth.login
            .mockResolvedValueOnce({ data: { result: null, error: { message: 'Unknown method' } } });          // add error (HTTP 200)

        await expect(
            DownloadService.addDownload(delugeClient, 'magnet:?xt=urn:btih:abc', 'Batman #1', 0, 0)
        ).rejects.toThrow('Deluge add failed');
    });
});
describe('Issue #197: Prowlarr NZB handoff fetches content instead of handing NZBGet a URL', () => {
    const nzbgetClient = {
        type: 'nzbget',
        url: 'http://192.168.2.220:6789',
        user: 'nzbget',
        pass: 'pass',
        category: 'comics'
    };
    const PROWLARR_DL = 'http://192.168.2.210:9696/1/download?apikey=k&link=abc';
    const NZB_XML = '<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file/></nzb>';

    beforeEach(() => {
        mocks.findManyHeaders.mockResolvedValue([]);
        mocks.settingFindUnique.mockImplementation(({ where }: any) =>
            Promise.resolve(where.key === 'prowlarr_url' ? { key: 'prowlarr_url', value: 'http://192.168.2.210:9696' } : null));
        mocks.axiosPost.mockResolvedValue({ data: { result: 1 } });
    });

    it('pre-fetches from the configured Prowlarr origin (private host allowed) and appends base64 content', async () => {
        mocks.axiosGet.mockResolvedValueOnce({ data: Buffer.from(NZB_XML) });

        const result = await DownloadService.addDownload(nzbgetClient, PROWLARR_DL, 'Comic #1', 0, 0);

        expect(result.success).toBe(true);
        expect(mocks.axiosGet).toHaveBeenCalledTimes(1);
        expect(mocks.axiosGet.mock.calls[0][0]).toBe(PROWLARR_DL);
        const rpc = mocks.axiosPost.mock.calls[0][1];
        expect(rpc.method).toBe('append');
        expect(rpc.params[1]).toBe(Buffer.from(NZB_XML).toString('base64'));
    });

    it('discards an HTML block page (Cloudflare) and falls back to the URL with a warning', async () => {
        mocks.axiosGet.mockResolvedValueOnce({ data: Buffer.from('<!DOCTYPE html><html><title>Just a moment...</title></html>') });

        await DownloadService.addDownload(nzbgetClient, PROWLARR_DL, 'Comic #1', 0, 0);

        const rpc = mocks.axiosPost.mock.calls[0][1];
        expect(rpc.params[1]).toBe(PROWLARR_DL);
        const warned = loggerLog.mock.calls.some(c => String(c[0]).toLowerCase().includes('html'));
        expect(warned).toBe(true);
    });

    it('still refuses to pre-fetch private hosts that are NOT the configured Prowlarr origin', async () => {
        mocks.settingFindUnique.mockResolvedValue(null); // nothing configured

        await DownloadService.addDownload(nzbgetClient, PROWLARR_DL, 'Comic #1', 0, 0);

        expect(mocks.axiosGet).not.toHaveBeenCalled();
        const rpc = mocks.axiosPost.mock.calls[0][1];
        expect(rpc.params[1]).toBe(PROWLARR_DL);
    });
});

describe('Issue #198: removeDownload reaches HISTORY items, not just the queue', () => {
    // SAB/NZBGet report failures from history (par/unpack failures land there), where the old
    // queue-scoped delete silently no-op'd — failed jobs' files lingered forever.

    beforeEach(() => {
        mocks.findManyHeaders.mockResolvedValue([]);
        mocks.settingFindUnique.mockResolvedValue(null);
    });

    it('SABnzbd: sweeps the queue AND the history, both with del_files', async () => {
        const sabClient = { type: 'sab', url: 'http://192.168.1.60:8085', apiKey: 'sabkey', category: 'comics' };
        mocks.axiosGet.mockResolvedValue({ data: { status: true } });

        const ok = await DownloadService.removeDownload(sabClient, 'SABnzbd_nzo_abc123');

        expect(ok).toBe(true);
        expect(mocks.axiosGet).toHaveBeenCalledTimes(2);
        const queueParams = mocks.axiosGet.mock.calls[0][1].params;
        expect(queueParams).toMatchObject({ mode: 'queue', name: 'delete', value: 'SABnzbd_nzo_abc123', del_files: 1 });
        const historyParams = mocks.axiosGet.mock.calls[1][1].params;
        expect(historyParams).toMatchObject({ mode: 'history', name: 'delete', value: 'SABnzbd_nzo_abc123', del_files: 1 });
    });

    it('NZBGet: GroupDelete for the queue, then HistoryDelete for the parked record', async () => {
        const nzbClient = { type: 'nzbget', url: 'http://192.168.1.61:6789', user: 'nzbget', pass: 'pass', category: 'comics' };
        mocks.axiosPost.mockResolvedValue({ data: { result: true } });

        const ok = await DownloadService.removeDownload(nzbClient, '42');

        expect(ok).toBe(true);
        expect(mocks.axiosPost).toHaveBeenCalledTimes(2);
        expect(mocks.axiosPost.mock.calls[0][1]).toEqual({ method: 'editqueue', params: ['GroupDelete', 0, '', [42]] });
        expect(mocks.axiosPost.mock.calls[1][1]).toEqual({ method: 'editqueue', params: ['HistoryDelete', 0, '', [42]] });
    });

    it('a failing history sweep never fails the removal (best-effort)', async () => {
        const sabClient = { type: 'sab', url: 'http://192.168.1.60:8085', apiKey: 'sabkey', category: 'comics' };
        mocks.axiosGet
            .mockResolvedValueOnce({ data: { status: true } })       // queue delete works
            .mockRejectedValueOnce(new Error('history endpoint 500')); // history sweep hiccups

        const ok = await DownloadService.removeDownload(sabClient, 'SABnzbd_nzo_abc123');

        expect(ok).toBe(true);
    });
});
