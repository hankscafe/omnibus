// __tests__/lib/utils/cover-plan.test.ts
// Shared cover_source policy (issue #194 follow-up): the gate deciding whether provider art
// may overwrite the folder cover. Mirrors the engine's resolve_cover semantics.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findLocalCoverBasename, providerCoverBlocked, LOCAL_COVER_BASENAMES } from '@/lib/utils/cover-plan';
import fs from 'fs';
import path from 'path';

vi.mock('fs', () => ({ default: { existsSync: vi.fn() } }));

describe('cover-plan (shared cover_source policy)', () => {
    beforeEach(() => {
        vi.mocked(fs.existsSync).mockReset();
        vi.mocked(fs.existsSync).mockReturnValue(false);
    });

    it('finds the first existing candidate basename, folders probed in order', () => {
        vi.mocked(fs.existsSync).mockImplementation((p) => String(p) === path.join('/b', 'folder.jpg'));
        expect(findLocalCoverBasename('/a', '/b')).toBe('folder.jpg');
        expect(findLocalCoverBasename('/a')).toBeNull();
        // Null/empty folder entries are skipped, never probed.
        expect(findLocalCoverBasename(null, undefined, '  ')).toBeNull();
    });

    it('probes cover.webp — the downloader can write it, so the next pass must see it (engine parity)', () => {
        expect(LOCAL_COVER_BASENAMES).toContain('cover.webp');
    });

    it('blocks provider art for custom covers and for archive mode with a local cover — nothing else', () => {
        expect(providerCoverBlocked({ hasCustomCover: true, coverSource: 'metadata', localCoverExists: false })).toBe(true);
        expect(providerCoverBlocked({ hasCustomCover: false, coverSource: 'archive', localCoverExists: true })).toBe(true);
        // Archive mode with no local cover falls back to provider art (engine parity).
        expect(providerCoverBlocked({ hasCustomCover: false, coverSource: 'archive', localCoverExists: false })).toBe(false);
        expect(providerCoverBlocked({ hasCustomCover: false, coverSource: 'metadata', localCoverExists: true })).toBe(false);
        expect(providerCoverBlocked({ hasCustomCover: false, coverSource: 'metadata_only', localCoverExists: true })).toBe(false);
        expect(providerCoverBlocked({ hasCustomCover: false, coverSource: null, localCoverExists: true })).toBe(false);
    });
});
