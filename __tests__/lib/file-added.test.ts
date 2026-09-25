// __tests__/lib/file-added.test.ts
//
// Issue.fileAddedAt — when a row's current file ARRIVED (#206 follow-up). Issue.createdAt is row
// birth: a download that fills a WANTED placeholder keeps the skeleton's old createdAt, so the
// Recently Added shelf, the Updates feed, the bell, the weekly digest and Paperback's "Recently
// updated series" all missed the most common arrival there is. Three rules, one place:
//   arrival — a download lands on a row: stamped now, unless the row already had a file (a
//             replacement or upgrade is not a new issue — re-announcing it would be noise);
//   rescan  — a scan finds a file for a row: an existing stamp stands (an external rename is not
//             an arrival); a row without one takes now if it had no file, else its birth;
//   carry   — a file re-homed from another row (Smart Matcher, link) keeps THAT row's time: it was
//             announced when it first appeared, and matching it later must not announce it again.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { arrivalStamp, rescanStamp, carriedStamp, backfillFileAddedAt } from '@/lib/file-added';
import { prisma } from '@/lib/db';

vi.mock('@/lib/db', () => ({ prisma: { $executeRawUnsafe: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));

const NOW = new Date('2026-09-25T12:00:00.000Z');
const OLD = new Date('2026-06-01T08:00:00.000Z');
const BORN = new Date('2026-05-01T08:00:00.000Z');

describe('arrivalStamp — a download landing on a row', () => {
    it('stamps a brand-new row', () => {
        expect(arrivalStamp(null, NOW)).toEqual({ fileAddedAt: NOW });
    });

    it('stamps a placeholder that had no file — the monitored-download case createdAt missed', () => {
        expect(arrivalStamp({ filePath: null, fileAddedAt: null }, NOW)).toEqual({ fileAddedAt: NOW });
        expect(arrivalStamp({ filePath: '', fileAddedAt: null }, NOW)).toEqual({ fileAddedAt: NOW });
    });

    it('restamps a row whose earlier file was deleted — a re-download is a real arrival', () => {
        expect(arrivalStamp({ filePath: null, fileAddedAt: OLD }, NOW)).toEqual({ fileAddedAt: NOW });
    });

    it('leaves a row that already had a file alone — a replacement is not a new issue', () => {
        expect(arrivalStamp({ filePath: '/comics/Batman/Batman #001.cbz', fileAddedAt: OLD }, NOW)).toEqual({});
        expect(arrivalStamp({ filePath: '/comics/Batman/Batman #001.cbz', fileAddedAt: null }, NOW)).toEqual({});
    });
});

describe('rescanStamp — a scan pointing a row at a file', () => {
    it('keeps an existing stamp — a file renamed outside Omnibus did not arrive again', () => {
        expect(rescanStamp({ filePath: null, fileAddedAt: OLD, createdAt: BORN }, NOW)).toEqual({});
        expect(rescanStamp({ filePath: '/old/name.cbz', fileAddedAt: OLD, createdAt: BORN }, NOW)).toEqual({});
    });

    it('stamps now when the row had neither a file nor a stamp', () => {
        expect(rescanStamp({ filePath: null, fileAddedAt: null, createdAt: BORN }, NOW)).toEqual({ fileAddedAt: NOW });
    });

    it('falls back to the row\'s birth for a file-backed row that predates the column', () => {
        expect(rescanStamp({ filePath: '/old/name.cbz', fileAddedAt: null, createdAt: BORN }, NOW)).toEqual({ fileAddedAt: BORN });
    });
});

describe('carriedStamp — a file re-homed from another row', () => {
    it('keeps the source row\'s arrival time', () => {
        expect(carriedStamp({ fileAddedAt: OLD, createdAt: BORN }, NOW)).toEqual(OLD);
    });

    it('falls back to the source row\'s birth when it predates the column', () => {
        expect(carriedStamp({ fileAddedAt: null, createdAt: BORN }, NOW)).toEqual(BORN);
    });

    it('is now when the file never had a row — its first appearance in the library', () => {
        expect(carriedStamp(null, NOW)).toEqual(NOW);
    });
});

describe('backfillFileAddedAt — the startup backfill', () => {
    beforeEach(() => vi.clearAllMocks());

    it('gives every file-backed row without a stamp its createdAt, so nothing jumps the queue', async () => {
        (prisma.$executeRawUnsafe as any).mockResolvedValue(42);

        const n = await backfillFileAddedAt();

        expect(n).toBe(42);
        const sql = (prisma.$executeRawUnsafe as any).mock.calls[0][0] as string;
        expect(sql.replace(/\s+/g, ' ').trim()).toBe(
            `UPDATE "Issue" SET "fileAddedAt" = "createdAt" WHERE "fileAddedAt" IS NULL AND "filePath" IS NOT NULL AND "filePath" <> ''`
        );
    });

    it('never throws into startup — a failure is logged and reads as zero', async () => {
        (prisma.$executeRawUnsafe as any).mockRejectedValue(new Error('locked'));
        await expect(backfillFileAddedAt()).resolves.toBe(0);
    });
});
