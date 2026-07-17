// Issue #183: Prisma's default multi-connection SQLite pool maximized write-lock contention with
// the engine during library scans. tunedSqliteUrl serializes Node onto one connection — but ONLY
// for SQLite, and never over an operator's explicit choice.
import { describe, it, expect } from 'vitest';
import { tunedSqliteUrl } from '@/lib/sqlite-url';

describe('tunedSqliteUrl', () => {
    it('appends connection_limit=1 to a bare SQLite URL (the default deploy shape)', () => {
        expect(tunedSqliteUrl('file:/config/omnibus.db')).toBe('file:/config/omnibus.db?connection_limit=1');
    });

    it('appends with & when the URL already carries params', () => {
        expect(tunedSqliteUrl('file:./dev.db?mode=rwc')).toBe('file:./dev.db?mode=rwc&connection_limit=1');
    });

    it('never overrides an explicit connection_limit (operator opt-out)', () => {
        expect(tunedSqliteUrl('file:/config/omnibus.db?connection_limit=5'))
            .toBe('file:/config/omnibus.db?connection_limit=5');
    });

    it('leaves Postgres URLs untouched — pooling there is correct and wanted', () => {
        expect(tunedSqliteUrl('postgresql://omnibus:pw@db:5432/omnibus?schema=public')).toBeUndefined();
    });

    it('returns undefined when DATABASE_URL is unset/empty (Prisma falls back to its own env handling)', () => {
        expect(tunedSqliteUrl('')).toBeUndefined();
        expect(tunedSqliteUrl('   ')).toBeUndefined();
    });
});
