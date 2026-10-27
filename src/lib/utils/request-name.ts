// src/lib/utils/request-name.ts
//
// The search term a request is filed under. ONE implementation, because two doors now file
// requests — the series page and the library-wide Missing Issues view — and the downloader's
// search (with its annual guard and its numeric-aware matching, #202/#203) keys on this exact
// string. Two copies would drift, and a drift here is a request that quietly hunts for the wrong
// thing from one door and the right thing from the other.
//
// Rules, in the order they shipped:
//   - Issue #200: parsedNum is NaN→null for anything parseFloat can't read, so the raw stored
//     number is the fallback — a request never says "#null".
//   - #203 Phase 0: an annual carries its domain in the composite ("Series Annual #N"), which is
//     what flips the downloader's annual-aware guards for that request.
//   - #203 COLLECTED: a trade is searched for by its OWN title ("X-Men: From the Ashes Vol. 1"),
//     never as "{Series} #1" — that would hunt for a single issue that isn't the book.
//   - #255: a Special is searched for under its OWN volume's name ("Absolute Batman: Ark-M #1"),
//     never as the run's "{Series} #1"; its story title rides along like an issue's.

export interface RequestNameInput {
    seriesName: string;
    number: string | null | undefined;
    parsedNum?: number | null;
    /** The issue's own title, when the provider or a file gave it one. */
    name?: string | null;
    isAnnual?: boolean;
    isCollected?: boolean;
    /** For a collected edition: the attached volume's name, the fallback when the row has no title. */
    collectionName?: string | null;
    isSpecial?: boolean;
    /** For a Special: its attached volume's name, which stands in for the series name. */
    specialName?: string | null;
}

export function requestNameFor(i: RequestNameInput): { composite: string; reqNum: string } {
    const reqNum = (i.parsedNum ?? i.number ?? '').toString();

    if (i.isCollected) {
        const own = i.name && i.name !== i.seriesName ? i.name : null;
        return { composite: own || i.collectionName || `${i.seriesName} Vol. ${reqNum}`, reqNum };
    }

    const special = i.isSpecial ? ((i.specialName || '').trim() || `${i.seriesName} Special`) : null;
    const base = special ?? i.seriesName;
    let composite = special ? `${special} #${reqNum}` : `${i.seriesName}${i.isAnnual ? ' Annual' : ''} #${reqNum}`;
    // A real story title rides along after the number; a title that already carries the number
    // IS the composite. A title equal to the series name adds nothing and is dropped.
    if (i.name && i.name !== i.seriesName && i.name !== base && !i.name.includes(`#${reqNum}`)) {
        composite += `: ${i.name}`;
    } else if (i.name && i.name.includes(`#${reqNum}`)) {
        composite = i.name;
    }
    return { composite, reqNum };
}
