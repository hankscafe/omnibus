import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateTrophies } from '@/lib/trophy-evaluator';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findManyUserTrophies: vi.fn(),
    findManyTrophies: vi.fn(),
    countReadProgress: vi.fn(),
    countRequests: vi.fn(),
    findManyReads: vi.fn(),
    createUserTrophy: vi.fn(),
    createNotification: vi.fn(),
    log: vi.fn()
}));

// 2. Mock Prisma deeply
vi.mock('@/lib/db', () => ({
    prisma: {
        userTrophy: { findMany: mocks.findManyUserTrophies, create: mocks.createUserTrophy },
        trophy: { findMany: mocks.findManyTrophies },
        readProgress: { count: mocks.countReadProgress, findMany: mocks.findManyReads },
        request: { count: mocks.countRequests },
        notification: { create: mocks.createNotification }
    }
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

describe('Gamification: Trophy Evaluator', () => {
    beforeEach(() => { 
        vi.clearAllMocks(); 
    });

    it('should exit early and save database calls if the user has already unlocked all trophies', async () => {
        // User already has trophy 't1'
        mocks.findManyUserTrophies.mockResolvedValueOnce([{ trophyId: 't1' }]);
        // There is only one trophy available ('t1')
        mocks.findManyTrophies.mockResolvedValueOnce([{ id: 't1' }]); 
        
        await evaluateTrophies('user_1');
        
        // It shouldn't bother calculating read counts since there's nothing left to win
        expect(mocks.countReadProgress).not.toHaveBeenCalled();
        expect(mocks.createUserTrophy).not.toHaveBeenCalled();
    });

    it('should award a READ_COUNT trophy when the user hits the comic milestone', async () => {
        mocks.findManyUserTrophies.mockResolvedValueOnce([]); // No earned trophies yet
        mocks.findManyTrophies.mockResolvedValueOnce([
            { id: 't1', name: 'Bronze Reader', actionType: 'READ_COUNT', targetValue: 10 }
        ]);
        
        // Simulate the user having read exactly 10 comics
        mocks.countReadProgress.mockResolvedValueOnce(10); 
        mocks.countRequests.mockResolvedValueOnce(0);
        mocks.findManyReads.mockResolvedValueOnce([]);

        await evaluateTrophies('user_1');

        // Assert the database link was created
        expect(mocks.createUserTrophy).toHaveBeenCalledWith({
            data: { userId: 'user_1', trophyId: 't1' }
        });
        
        // Assert the notification bell was triggered
        expect(mocks.createNotification).toHaveBeenCalled();
    });

    it('should NOT award a PUBLISHER_COUNT trophy if they only read comics from the same publisher', async () => {
        mocks.findManyUserTrophies.mockResolvedValueOnce([]);
        mocks.findManyTrophies.mockResolvedValueOnce([
            { id: 't2', name: 'Explorer', actionType: 'PUBLISHER_COUNT', targetValue: 3 }
        ]);
        
        mocks.countReadProgress.mockResolvedValueOnce(5);
        mocks.countRequests.mockResolvedValueOnce(0);
        
        // Simulate: User read 3 comics, but all of them are from 'DC Comics' (only 1 unique publisher)
        mocks.findManyReads.mockResolvedValueOnce([
            { issue: { series: { publisher: 'DC Comics' } } },
            { issue: { series: { publisher: 'DC Comics' } } },
            { issue: { series: { publisher: 'DC Comics' } } }
        ]);

        await evaluateTrophies('user_1');

        // They need 3 unique publishers, they only have 1, so no trophy!
        expect(mocks.createUserTrophy).not.toHaveBeenCalled();
    });
});