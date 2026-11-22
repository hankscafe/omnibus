// src/lib/annas-test.ts
//
// Shared Anna's Archive API-key validation, used by both the admin "Test API Key" button
// (/api/admin/test) and the save-time automation gate (/api/admin/config). Anna's Archive exposes no
// quota-free key-check endpoint: its one member API, fast_download.json, hands out a fast-download
// link for a record. So the test asks for a link for a record that exists, and the reply says whether
// the key works and how many fast downloads are left today. That request counts as one of the
// account's fast downloads (AA counts the last 18 hours), which the settings page says next to the
// button.
//
// AA checks a request in this order: the md5's format (400 "Invalid md5"), the key (401 "Invalid
// secret key"), then the record (404 "Record not found"), then the day's allowance (429 "No downloads
// left"). The first two were checked against annas-archive.gl with a fake key on 2026-11-22. The
// membership check (403 "Not a member") comes between the key and the record as we remember AA's
// open-source code; that can't be checked without a member key. Issue #277: the old probe asked for
// md5 000…0, so a VALID key always got as far as "Record not found" and failed, and because this same
// test gates turning AA automation on, nobody could turn it on.
import axios from 'axios';
import { errorMessageOr } from '@/lib/utils/error';

// The example md5 in AA's own API documentation (the JSON reply documents itself): "Against
// Intellectual Monopoly" (Boldrin & Levine, 2008), a book its authors released free.
export const ANNAS_TEST_MD5 = 'd6e1dc51a50726f00ec438af21952a45';

export interface AnnasTestResult {
    success: boolean;
    message: string;
    downloadsLeft?: number;
}

export async function testAnnasArchiveKey(key: string | null | undefined, baseUrl?: string): Promise<AnnasTestResult> {
    if (!key) {
        return { success: false, message: "No Anna's Archive API key configured. Add one under Hoster Accounts — interactive search still works without it." };
    }
    const base = (baseUrl?.trim() || 'https://annas-archive.gl').replace(/\/$/, '');
    try {
        const res = await axios.get(`${base}/dyn/api/fast_download.json`, {
            headers: { 'User-Agent': 'Omnibus/1.0' },
            params: { key, md5: ANNAS_TEST_MD5 },
            timeout: 10000,
            validateStatus: () => true,
        });
        if (typeof res.data === 'string' && res.data.includes('<!DOCTYPE html>')) {
            return { success: false, message: "Connection Blocked: Cloudflare challenge detected." };
        }
        const data = res.data && typeof res.data === 'object' ? res.data : {};
        const error: string = typeof data.error === 'string' ? data.error : '';
        const left = data.account_fast_download_info?.downloads_left;
        const perDay = data.account_fast_download_info?.downloads_per_day;

        if (data.download_url || typeof left === 'number') {
            if (typeof left !== 'number') return { success: true, message: "Anna's Archive API key valid." };
            return {
                success: true,
                downloadsLeft: left,
                message: typeof perDay === 'number'
                    ? `Anna's Archive API key valid: ${left} of ${perDay} fast downloads left today.`
                    : `Anna's Archive API key valid: ${left} fast downloads left today.`,
            };
        }
        // The key and the membership passed; only today's allowance is used up. Automation can still be
        // turned on - downloads resume as the day's downloads age out.
        if (res.status === 429 || /no downloads left/i.test(error)) {
            return {
                success: true,
                downloadsLeft: 0,
                message: "Anna's Archive API key valid, but there are no fast downloads left today. Automatic downloads resume as older downloads age out (Anna's Archive counts the last 18 hours).",
            };
        }
        // The key got past AA's key check; only the test record is missing (AA removed it).
        if (res.status === 404 || /record not found/i.test(error)) {
            return {
                success: true,
                message: "Anna's Archive accepted the API key. (Its test record wasn't found, so the downloads left today can't be shown.)",
            };
        }
        if (res.status === 403 || /not a member/i.test(error)) {
            return {
                success: false,
                message: `Anna's Archive: ${error || 'Not a member'}. The key's account has no active membership, which fast downloads need.`,
            };
        }
        return {
            success: false,
            message: error
                ? `Anna's Archive: ${error}`
                : "API key rejected or no response. Check the key and your membership status.",
        };
    } catch (e) {
        return { success: false, message: `Anna's Archive: ${errorMessageOr(e, 'connection failed')}` };
    }
}
