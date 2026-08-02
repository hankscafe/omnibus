// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyText } from '@/lib/utils/clipboard';

describe('copyText (clipboard helper)', () => {
    afterEach(() => {
        delete (navigator as any).clipboard;
        vi.restoreAllMocks();
    });

    it('falls back to execCommand when the Clipboard API is unavailable (plain-HTTP LAN)', async () => {
        // jsdom has no navigator.clipboard by default — exactly the insecure-origin browser state
        // that made every copy button silently fail.
        document.execCommand = vi.fn().mockReturnValue(true);

        await expect(copyText('secret-api-key')).resolves.toBe(true);
        expect(document.execCommand).toHaveBeenCalledWith('copy');
    });

    it('reports failure instead of lying when no copy mechanism works', async () => {
        document.execCommand = vi.fn().mockImplementation(() => { throw new Error('denied'); });
        await expect(copyText('x')).resolves.toBe(false);
    });

    it('prefers the async Clipboard API in secure contexts', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
        document.execCommand = vi.fn();

        await expect(copyText('abc')).resolves.toBe(true);
        expect(writeText).toHaveBeenCalledWith('abc');
        expect(document.execCommand).not.toHaveBeenCalled();
    });
});
