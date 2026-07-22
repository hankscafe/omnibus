// __tests__/components/interactive-search-sort.test.ts
// Rung-aware ordering for interactive search results: the engine tags Prowlarr hits with the
// query-ladder rung that found them (queryRung, 0 = exact term); broadened-fallback hits must sink
// below exact hits from ANY source, and untagged sources (GetComics/Anna's) count as exact.
import { describe, it, expect } from 'vitest';
import { sortByQueryRung } from '@/components/interactive-search-modal';

describe('sortByQueryRung', () => {
    it('sinks broadened-fallback hits below exact and untagged results', () => {
        const rows = [
            { title: 'prowlarr-broad', queryRung: 4 },
            { title: 'getcomics-untagged' },
            { title: 'prowlarr-exact', queryRung: 0 },
        ];
        expect(sortByQueryRung(rows).map(r => r.title)).toEqual([
            'getcomics-untagged', 'prowlarr-exact', 'prowlarr-broad',
        ]);
    });

    it('is stable within a rung (source order preserved) and does not mutate the input', () => {
        const rows = [
            { title: 'p1', queryRung: 2 },
            { title: 'p2', queryRung: 2 },
            { title: 'g1' },
            { title: 'g2' },
        ];
        const sorted = sortByQueryRung(rows);
        expect(sorted.map(r => r.title)).toEqual(['g1', 'g2', 'p1', 'p2']);
        // Original array order untouched.
        expect(rows.map(r => r.title)).toEqual(['p1', 'p2', 'g1', 'g2']);
    });
});
