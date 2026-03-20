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

        // 3. Gather User Stats
        // READ_COUNT: Number of fully completed issues
        const readCount = await prisma.readProgress.count({
            where: { userId, isCompleted: true }
        });

        // REQUEST_COUNT: Total requests made by the user
        const requestCount = await prisma.request.count({
            where: { userId }
        });

        // PUBLISHER_COUNT: Unique publishers from their completed reads
        const completedReads = await prisma.readProgress.findMany({
            where: { userId, isCompleted: true },
            include: { issue: { include: { series: true } } }
        });
        
        const publishers = new Set(
            completedReads
                .map(r => r.issue?.series?.publisher)
                .filter(Boolean)
        );
        const publisherCount = publishers.size;

        // 4. Evaluate Unearned Trophies against the gathered stats
        const newlyEarned = [];
        for (const trophy of unearnedTrophies) {
            let achieved = false;
            switch (trophy.actionType) {
                case 'READ_COUNT':
                    achieved = readCount >= trophy.targetValue;
                    break;
                case 'REQUEST_COUNT':
                    achieved = requestCount >= trophy.targetValue;
                    break;
                case 'PUBLISHER_COUNT':
                    achieved = publisherCount >= trophy.targetValue;
                    break;
            }

            if (achieved) newlyEarned.push(trophy);
        }

        // 5. Award Trophies & Send In-App Notifications!
        for (const trophy of newlyEarned) {
            // Add to UserTrophy link table
            await prisma.userTrophy.create({
                data: {
                    userId,
                    trophyId: trophy.id
                }
            });

            // Trigger the Notification Bell alert on the frontend
            await (prisma as any).notification.create({
                data: {
                    userId,
                    type: 'trophy',
                    title: trophy.name,
                    description: `You unlocked a new achievement: ${trophy.name}!`,
                    imageUrl: trophy.iconUrl,
                    referenceId: trophy.id
                }
            });
        }

    } catch (error) {
        Logger.log(`Trophy Evaluation Error: ${getErrorMessage(error)}`, 'error');

    }
}