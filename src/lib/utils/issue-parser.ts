// src/lib/utils/issue-parser.ts
// NOTE (Node<->Rust parity): isSameIssue mirrors omnibus-engine/src/metadata.rs::is_same_issue,
// extractIssueNumber mirrors omnibus-engine/src/scanner.rs::issue_number_from_filename, and
// normalizeFractionNumbers mirrors metadata.rs::normalize_fraction_numbers. The automated
// search/scan path runs the Rust copies; interactive/import runs these. Keep the two sides in sync.
import { Logger } from '@/lib/logger';

// Issue #200: ComicVine numbers half-issues with Unicode vulgar fractions ("½", X-Men (1991)'s
// "Thrall"), which no digit-based rule can see. Rewrite them as decimals — merged with a glued
// preceding integer, so Wizard-era "1½" reads 1.5 — before any parse or comparison. Conservative
// set on purpose: these three are the fractions comic numbering actually uses.
const VULGAR_FRACTIONS: Record<string, string> = { '½': '.5', '¼': '.25', '¾': '.75' };

export function normalizeFractionNumbers(s: string): string {
    return s.replace(/(\d+)?([½¼¾])/g, (_, int, frac) => (int || '0') + VULGAR_FRACTIONS[frac]);
}

export function isSameIssue(num1: string | number, num2: string | number): boolean {
    // 1. Regex updated to capture optional leading negative sign natively
    const regex = /^(-?)0*(\d*(?:\.\d+)?)(.*)$/;
    const m1 = normalizeFractionNumbers(String(num1).trim()).match(regex);
    const m2 = normalizeFractionNumbers(String(num2).trim()).match(regex);
         
    if (!m1 || !m2) return String(num1).toUpperCase() === String(num2).toUpperCase();
    
    // 2. Combine the negative sign capture group (m1[1]) with the number
    const float1 = parseFloat((m1[1] || "") + (m1[2] || "0"));
    const float2 = parseFloat((m2[1] || "") + (m2[2] || "0"));
    const suffix1 = (m1[3] || "").toUpperCase().trim();
    const suffix2 = (m2[3] || "").toUpperCase().trim();
    
    return float1 === float2 && suffix1 === suffix2;
}

// Consumes `seriesName` as a case/punctuation-insensitive PREFIX of `filename`, returning the
// remainder — or null when the series name isn't a clean prefix (including when a token would be
// glued into a longer word: series "No" must never half-consume "Nova"). Tokens are the series
// name's alphanumeric runs, so "Kaiju No. 8" matches "Kaiju No.8", "kaiju_no_8", etc.
function stripSeriesPrefix(filename: string, seriesName: string): string | null {
    const tokens = seriesName.toLowerCase().match(/[a-z0-9]+/g);
    if (!tokens || tokens.length === 0) return null;
    const lower = filename.toLowerCase();
    let i = 0;
    for (const tok of tokens) {
        while (i < lower.length && !/[a-z0-9]/.test(lower[i])) i++;
        if (!lower.startsWith(tok, i)) return null;
        i += tok.length;
        if (i < lower.length && /[a-z0-9]/.test(lower[i])) return null; // glue guard
    }
    return filename.slice(i);
}

export function extractIssueNumber(filename: string, seriesName?: string): string {
    // Issue #200: "#½" must parse as "#0.5", not fall through every digit rule to the "1" default
    // (which collided a renamed half-issue with the real #1). Normalized once here — the recursive
    // series-hint call below re-normalizes harmlessly (idempotent).
    filename = normalizeFractionNumbers(filename);
    // 2026-07-25 worklist item 9 (Kaiju No. 8): digits that belong to the TITLE must not be read as
    // issue numbers. When the caller knows the series, its name is stripped as a prefix first; a
    // filename that IS just the series name parses as a one-shot ("1") instead of the title digit.
    // Callers without the series in hand get the unhinted behavior unchanged.
    if (seriesName) {
        const rest = stripSeriesPrefix(filename, seriesName);
        if (rest !== null && rest !== filename) {
            if (/\d/.test(rest)) return extractIssueNumber(rest);
            return "1";
        }
    }
    let clean = filename.replace(/\.\w+$/, '');

    // 1. Strip years explicitly
    clean = clean.replace(/\[\d{4}(?:-\d{4})?\]/g, '').replace(/\(\d{4}(?:-\d{4})?\)/g, ''); 

    // 2. Smartly strip cross-references
    const crossRefRegex = /[\[\(][^[\]()]*[a-zA-Z]+[^[\]()]*\d+[^[\]()]*[\]\)]/g;
    clean = clean.replace(crossRefRegex, (match) => {
        if (match.match(/(?:#|issue|ch(?:apter)?|vol(?:ume)?|v\s*\.)/i)) return match;
        return ''; 
    });
         
    // 3. HIGHEST PRIORITY: Explicit markers
    
    // GUARDED NEGATIVE CHECK: Only match if the negative sign is explicitly preceded by an identifier.
    // Allowed: "#-1", "Issue -1", "Vol-1". 
    // This entirely prevents common title hyphens (e.g. "Title - 001.cbz") from becoming negative issues.
    const explicitNegative = clean.match(/(?:#\s*-|issue\s+#?-|issue\s+-|ch(?:apter)?\s+-|vol(?:ume)?\s+-|v\s*-)\s*0*(\d+(?:\.\d+)?[a-zA-Z]?)/i);
    if (explicitNegative) {
        return "-" + explicitNegative[1].replace(/^0+(?=\d)/, '');
    }

    const issueMatch = clean.match(/(?:#|(?<=^|[^a-zA-Z])(?:issue\s*#?|ch(?:apter)?\.?))\s*0*(\d+(?:\.\d+)?[a-zA-Z]?)/i);
    if (issueMatch) return issueMatch[1].replace(/^0+(?=\d)/, '');

    // 4. Temporarily hide Volume tokens
    let volumeNum: string | null = null;
    const volRegex = /(?<=^|[^a-zA-Z])(?:vol(?:ume)?\s*\.?|v\s*\.?)\s*0*(\d{1,3}(?:\.\d+)?[a-zA-Z]?)(?!\d)/gi;
    const noVolString = clean.replace(volRegex, (match, p1) => {
        if (!volumeNum) volumeNum = p1.replace(/^0+(?=\d)/, '');
        return ''; 
    });

    // 5. SECONDARY PRIORITY: Standalone numbers
    // Note: We DO NOT capture negative signs here anymore. This ensures standalone
    // numbers with hyphens before them are safely parsed as positive.
    const matches = [...noVolString.matchAll(/(?<=^|[^a-zA-Z0-9])0*(\d+(?:\.\d+)?[a-zA-Z]?)(?=[^a-zA-Z0-9]|$)/g)];
    if (matches.length > 0) {
        for (let i = matches.length - 1; i >= 0; i--) {
            const matchVal = matches[i][1].replace(/^0+(?=\d)/, '');
            const numVal = parseFloat(matchVal);
            if (numVal >= 1900 && numVal <= 2099 && !matchVal.match(/[a-zA-Z]/)) continue; 
            return matchVal;
        }
    }
         
    // 6. TERTIARY PRIORITY: Volume number
    if (volumeNum) return volumeNum;
         
    Logger.log(`[Issue Extractor Debug] Failed to match any extraction rule for "${filename}". Defaulting to "1"`, 'debug');
    return "1";
}

// Detects a multi-issue / multi-volume RANGE in a release title — e.g. "#0 – 9", "#1-100",
// "Vol. 1 – 4". Returns the inclusive {start,end} of the first such range, or null when the title
// names at most a single issue. Used to recognize GetComics batch posts (a range spans multiple
// issues) for pack acceptance and section-targeting. Conservative on purpose: a span where BOTH
// ends look like 4-digit years (e.g. "(2008-2010)") is read as a release-date range, not an issue
// range, so it never trips pack detection; and the end must exceed the start. Accepts hyphen,
// en/em dash, or the word "to" as the separator, and an optional "#" before the second number.
// Kept in lock-step with the Rust engine's getcomics.rs parse_issue_range.
export function parseIssueRange(title: string): { start: number; end: number } | null {
    if (!title) return null;
    const rangeRegex = /(?:#|issues?\s*#?|vol(?:ume)?\.?\s*|v\.?\s*)?(\d{1,4})\s*(?:[-–—]|\bto\b)\s*#?(\d{1,4})/gi;
    let m: RegExpExecArray | null;
    while ((m = rangeRegex.exec(title)) !== null) {
        const start = parseInt(m[1], 10);
        const end = parseInt(m[2], 10);
        if (isNaN(start) || isNaN(end)) continue;
        const bothLookLikeYears = start >= 1900 && start <= 2099 && end >= 1900 && end <= 2099;
        if (bothLookLikeYears) continue;
        if (end > start) return { start, end };
    }
    return null;
}