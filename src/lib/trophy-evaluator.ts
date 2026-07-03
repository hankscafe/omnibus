import { prisma } from '@/lib/db';
import { Logger } from './logger';
import { getErrorMessage } from './utils/error';

export async function evaluateTrophies(userId: string) {
    try {
        // 1. Get the trophies the user has ALREADY earned
        const earnedTrophies = await prisma.userTrophy.findMany({ 
            where: { userId } 
        });
        const earnedIds = new Set(earnedTrophies.map(ut => ut.trophyId));

        // 2. Get all available trophies and filter out the ones they already have
        const allTrophies = await prisma.trophy.findMany();
        const unearnedTrophies = allTrophies.filter(t => !earnedIds.has(t.id));

        if (unearnedTrophies.length === 0) return; // User has unlocked everything!
        
        Logger.log(`[Trophy Debug] Evaluating ${unearnedTrophies.length} unearned trophies for user ${userId}...`, 'debug');

        // 3. Gather only the stats an unearned trophy actually needs, and run them in parallel. This
        // is fire-and-forget from every progress save, so skipping unneeded queries (and not hydrating
        // full issue+series rows just to count publishers) keeps it off the DB hot path.
        const needsRead = unearnedTrophies.some(t => t.actionType === 'READ_COUNT');
        const needsRequest = unearnedTrophies.some(t => t.actionType === 'REQUEST_COUNT');
        const needsPublisher = unearnedTrophies.some(t => t.actionType === 'PUBLISHER_COUNT');

        const [readCount, requestCount, publisherCount] = await Promise.all([
            // READ_COUNT: Number of fully completed issues
            needsRead ? prisma.readProgress.count({ where: { userId, isCompleted: true } }) : Promise.resolve(0),
            // REQUEST_COUNT: Total requests made by the user
            needsRequest ? prisma.request.count({ where: { userId } }) : Promise.resolve(0),
            // PUBLISHER_COUNT: Unique publishers from completed reads — select only the publisher, not
            // the whole issue + series row.
            needsPublisher ? (async () => {
                const rows = await prisma.readProgress.findMany({
                    where: { userId, isCompleted: true },
                    select: { issue: { select: { series: { select: { publisher: true } } } } },
                });
                return new Set(rows.map(r => r.issue?.series?.publisher).filter(Boolean)).size;
            })() : Promise.resolve(0),
        ]);

        Logger.log(`[Trophy Debug] User Stats - Read: ${readCount}, Requests: ${requestCount}, Publishers: ${publisherCount}`, 'debug');

        // 4. Evaluate Unearned Trophies against the gathered stats
        const newlyEarned = [];
        for (const trophy of unearnedTrophies) {
            let achieved = false;
            let currentValue = 0;
            
            switch (trophy.actionType) {
                case 'READ_COUNT':
                    achieved = readCount >= trophy.targetValue;
                    currentValue = readCount;
                    break;
                case 'REQUEST_COUNT':
                    achieved = requestCount >= trophy.targetValue;
                    currentValue = requestCount;
                    break;
                case 'PUBLISHER_COUNT':
                    achieved = publisherCount >= trophy.targetValue;
                    currentValue = publisherCount;
                    break;
            }
            
            if (!achieved) {
                Logger.log(`[Trophy Debug] Failed condition for '${trophy.name}'. (Target: ${trophy.targetValue} ${trophy.actionType} | Current: ${currentValue})`, 'debug');
            }

            if (achieved) newlyEarned.push(trophy);
        }

        // 5. Award Trophies. (There is no Notification model in the schema — the old
        // `prisma.notification.create` call here threw on every award, and because the whole function
        // is wrapped in one try/catch it aborted the loop, so a user earning several trophies at once
        // only ever recorded the first. Award them directly instead.)
        for (const trophy of newlyEarned) {
            Logger.log(`[Trophy] Awarding achievement '${trophy.name}' to user ${userId}!`, 'success');

            // Add to UserTrophy link table
            await prisma.userTrophy.create({
                data: {
                    userId,
                    trophyId: trophy.id
                }
            });
        }

    } catch (error) {
        Logger.log(`Trophy Evaluation Error: ${getErrorMessage(error)}`, 'error');

    }
}