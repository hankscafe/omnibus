// __tests__/lib/utils/db-search.test.ts
// Provider-aware case-insensitive contains (beta.014): Postgres gets mode:'insensitive' (ILIKE),
// SQLite must NOT get the mode argument (its generated Prisma client rejects it at runtime — the
// bug that 500'd every issues-browse search on the default deployment).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ciContains } from '@/lib/utils/db-search';

describe('ciContains', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('omits mode entirely for SQLite file: URLs', () => {
        const clause = ciContains('batman', 'file:./omnibus.db');
        expect(clause).toEqual({ contains: 'batman' });
        expect('mode' in clause).toBe(false);
    });

    it('adds mode insensitive for postgres:// and postgresql:// URLs', () => {
        expect(ciContains('batman', 'postgres://u:p@host:5432/omnibus'))
            .toEqual({ contains: 'batman', mode: 'insensitive' });
        expect(ciContains('batman', 'postgresql://u:p@host:5432/omnibus'))
            .toEqual({ contains: 'batman', mode: 'insensitive' });
    });

    it('defaults to the SQLite shape when DATABASE_URL is unset or unrecognized', () => {
        vi.stubEnv('DATABASE_URL', '');
        expect('mode' in ciContains('x')).toBe(false);
        vi.stubEnv('DATABASE_URL', 'mysql://nope');
        expect('mode' in ciContains('x')).toBe(false);
    });

    it('reads the env at call time (runtime provider switch, not import time)', () => {
        vi.stubEnv('DATABASE_URL', 'file:./dev.db');
        expect('mode' in ciContains('x')).toBe(false);
        vi.stubEnv('DATABASE_URL', 'postgresql://u:p@h/db');
        expect(ciContains('x').mode).toBe('insensitive');
    });
});
