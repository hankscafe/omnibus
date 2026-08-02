// __tests__/lib/library-access.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  seriesAccessWhere,
  nestedSeriesAccessWhere,
  canAccessLibraryId,
  canAccessPath,
  getAccessibleLibraryIds,
} from '@/lib/library-access';

const mocks = vi.hoisted(() => ({ ulaFindMany: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { userLibraryAccess: { findMany: mocks.ulaFindMany } } }));

describe('library-access', () => {
  describe('seriesAccessWhere / nestedSeriesAccessWhere', () => {
    it('returns an empty filter for ADMIN (ALL) — no restriction', () => {
      expect(seriesAccessWhere('ALL')).toEqual({});
      expect(nestedSeriesAccessWhere('ALL')).toEqual({});
    });
    it('builds a libraryId filter for a scoped list', () => {
      expect(seriesAccessWhere(['a', 'b'])).toEqual({ libraryId: { in: ['a', 'b'] } });
      expect(nestedSeriesAccessWhere(['a'])).toEqual({ series: { libraryId: { in: ['a'] } } });
    });
  });

  describe('canAccessLibraryId', () => {
    it('admin (ALL) can access anything, including a null library', () => {
      expect(canAccessLibraryId('ALL', 'lib1')).toBe(true);
      expect(canAccessLibraryId('ALL', null)).toBe(true);
    });
    it('scoped users can access only granted ids; null/unknown denied', () => {
      expect(canAccessLibraryId(['lib1'], 'lib1')).toBe(true);
      expect(canAccessLibraryId(['lib1'], 'lib2')).toBe(false);
      expect(canAccessLibraryId(['lib1'], null)).toBe(false);
      expect(canAccessLibraryId([], 'lib1')).toBe(false);
    });
  });

  describe('canAccessPath', () => {
    it('admin (ALL) can access any path', () => {
      expect(canAccessPath('ALL', '/data/manga/x.cbz')).toBe(true);
    });
    it('matches files under an accessible root, and rejects others + sibling-prefixes', () => {
      const roots = ['/data/comics'];
      expect(canAccessPath(roots, '/data/comics/batman/01.cbz')).toBe(true);
      expect(canAccessPath(roots, '/data/manga/x.cbz')).toBe(false);
      expect(canAccessPath(roots, '/data/comics-secret/x.cbz')).toBe(false); // sibling prefix must not pass
    });
    it('is case- and separator-insensitive (handles Windows paths)', () => {
      expect(canAccessPath(['/data/comics'], '\\DATA\\Comics\\X.cbz')).toBe(true);
    });
    it('denies a missing path', () => {
      expect(canAccessPath(['/data/comics'], null)).toBe(false);
    });
  });

  describe('getAccessibleLibraryIds', () => {
    it('returns ALL for admins without touching the database', async () => {
      const res = await getAccessibleLibraryIds('u1', 'ADMIN');
      expect(res).toBe('ALL');
      expect(mocks.ulaFindMany).not.toHaveBeenCalled();
    });
    it('returns an empty grant for an anonymous user', async () => {
      expect(await getAccessibleLibraryIds(null, 'USER')).toEqual([]);
    });
    it('returns the granted library ids for a scoped user', async () => {
      mocks.ulaFindMany.mockResolvedValue([{ libraryId: 'a' }, { libraryId: 'b' }]);
      expect(await getAccessibleLibraryIds('u1', 'USER')).toEqual(['a', 'b']);
    });
  });
});
