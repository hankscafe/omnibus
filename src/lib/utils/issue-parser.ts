// src/lib/utils/issue-parser.ts
// NOTE (Node<->Rust parity): isSameIssue mirrors omnibus-engine/src/metadata.rs::is_same_issue,
// extractIssueNumber mirrors omnibus-engine/src/scanner.rs::issue_number_from_filename, and
// normalizeFractionNumbers mirrors metadata.rs::normalize_fraction_numbers. The automated
// search/scan path runs the Rust copies; interactive/import runs these. Keep the two sides in sync.
import { Logger } from '@/lib/logger';
import { normalizeFractionNumbers } from '@/lib/utils/naming';

// Issue #200's vulgar-fraction rewrite lives in naming.ts (dependency-free, so file names can use
// it in the browser too); re-exported here for the parsers and their callers.
export { normalizeFractionNumbers };

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
// Shared with the attached lane's name-anchored rule (attachment-name.ts) — the same token rule
// decides what a filename names. Parity twin: omnibus-engine scanner.rs strip_series_prefix.
export function stripSeriesPrefix(filename: string, seriesName: string): string | null {
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

// #203 Phase 0: the number alone can't say WHICH numbering domain a file belongs to — "Batman
// Annual 001" is Annual #1, not issue #1, and treating them alike produced phantom duplicates.
// Callers that create or reconcile Issue rows should use this descriptor; extractIssueNumber
// stays as a pure delegation for the many callers that only need the number.
export interface IssueDescriptor { number: string; isAnnual: boolean }

export function extractIssueNumber(filename: string, seriesName?: string): string {
    return describeIssueFromFilename(filename, seriesName).number;
}

// The annual FLAG alone (#203), for callers whose NUMBER comes from ComicInfo rather than the
// filename (the importer). Signals: ComicInfo <Format>, an "Annual…"-shaped <Number>, or the
// filename token. Parity: omnibus-engine scanner.rs annual_flag_for_signals.
const ANNUAL_TOKEN = /(?<![a-zA-Z])annual(?![a-zA-Z])/i;

export function annualFlagForSignals(format: string | null | undefined, number: string | null | undefined, filename: string): boolean {
    if (format && ANNUAL_TOKEN.test(format)) return true;
    if (number && ANNUAL_TOKEN.test(number)) return true;
    return describeIssueFromFilename(filename).isAnnual;
}

// #271: the annual flag rests on the file's <Format> ALONE - no "Annual…" <Number>, no filename
// token. That is the one signal a mislabelled row feeds back to itself: the engine's writer stamps
// an annual row's file <Format>Annual</Format>. Parity: scanner.rs annual_by_format_only.
export function annualByFormatOnly(format: string | null | undefined, number: string | null | undefined, filename: string): boolean {
    return !!format && ANNUAL_TOKEN.test(format)
        && !(number && ANNUAL_TOKEN.test(number))
        && !describeIssueFromFilename(filename).isAnnual;
}

export interface ProviderIssueRow {
    metadataSource: string | null;
    metadataId: string | null;
    number: string;
    isAnnual?: boolean | null;
    attachedVolumeId?: string | null;
}

// #271: whether one of the run's own rows (neither an annual nor on a lane) holds this provider issue
// id for the same number. A real annual carries its ANNUAL volume's ids, so a file with a run issue's
// id and number IS that run issue. Parity: scanner.rs main_run_holds_issue_id.
export function mainRunHoldsIssueId(source: string | null | undefined, issueId: string | null | undefined, number: string, rows: ProviderIssueRow[]): boolean {
    if (!issueId) return false;
    return rows.some(r => !r.isAnnual && !r.attachedVolumeId && r.metadataSource === source && r.metadataId === issueId && isSameIssue(r.number, number));
}

// #271: annualFlagForSignals, except that a file whose only Annual sign is its <Format> while its
// ComicInfo carries a same-number run issue's id is that run issue (the engine scanner and watched
// sync decide the same way).
export function annualFlagAfterRunGuard(
    file: { format?: string | null; number?: string | null; filename: string; source?: string | null; issueId?: string | null },
    number: string,
    rows: ProviderIssueRow[],
): boolean {
    if (!annualFlagForSignals(file.format, file.number, file.filename)) return false;
    return !(annualByFormatOnly(file.format, file.number, file.filename) && mainRunHoldsIssueId(file.source, file.issueId, number, rows));
}

export function describeIssueFromFilename(filename: string, seriesName?: string): IssueDescriptor {
    // Issue #200: "#½" must parse as "#0.5", not fall through every digit rule to the "1" default
    // (which collided a renamed half-issue with the real #1). Normalized once here — the recursive
    // series-hint call below re-normalizes harmlessly (idempotent).
    filename = normalizeFractionNumbers(filename);
    // 2026-07-25 worklist item 9 (Kaiju No. 8): digits that belong to the TITLE must not be read as
    // issue numbers. When the caller knows the series, its name is stripped as a prefix first; a
    // filename that IS just the series name parses as a one-shot ("1") instead of the title digit.
    // Callers without the series in hand get the unhinted behavior unchanged. A series literally
    // named "… Annual" consumes its own token here, so its files stay unflagged — inside such a
    // series there is no main run to collide with (#203, deliberate).
    if (seriesName) {
        const rest = stripSeriesPrefix(filename, seriesName);
        if (rest !== null && rest !== filename) {
            if (/\d/.test(rest) || /(?<![a-zA-Z])annual(?![a-zA-Z])/i.test(rest)) {
                return describeIssueFromFilename(rest);
            }
            return { number: "1", isAnnual: false };
        }
    }
    // #205: an extension STARTS WITH A LETTER. The Smart Matcher hands over names with the
    // extension already gone, and "Bone (1991) 13.5" used to lose its ".5" here — read as #13.
    // Parity: scanner.rs issue_descriptor_from_filename_unhinted.
    let clean = filename.replace(/\.[a-zA-Z]\w*$/, '');

    // 1. Strip years explicitly
    clean = clean.replace(/\[\d{4}(?:-\d{4})?\]/g, '').replace(/\(\d{4}(?:-\d{4})?\)/g, ''); 

    // #292: cover counts are not issue numbers. A bracket that names covers ("(2 Covers)",
    // "[4 covers]", "(2 Variant Covers)", "(1 of 2 Covers)") goes whole; without brackets only the
    // count and the word go, so "Series C 05 of 06 covers" keeps its 05. Parity: scanner.rs.
    clean = clean.replace(/[\[(][^[\]()]*\d[^[\]()]*(?<![a-zA-Z])covers?(?![a-zA-Z])[^[\]()]*[\])]/gi, '');
    clean = clean.replace(/(?<![a-zA-Z0-9.])\d+\s+(?:variant\s+)?covers?(?![a-zA-Z])/gi, '');

    // 2. Smartly strip cross-references
    const crossRefRegex = /[\[\(][^[\]()]*[a-zA-Z]+[^[\]()]*\d+[^[\]()]*[\]\)]/g;
    clean = clean.replace(crossRefRegex, (match) => {
        if (match.match(/(?:#|issue|ch(?:apter)?|vol(?:ume)?|v\s*\.)/i)) return match;
        return '';
    });

    // #203: whole-word "Annual" AFTER the cross-ref strip, so "[Annual 2]" on a regular issue
    // stays a tie-in pointer (stripped above) and never flags the file. When flagged, the number
    // ADJACENT to the token wins ("Batman Annual 001", "… Annual #3"); otherwise the token is
    // removed and the normal rules run — a year-labeled one-shot ("Superman 2021 Annual") lands
    // as Annual #1 via the default. Parity: scanner.rs issue_descriptor_from_filename.
    const annualTokenRegex = /(?<![a-zA-Z])annual(?![a-zA-Z])/i;
    const isAnnual = annualTokenRegex.test(clean);
    if (isAnnual) {
        const adjacent = clean.match(/(?<![a-zA-Z])annual\s*#?\s*0*(\d+(?:\.\d+)?[a-zA-Z]?)/i);
        if (adjacent) return { number: adjacent[1].replace(/^0+(?=\d)/, ''), isAnnual: true };
        clean = clean.replace(/(?<![a-zA-Z])annual(?![a-zA-Z])/gi, ' ');
    }

    // 3. HIGHEST PRIORITY: Explicit markers
    
    // GUARDED NEGATIVE CHECK: Only match if the negative sign is explicitly preceded by an identifier.
    // Allowed: "#-1", "Issue -1", "Vol-1". 
    // This entirely prevents common title hyphens (e.g. "Title - 001.cbz") from becoming negative issues.
    const explicitNegative = clean.match(/(?:#\s*-|issue\s+#?-|issue\s+-|ch(?:apter)?\s+-|vol(?:ume)?\s+-|v\s*-)\s*0*(\d+(?:\.\d+)?[a-zA-Z]?)/i);
    if (explicitNegative) {
        return { number: "-" + explicitNegative[1].replace(/^0+(?=\d)/, ''), isAnnual };
    }

    const issueMatch = clean.match(/(?:#|(?<=^|[^a-zA-Z])(?:issue\s*#?|ch(?:apter)?\.?))\s*0*(\d+(?:\.\d+)?[a-zA-Z]?)/i);
    if (issueMatch) return { number: issueMatch[1].replace(/^0+(?=\d)/, ''), isAnnual };

    // 4. Temporarily hide Volume tokens
    let volumeNum: string | null = null;
    const volRegex = /(?<=^|[^a-zA-Z])(?:vol(?:ume)?\s*\.?|v\s*\.?)\s*0*(\d{1,3}(?:\.\d+)?[a-zA-Z]?)(?!\d)/gi;
    const noVolString = clean.replace(volRegex, (match, p1) => {
        if (!volumeNum) volumeNum = p1.replace(/^0+(?=\d)/, '');
        return ''; 
    });

    // #292: a bare "NN of MM" is issue NN, ranked after an explicit "#"/"Issue" (and after the
    // volume tokens are hidden, so "Vol 2 of 3" keeps its old reading). Parity: scanner.rs.
    const ofMatch = noVolString.match(/(?<![a-zA-Z0-9.])0*(\d+(?:\.\d+)?)\s+of\s+\d+(?![a-zA-Z0-9])/i);
    if (ofMatch) return { number: ofMatch[1].replace(/^0+(?=\d)/, ''), isAnnual };

    // 5. SECONDARY PRIORITY: Standalone numbers
    // Note: We DO NOT capture negative signs here anymore. This ensures standalone
    // numbers with hyphens before them are safely parsed as positive.
    const matches = [...noVolString.matchAll(/(?<=^|[^a-zA-Z0-9])0*(\d+(?:\.\d+)?[a-zA-Z]?)(?=[^a-zA-Z0-9]|$)/g)];
    if (matches.length > 0) {
        for (let i = matches.length - 1; i >= 0; i--) {
            const matchVal = matches[i][1].replace(/^0+(?=\d)/, '');
            const numVal = parseFloat(matchVal);
            if (numVal >= 1900 && numVal <= 2099 && !matchVal.match(/[a-zA-Z]/)) continue;
            return { number: matchVal, isAnnual };
        }
    }

    // 6. TERTIARY PRIORITY: Volume number
    if (volumeNum) return { number: volumeNum, isAnnual };

    if (!isAnnual) {
        Logger.log(`[Issue Extractor Debug] Failed to match any extraction rule for "${filename}". Defaulting to "1"`, 'debug');
    }
    return { number: "1", isAnnual };
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