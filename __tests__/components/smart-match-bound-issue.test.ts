// __tests__/components/smart-match-bound-issue.test.ts
// #199 round 3: the matcher's bound-issue confirmation card — the summary lines the component
// renders from an /api/issue-details payload. The card is the answer to "the title of the comic
// in the card is missing and does not load the credits": both must survive here.
import { describe, it, expect } from 'vitest';
import { boundIssueSummary } from '@/components/smart-match-bound-issue';

describe('boundIssueSummary', () => {
    it('surfaces the composite title and groups the headline credits', () => {
        const s = boundIssueSummary({
            name: 'X-Men (1991) #154: Lifedeath',
            writers: ['Chris Claremont'],
            artists: ['John Romita Jr.'],
            inkers: ['Dan Green'],
            characters: ['Storm', 'Forge'],
        });
        expect(s.title).toBe('X-Men (1991) #154: Lifedeath');
        expect(s.creditLine).toContain('W: Chris Claremont');
        expect(s.creditLine).toContain('A: John Romita Jr.');
        expect(s.creditLine).toContain('I: Dan Green');
        expect(s.castLine).toContain('Ch: Storm, Forge');
    });

    it('caps each group at three names with a +n tail', () => {
        const s = boundIssueSummary({ writers: ['A', 'B', 'C', 'D', 'E'] });
        expect(s.creditLine).toBe('W: A, B, C +2');
    });

    it('collapses to nulls when the provider supplied nothing', () => {
        const s = boundIssueSummary({});
        expect(s.title).toBe(null);
        expect(s.creditLine).toBe(null);
        expect(s.castLine).toBe(null);
    });
});
