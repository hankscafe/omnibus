import { describe, expect, it } from 'vitest';
import { replaceNamingToken, sanitizeNamingPart } from '@/lib/utils/naming';

describe('naming token helpers', () => {
    it('replaces every case variant literally', () => {
        expect(replaceNamingToken('{Imprint}/{imprint}/{IMPRINT}', '{Imprint}', '$& label')).toBe('$& label/$& label/$& label');
    });

    it('sanitizes one component and neutralizes dot-only traversal', () => {
        expect(sanitizeNamingPart(' Absolute/ Batman ')).toBe('Absolute Batman');
        expect(sanitizeNamingPart('..')).toBe('_');
        expect(sanitizeNamingPart('')).toBe('');
    });
});
