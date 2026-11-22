// __tests__/lib/annas-test.test.ts
//
// Issue #277: "Test API Key" for Anna's Archive always failed with "Record not found". The test asked
// AA for a fast-download link for md5 000…0, a record that doesn't exist. AA checks the md5's format,
// then the key, and only then looks the record up (verified 2026-11-22 against annas-archive.gl with a
// fake key: 000…0 answers 401 "Invalid secret key", "xyz" answers 400 "Invalid md5"). So a VALID key
// got as far as the lookup and failed there - and because the same test gates turning AA automation
// on (/api/admin/config), nobody could enable it. The test now asks for AA's own documented example
// record, so a valid key gets a real link back and the reply says how many fast downloads are left.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');

import { testAnnasArchiveKey, ANNAS_TEST_MD5 } from '@/lib/annas-test';

const reply = (status: number, data: unknown) => vi.mocked(axios.get).mockResolvedValueOnce({ status, data });

describe('testAnnasArchiveKey (#277)', () => {
    beforeEach(() => {
        vi.mocked(axios.get).mockReset();
    });

    it('asks for a record that exists: the example md5 from AA\'s own API docs, not 000…0', async () => {
        reply(200, { download_url: 'https://x/y.epub', account_fast_download_info: { downloads_left: 24, downloads_per_day: 25 } });
        await testAnnasArchiveKey('secret', 'https://annas-archive.gl/');

        expect(ANNAS_TEST_MD5).toBe('d6e1dc51a50726f00ec438af21952a45');
        const [url, opts] = vi.mocked(axios.get).mock.calls[0] as [string, any];
        expect(url).toBe('https://annas-archive.gl/dyn/api/fast_download.json');
        expect(opts.params).toEqual({ key: 'secret', md5: 'd6e1dc51a50726f00ec438af21952a45' });
    });

    it('uses the default mirror when no base URL is set', async () => {
        reply(200, { download_url: 'https://x/y.epub' });
        await testAnnasArchiveKey('secret');
        expect(vi.mocked(axios.get).mock.calls[0][0]).toBe('https://annas-archive.gl/dyn/api/fast_download.json');
    });

    it('a valid key reports the fast downloads left out of the daily allowance', async () => {
        reply(200, { download_url: 'https://x/y.epub', account_fast_download_info: { downloads_left: 24, downloads_per_day: 25 } });
        const r = await testAnnasArchiveKey('secret');
        expect(r.success).toBe(true);
        expect(r.downloadsLeft).toBe(24);
        expect(r.message).toMatch(/24 of 25 fast downloads left/);
    });

    it('a valid key without the daily allowance still reports what is left', async () => {
        reply(200, { download_url: 'https://x/y.epub', account_fast_download_info: { downloads_left: 3 } });
        const r = await testAnnasArchiveKey('secret');
        expect(r.success).toBe(true);
        expect(r.downloadsLeft).toBe(3);
        expect(r.message).toMatch(/3 fast downloads left/);
        expect(r.message).not.toMatch(/of undefined/);
    });

    it('a link without the account info still passes, without a count', async () => {
        reply(200, { download_url: 'https://x/y.epub' });
        const r = await testAnnasArchiveKey('secret');
        expect(r.success).toBe(true);
        expect(r.downloadsLeft).toBeUndefined();
        expect(r.message).not.toMatch(/undefined/);
    });

    it('a valid key with no downloads left today still passes, so automation can be turned on', async () => {
        reply(429, { download_url: null, error: 'No downloads left' });
        const r = await testAnnasArchiveKey('secret');
        expect(r.success).toBe(true);
        expect(r.downloadsLeft).toBe(0);
        expect(r.message).toMatch(/no fast downloads left/i);
    });

    it('"Record not found" means the key got past AA\'s key check: it passes, without a count', async () => {
        reply(404, { download_url: null, error: 'Record not found' });
        const r = await testAnnasArchiveKey('secret');
        expect(r.success).toBe(true);
        expect(r.downloadsLeft).toBeUndefined();
        expect(r.message).toMatch(/accepted/i);
    });

    it('a wrong key fails with AA\'s reason', async () => {
        reply(401, { download_url: null, error: 'Invalid secret key' });
        const r = await testAnnasArchiveKey('wrong');
        expect(r.success).toBe(false);
        expect(r.message).toMatch(/Invalid secret key/);
    });

    it('a key whose account has no membership fails and says so', async () => {
        reply(403, { download_url: null, error: 'Not a member' });
        const r = await testAnnasArchiveKey('lapsed');
        expect(r.success).toBe(false);
        expect(r.message).toMatch(/Not a member/);
        expect(r.message).toMatch(/membership/i);
    });

    it('any other AA error fails and passes AA\'s text along', async () => {
        reply(400, { download_url: null, error: 'Invalid md5' });
        const r = await testAnnasArchiveKey('secret');
        expect(r.success).toBe(false);
        expect(r.message).toMatch(/Invalid md5/);
    });

    it('a Cloudflare page instead of the API fails', async () => {
        reply(403, '<!DOCTYPE html><html><body>Just a moment...</body></html>');
        const r = await testAnnasArchiveKey('secret');
        expect(r.success).toBe(false);
        expect(r.message).toMatch(/Cloudflare/);
    });

    it('a network failure fails with the reason', async () => {
        vi.mocked(axios.get).mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND annas-archive.gl'));
        const r = await testAnnasArchiveKey('secret');
        expect(r.success).toBe(false);
        expect(r.message).toMatch(/ENOTFOUND/);
    });

    it('no key: fails without calling AA', async () => {
        const r = await testAnnasArchiveKey('');
        expect(r.success).toBe(false);
        expect(axios.get).not.toHaveBeenCalled();
    });
});
