// __tests__/security/rate-limit.test.ts
import { describe, it, expect, vi } from 'vitest';
import { checkRateLimit, getClientIp, checkGlobalRateLimit } from '@/lib/rate-limit';

// 1. Mock Logger
const mocks = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

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
        expect(mocks.log).toHaveBeenCalledWith(
            expect.stringContaining(`[Rate Limit Debug] Blocked request for identifier: ${ip}`),
            'debug'
        );
    });
});

describe('Security: getClientIp', () => {
    const reqWith = (headers: Record<string, string>) => new Request('http://localhost/x', { headers });

    it('takes only the first (client-origin) hop of X-Forwarded-For, not the raw list', () => {
        expect(getClientIp(reqWith({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' }))).toBe('203.0.113.7');
    });

    it('falls back to x-real-ip, then "unknown"', () => {
        expect(getClientIp(reqWith({ 'x-real-ip': '198.51.100.9' }))).toBe('198.51.100.9');
        expect(getClientIp(reqWith({}))).toBe('unknown');
    });
});

describe('Security: checkGlobalRateLimit (IP-independent backstop)', () => {
    it('blocks once an action exceeds the global cap within the window', () => {
        const action = 'unit_test_action_a';
        // limit 3: calls 1-3 pass, the 4th is blocked — regardless of source IP.
        for (let i = 0; i < 3; i++) expect(checkGlobalRateLimit(action, 3, 60_000).isLimited).toBe(false);
        const blocked = checkGlobalRateLimit(action, 3, 60_000);
        expect(blocked.isLimited).toBe(true);
        expect(blocked.response?.status).toBe(429);
    });

    it('keeps separate counters per action', () => {
        expect(checkGlobalRateLimit('unit_test_action_b', 1, 60_000).isLimited).toBe(false); // count 1
        expect(checkGlobalRateLimit('unit_test_action_b', 1, 60_000).isLimited).toBe(true);  // count 2 > 1
        expect(checkGlobalRateLimit('unit_test_action_c', 1, 60_000).isLimited).toBe(false); // independent
    });
});