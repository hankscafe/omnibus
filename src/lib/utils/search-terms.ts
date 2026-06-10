// src/lib/utils/search-terms.ts

/** Words ignored when comparing search queries against release names. */
export const STOP_WORDS = ['the', 'a', 'an', 'of', 'and', 'or', 'vol', 'volume', 'issue', 'black', 'white', 'blood'];

/** Variant keywords that only count when bounded by separators (short/ambiguous words). */
export const BOUNDED_VARIANT_KEYWORDS = ['noir', 'b&w', 'sketch', 'blank', 'virgin', 'uncut'];

/** Variant keywords safe to match anywhere in a release name. */
export const OPEN_VARIANT_KEYWORDS = ['variant', 'special edition', "director's cut", "directors cut", 'facsimile', 'black and white', 'extended'];

/** Filler tokens stripped before fuzzy-matching request names to download names. */
export const JUNK_WORDS = ['eng', 'cbz', 'cbr', 'cb7', 'zip', 'rar', 'webrip', 'digital', 'vol', 'volume', 'ch', 'chapter', 'issue', 'tpb', 'rip', 'the', 'and', 'of', 'by', 'gn'];
