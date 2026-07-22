// __tests__/components/upload-failure-message.test.ts
// Actionable upload failure copy (beta.015): a proxy 413 has no Omnibus JSON body, so the client
// must explain the real cause (Cloudflare edge cap / nginx client_max_body_size) instead of a
// bare status code; an Omnibus-supplied error message always wins.
import { describe, it, expect } from 'vitest';
import { uploadFailureMessage } from '@/components/manual-upload-dialog';

describe('uploadFailureMessage', () => {
    it('prefers the server-supplied error over any status mapping', () => {
        expect(uploadFailureMessage(413, 'File exceeds the 2048MB upload limit.'))
            .toBe('File exceeds the 2048MB upload limit.');
    });

    it('explains a bare 413 as a proxy cap with the two usual culprits', () => {
        const msg = uploadFailureMessage(413);
        expect(msg).toContain('proxy');
        expect(msg).toContain('Cloudflare');
        expect(msg).toContain('client_max_body_size');
    });

    it('maps 409 to a retry-the-file hint and 0 to a network error', () => {
        expect(uploadFailureMessage(409)).toContain('retry the file');
        expect(uploadFailureMessage(0)).toContain('Network error');
    });

    it('falls back to the bare status for anything else', () => {
        expect(uploadFailureMessage(502)).toBe('Upload failed (HTTP 502).');
    });
});
