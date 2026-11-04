// __tests__/helpers/opds-fixtures.ts
//
// One small library for the OPDS feed tests that compare the two flavours (#262): /api/opds (pinned
// in opds-pinned.test.ts) and the Komga-flavoured /komga/opds/v1.2 (komga-opds.test.ts). A run issue
// in progress, a finished one, an annual and a Special, in a series with a cover and one without.
import type { Mock } from 'vitest';

export const D1 = new Date('2026-09-01T10:00:00.000Z');
export const D2 = new Date('2026-09-20T18:30:00.000Z');

export const seriesRow = (over: Record<string, unknown> = {}) => ({
    id: 'ser_1', name: 'Tower Dungeon', year: 2024, publisher: 'Kodansha', description: 'A tower & its dungeon.',
    coverUrl: '/covers/ser_1.jpg', folderPath: '/data/library/Tower Dungeon', libraryId: 'lib_1',
    writers: '["Tsutomu Nihei"]', artists: null, updatedAt: D2,
    ...over,
});

export const issueRow = (over: Record<string, unknown> = {}) => ({
    id: 'iss_1', seriesId: 'ser_1', number: '1', name: 'The Tower', isAnnual: false, description: 'Chapter one.',
    filePath: '/data/library/Tower Dungeon/Tower Dungeon v01 (2025).cbz', pageCount: 156, coverUrl: null,
    writers: null, artists: null, releaseDate: '2025-01-07', updatedAt: D1,
    attachedVolumeId: null, attachedVolume: null,
    series: { id: 'ser_1', name: 'Tower Dungeon', publisher: 'Kodansha', writers: '["Tsutomu Nihei"]', artists: null },
    ...over,
});

export const ISSUES = [
    issueRow(),
    issueRow({ id: 'iss_2', number: '2', name: 'The Dragon', filePath: '/data/library/Tower Dungeon/Tower Dungeon v02 (2025).cbr', pageCount: 160, updatedAt: D2 }),
    issueRow({ id: 'iss_a1', number: '1', name: null, isAnnual: true, attachedVolumeId: 'att_1', attachedVolume: { kind: 'ANNUAL', name: 'Tower Dungeon Annual' }, filePath: '/data/library/Tower Dungeon/Tower Dungeon Annual 001 (2025).cbz', pageCount: 40 }),
    issueRow({ id: 'iss_s1', number: '1', name: 'Side Story', attachedVolumeId: 'att_2', attachedVolume: { kind: 'SPECIAL', name: 'Tower Dungeon: Gaiden' }, filePath: '/data/library/Tower Dungeon/Tower Dungeon Gaiden 001 (2026).cbz', pageCount: 30 }),
];

export const PROGRESS = [
    { issueId: 'iss_1', currentPage: 48, isCompleted: false, updatedAt: D2 },
    { issueId: 'iss_2', currentPage: 160, isCompleted: true, updatedAt: D2 },
];

export interface OpdsPrismaMock {
    series: { findFirst: Mock; findMany: Mock; findUnique: Mock; groupBy: Mock };
    library: { count: Mock; findUnique: Mock; findMany: Mock };
    issue: { findMany: Mock; update: Mock };
    readProgress: { findMany: Mock };
}

/** Every query the feeds make, answered from the library above. */
export function stockOpdsPrisma(prisma: OpdsPrismaMock): void {
    prisma.series.findFirst.mockResolvedValue({ updatedAt: D2 });
    prisma.library.count.mockResolvedValue(2);
    prisma.series.findMany.mockResolvedValue([seriesRow(), seriesRow({ id: 'ser_2', name: 'Biomega', year: 2004, coverUrl: null, folderPath: null, updatedAt: D1 })]);
    prisma.library.findUnique.mockResolvedValue({ name: 'Manga' });
    prisma.series.findUnique.mockResolvedValue({ ...seriesRow(), issues: ISSUES.map((i) => ({ ...i })) });
    prisma.issue.update.mockResolvedValue({});
    prisma.readProgress.findMany.mockResolvedValue(PROGRESS);
    prisma.issue.findMany.mockResolvedValue(ISSUES.slice(0, 2));
    prisma.library.findMany.mockResolvedValue([{ id: 'lib_1', name: 'Manga' }, { id: 'lib_2', name: 'Comics' }]);
    prisma.series.groupBy.mockResolvedValue([{ libraryId: 'lib_1', _max: { updatedAt: D2 } }]);
}
