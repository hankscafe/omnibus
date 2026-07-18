// src/lib/utils/issue-parser.ts
// NOTE (Node<->Rust parity): isSameIssue mirrors omnibus-engine/src/metadata.rs::is_same_issue and
// extractIssueNumber mirrors omnibus-engine/src/scanner.rs::issue_number_from_filename. The automated
// search/scan path runs the Rust copies; interactive/import runs these. Keep the two sides in sync.
import { Logger } from '@/lib/logger';

export function isSameIssue(num1: string | number, num2: string | number): boolean {
    // 1. Regex updated to capture optional leading negative sign natively
    const regex = /^(-?)0*(\d*(?:\.\d+)?)(.*)$/; 
    const m1 = String(num1).trim().match(regex);
    const m2 = String(num2).trim().match(regex);
         
    if (!m1 || !m2) return String(num1).toUpperCase() === String(num2).toUpperCase();
    
    // 2. Combine the negative sign capture group (m1[1]) with the number
    const float1 = parseFloat((m1[1] || "") + (m1[2] || "0"));
    const float2 = parseFloat((m2[1] || "") + (m2[2] || "0"));
    const suffix1 = (m1[3] || "").toUpperCase().trim();
    const suffix2 = (m2[3] || "").toUpperCase().trim();
    
    return float1 === float2 && suffix1 === suffix2;
}

export function extractIssueNumber(filename: string): string {
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
    const patterns = [
        /(?:#|issues?\s*#?|vol(?:ume)?\.?\s*|v\.?\s*|t(?:ome)?s?\.?\s*|albums?\.?\s*)?(\d{1,4})\s*(?:[-–—]|\bto\b|\bau\b|à)\s*(?:#|vol(?:ume)?\.?\s*|v\.?\s*|t(?:ome)?\.?\s*)?(\d{1,4})/gi,
        /(?:^|[^\p{L}\p{N}])t(?:ome)?\.?\s*(\d{1,4})[\s._-]+t(?:ome)?\.?\s*(\d{1,4})(?:$|[^\p{L}\p{N}])/giu,
    ];
    for (const rangeRegex of patterns) {
        let m: RegExpExecArray | null;
        while ((m = rangeRegex.exec(title)) !== null) {
            const start = parseInt(m[1], 10);
            const end = parseInt(m[2], 10);
            if (isNaN(start) || isNaN(end)) continue;
            const bothLookLikeYears = start >= 1900 && start <= 2099 && end >= 1900 && end <= 2099;
            if (bothLookLikeYears) continue;
            if (end > start) return { start, end };
        }
    }
    return null;
}

/** True only for real multi-issue markers. `REPACK` is deliberately not a pack. */
export function isPackTitle(title: string): boolean {
    if (!title) return false;
    const marker = /(?:^|[^\p{L}\p{N}])(?:pack|story[\s._-]*arc|complete|complet(?:e|es)?|collection|bundle|run|chronological|integrale|intégrale|m[ée]ga[\s._-]*pack|giga[\s._-]*pack)(?:$|[^\p{L}\p{N}])/iu;
    const countedFrench = /(?:^|[^\p{L}\p{N}])\d+\s*(?:albums|tomes|hors[\s._-]*s[ée]rie(?:s)?|h\.?s\.?)\b/iu;
    return marker.test(title) || countedFrench.test(title) || parseIssueRange(title) !== null;
}
