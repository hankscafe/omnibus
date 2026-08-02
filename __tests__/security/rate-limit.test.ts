// __tests__/security/rate-limit.test.ts
import { describe, it, expect, vi } from 'vitest';
import { checkRateLimit } from '@/lib/rate-limit';
import { loggerLog } from '../helpers/setup-global';

// 1. Mock Logger
const mocks = vi.hoisted(() => ({ log: vi.fn() }));

describe('Security: Rate Limiter', () => {
    it('should completely block the 6th request, return a 429 response, and trace the debug log', () => {
        const ip = '192.168.1.50';
        const limit = 5;
        const windowMs = 15 * 60 * 1000;

        // Simulate 5 rapid failures
        for (let i = 0; i < limit; i++) {
            const attempt = checkRateLimit(ip, limit, windowMs);
            expect(attempt.isLimited).toBe(false);
            attempt.trackFailure(); 
        }

        // The 6th attempt should be blocked
        const blockedAttempt = checkRateLimit(ip, limit, windowMs);
        
        expect(blockedAttempt.isLimited).toBe(true);
        expect(blockedAttempt.message).toContain('Too many attempts');
        expect(blockedAttempt.response?.status).toBe(429);

        // Assert our new debug log was triggered for the lockout
        expect(loggerLog).toHaveBeenCalledWith(
            expect.stringContaining(`[Rate Limit Debug] Blocked request for identifier: ${ip}`),
            'debug'
        );
    });
});