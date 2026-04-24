import { describe, it, expect } from 'vitest';
import { checkRateLimit } from '@/lib/rate-limit';

describe('Security: Rate Limiter', () => {

    it('should allow requests underneath the limit', () => {
        // Use a unique ID so tests don't collide in the in-memory map
        const ip = '192.168.1.1'; 
        
        const result1 = checkRateLimit(ip, 5, 1000);
        result1.trackFailure();
        expect(result1.isLimited).toBe(false);

        const result2 = checkRateLimit(ip, 5, 1000);
        expect(result2.isLimited).toBe(false);
    });

    it('should completely block the 6th request and return a 429 response', () => {
        const ip = '192.168.1.50';
        const limit = 5;
        const windowMs = 15 * 60 * 1000; // 15 minutes

        // Simulate 5 rapid failures
        for (let i = 0; i < limit; i++) {
            const attempt = checkRateLimit(ip, limit, windowMs);
            expect(attempt.isLimited).toBe(false);
            attempt.trackFailure(); // Register the failed attempt
        }

        // The 6th attempt should be blocked
        const blockedAttempt = checkRateLimit(ip, limit, windowMs);
        
        expect(blockedAttempt.isLimited).toBe(true);
        expect(blockedAttempt.message).toContain('Too many attempts');
        
        // Assert the generated NextResponse is exactly what we expect
        expect(blockedAttempt.response).not.toBeNull();
        expect(blockedAttempt.response?.status).toBe(429);
    });

    it('should instantly clear the tracker on a successful attempt', () => {
        const ip = '10.0.0.5';
        
        // 1 failed attempt
        const failAttempt = checkRateLimit(ip, 5, 1000);
        failAttempt.trackFailure();
        
        // 1 successful attempt
        const successAttempt = checkRateLimit(ip, 5, 1000);
        successAttempt.trackSuccess(); // This resets the counter to 0
        
        // The next attempt should act like a fresh start
        const nextAttempt = checkRateLimit(ip, 5, 1000);
        expect(nextAttempt.isLimited).toBe(false);
    });
});