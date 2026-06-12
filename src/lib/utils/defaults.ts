// src/lib/utils/defaults.ts

/** Default release-scoring rules, shared by the automation engine and the settings UI seed. */
export const DEFAULT_SCORING_RULES: { term: string; score: number }[] = [
    { term: '.cbz', score: 500 },
    { term: '(digital)', score: 300 },
    { term: '[digital]', score: 300 },
    { term: 'webrip', score: 200 },
    { term: 'web-dl', score: 200 },
    { term: '.cbr', score: -400 },
    { term: '.rar', score: -400 },
    { term: 'vapi', score: -400 }
];
