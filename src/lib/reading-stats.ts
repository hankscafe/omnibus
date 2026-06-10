// src/lib/reading-stats.ts
import { prisma } from '@/lib/db';

// Records pages read today for the activity heatmap: the daily total plus which issue they came from
export async function recordDailyReading(userId: string, issueId: string, pagesReadDelta: number): Promise<void> {
    if (pagesReadDelta <= 0) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await prisma.dailyReadingStat.upsert({
        where: { userId_date: { userId, date: today } },
        update: { pagesRead: { increment: pagesReadDelta } },
        create: { userId, date: today, pagesRead: pagesReadDelta }
    });

    await prisma.dailyIssueRead.upsert({
        where: { userId_issueId_date: { userId, issueId, date: today } },
        update: { pagesRead: { increment: pagesReadDelta } },
        create: { userId, issueId, date: today, pagesRead: pagesReadDelta }
    });
}
