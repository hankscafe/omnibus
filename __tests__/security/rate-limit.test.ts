import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkRateLimit } from '../../src/lib/rate-limit';

describe('Security: Brute Force Rate Limiter', () => {
    beforeEach(() => {
        // Allows us to manipulate time in tests if needed
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should allow requests under the limit', () => {
        // We use a unique IP for each test to prevent cross-test contamination in the memory map
        const ip = '192.168.1.1';
        const result = checkRateLimit(ip, 3, 60000);
        
        expect(result.isLimited).toBe(false);
        result.trackFailure(); // Simulate 1 failed login
    });

    it('should lock out the user after hitting the failure limit', () => {
        const ip = '10.0.0.5';
        
        // Simulate 3 failures
        for (let i = 0; i < 3; i++) {
            checkRateLimit(ip, 3, 60000).trackFailure();
        }

        // The 4th attempt should be blocked
        const blockedResult = checkRateLimit(ip, 3, 60000);
        
        expect(blockedResult.isLimited).toBe(true);
        expect(blockedResult.message).toContain('Too many attempts');
        expect(blockedResult.response?.status).toBe(429); // HTTP 429 Too Many Requests
    });

    it('should clear the lockout immediately if trackSuccess is called', () => {
        const ip = '172.16.0.1';
        
        // Simulate a failure
        checkRateLimit(ip, 3, 60000).trackFailure();
        
        // Simulate a successful login on the next try
        checkRateLimit(ip, 3, 60000).trackSuccess(); 

        // The tracker should be reset
        const newAttempt = checkRateLimit(ip, 3, 60000);
        expect(newAttempt.isLimited).toBe(false);
    });
});