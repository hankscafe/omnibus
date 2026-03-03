import { prisma } from './db';

export async function checkTrophies(userId: string, triggerAction: 'READ' | 'REQUEST') {
  try {
    const userTrophies = await prisma.userTrophy.findMany({ where: { userId }, select: { trophyId: true } });
    const earnedIds = new Set(userTrophies.map(ut => ut.trophyId));

    const unearnedTrophies = await prisma.trophy.findMany({
        where: { id: { notIn: Array.from(earnedIds) } }
    });

    if (unearnedTrophies.length === 0) return;

    let readCount = -1;
    let requestCount = -1;
    let pubCount = -1;

    for (const trophy of unearnedTrophies) {
        let achieved = false;

        if (trophy.actionType === 'READ_COUNT' && triggerAction === 'READ') {
            if (readCount === -1) readCount = await prisma.readProgress.count({ where: { userId, isCompleted: true } });
            if (readCount >= trophy.targetValue) achieved = true;
        }

        if (trophy.actionType === 'PUBLISHER_COUNT' && triggerAction === 'READ') {
            if (pubCount === -1) {
                const readIssues = await prisma.readProgress.findMany({
                    where: { userId, isCompleted: true },
                    include: { issue: { include: { series: true } } }
                });
                const pubs = new Set(readIssues.map(p => p.issue.series.publisher).filter(Boolean));
                pubCount = pubs.size;
            }
            if (pubCount >= trophy.targetValue) achieved = true;
        }

        if (trophy.actionType === 'REQUEST_COUNT' && triggerAction === 'REQUEST') {
            if (requestCount === -1) requestCount = await prisma.request.count({ where: { userId } });
            if (requestCount >= trophy.targetValue) achieved = true;
        }

        if (achieved) {
            await prisma.userTrophy.create({
                data: { userId, trophyId: trophy.id, notified: false }
            });
        }
    }
  } catch (error) {
    console.error("Trophy Check Error:", error);
  }
}