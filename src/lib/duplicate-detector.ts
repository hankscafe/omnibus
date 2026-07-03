// src/lib/duplicate-detector.ts
//
// Library-wide duplicate-file detection: issues that share the same (series, issue number) and each
// have a real file on disk. Shared by the diagnostics "scan-duplicates" action and the dashboard
// health check so the two can never drift. Cheap — one DB query + an existsSync only on candidate
// groups (numbers that have more than one record), not every file in the library.
import { prisma } from '@/lib/db';
import fs from 'fs-extra';
import path from 'path';

export interface DuplicateFile {
    id: string;
    path: string;
    name: string;
    size: number;
}

export interface DuplicateGroup {
    seriesId: string;
    seriesName: string;
    issueNumber: string;
    files: DuplicateFile[];
}

export async function findDuplicateGroups(): Promise<DuplicateGroup[]> {
    // Let the DB find the (series, number) pairs that actually have more than one file-bearing record
    // instead of hydrating every downloaded issue (+ its full Series row) into Node. This health check
    // runs every 15 min, so on a 100k-issue library the old full scan moved hundreds of MB each time.
    const candidates = await prisma.issue.groupBy({
        by: ['seriesId', 'number'],
        where: { filePath: { not: null } },
        _count: { seriesId: true },
        having: { seriesId: { _count: { gt: 1 } } },
    });
    if (candidates.length === 0) return [];

    // Fetch only the issues in the candidate series, selecting just the fields we use. Numbers that
    // aren't actually duplicated fall out via the `group.length < 2` check below.
    const seriesIds = [...new Set(candidates.map(c => c.seriesId))];
    const issues = await prisma.issue.findMany({
        where: { filePath: { not: null }, seriesId: { in: seriesIds } },
        select: {
            id: true, number: true, seriesId: true, filePath: true,
            series: { select: { name: true } },
        },
    });

    // Group by (series, issue number) in memory first — cheap, no filesystem access.
    const groups = new Map<string, any[]>();
    for (const issue of issues) {
        if (!issue.filePath) continue;
        const key = `${issue.seriesId}_${issue.number}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(issue);
    }

    const duplicates: DuplicateGroup[] = [];
    for (const group of groups.values()) {
        if (group.length < 2) continue; // only verify candidates that actually have multiple records

        // A record can point at a file deleted outside Omnibus — only count those still on disk.
        const present = group.filter((i: any) => {
            try { return fs.existsSync(i.filePath); } catch { return false; }
        });
        if (present.length < 2) continue;

        duplicates.push({
            seriesId: present[0].seriesId,
            seriesName: present[0].series?.name || 'Unknown Series',
            issueNumber: present[0].number,
            files: present.map((i: any) => {
                let size = 0;
                try { size = fs.statSync(i.filePath).size; } catch { /* vanished mid-scan */ }
                return { id: i.id, path: i.filePath, name: path.basename(i.filePath), size };
            }),
        });
    }

    return duplicates;
}
