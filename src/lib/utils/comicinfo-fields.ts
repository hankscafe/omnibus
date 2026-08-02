// src/lib/utils/comicinfo-fields.ts
//
// #199 ComicInfo defaults, shared shape. The Smart Matcher dialog and the series metadata editor
// edit the same ~28 series-wide ComicInfo fields; this module owns the field list, the dialog-key
// → Series-column mapping, and the server-side conversion of a request carrying those fields into
// a prisma Series update fragment — so both API routes (match-series, library/update) store
// byte-identical shapes. Server-safe on purpose (no "use client"): routes import it directly,
// the UI pieces live in src/components/comicinfo-fields.tsx.

// Free-text fields, comma-separated for the list-type ComicInfo tags (split server-side into the
// Issue.writers JSON-array-string convention).
export interface ComicInfoDefaults {
    imprint?: string
    format?: string
    languageISO?: string
    ageRating?: string
    writer?: string
    penciller?: string
    inker?: string
    colorist?: string
    letterer?: string
    coverArtist?: string
    editor?: string
    translator?: string
    genre?: string
    tags?: string
    characters?: string
    teams?: string
    locations?: string
    mainCharacterOrTeam?: string
    storyArc?: string
    storyArcNumber?: string
    alternateSeries?: string
    alternateNumber?: string
    alternateCount?: string
    communityRating?: string
    gtin?: string
    notes?: string
    scanInformation?: string
    review?: string
    /** Two-way by design (not in COMIC_INFO_DEFAULT_KEYS): true → <BlackAndWhite>Yes</>, false →
     *  clears back to unset. "No" is never claimed — absence reads as Unknown. */
    blackAndWhite?: boolean
}

// Exported so callers can spread every default field into a payload without re-listing all ~28
// keys by hand. blackAndWhite is handled separately (boolean semantics).
export const COMIC_INFO_DEFAULT_KEYS = [
    "imprint", "format", "languageISO", "ageRating", "writer", "penciller", "inker", "colorist",
    "letterer", "coverArtist", "editor", "translator", "genre", "tags", "characters", "teams",
    "locations", "mainCharacterOrTeam", "storyArc", "storyArcNumber", "alternateSeries",
    "alternateNumber", "alternateCount", "communityRating", "gtin", "notes", "scanInformation", "review",
] as const

// Full ComicInfo.xml AgeRating enum (anansi-project schema) — a Select, so only valid values ship.
export const AGE_RATING_OPTIONS = [
    "Unknown", "Adults Only 18+", "Early Childhood", "Everyone", "Everyone 10+", "G",
    "Kids to Adults", "M", "MA15+", "Mature 17+", "PG", "R18+", "Rating Pending", "Teen", "X18+",
]
export const UNSET = "__unset__"

// List-type dialog fields (comma-separated text) mapped to their Series column, which stores a
// JSON array string — the Issue.writers convention. The dialog key is the ComicInfo tag name
// camelCased; the column is the (sometimes differently pluralized) DB name.
export const LIST_FIELD_TO_COLUMN: Record<string, string> = {
    writer: 'writers', penciller: 'artists', inker: 'inker', colorist: 'colorists', letterer: 'letterers',
    coverArtist: 'coverArtists', editor: 'editor', translator: 'translator', genre: 'genres', tags: 'tags',
    characters: 'characters', teams: 'teams', locations: 'locations', storyArc: 'storyArcs',
};

// The reverse map, for loading DB rows back into an editor's field state.
export const COLUMN_TO_LIST_FIELD: Record<string, string> =
    Object.fromEntries(Object.entries(LIST_FIELD_TO_COLUMN).map(([field, column]) => [column, field]));

export const splitArr = (s: string): string[] => (s || '').split(',').map(t => t.trim()).filter(Boolean);

// Scalar (series-only) columns whose dialog key IS the column name.
const SCALAR_FIELDS = [
    'imprint', 'format', 'languageISO', 'ageRating', 'gtin', 'notes', 'scanInformation', 'review',
    'mainCharacterOrTeam', 'storyArcNumber', 'alternateSeries', 'alternateNumber',
] as const;

/**
 * Converts a request body carrying ComicInfo default fields into a prisma Series update fragment.
 * Same undefined-means-untouched contract as universe/seriesGroup: absent keys touch nothing, an
 * empty string clears to null. Numbers are validated server-side (garbage stores null, never NaN;
 * the rating clamps to ComicInfo's 0-5 range) and the B&W switch is two-way by design: true stores
 * true (<BlackAndWhite>Yes</>), anything else clears to null/unset — a false "No" claim is never
 * stored.
 */
export function comicInfoDefaultsUpdateFragment(req: Record<string, any>): Record<string, any> {
    const frag: Record<string, any> = Object.fromEntries(
        Object.entries(LIST_FIELD_TO_COLUMN)
            .filter(([field]) => req[field] !== undefined)
            .map(([field, column]) => [column, req[field] ? JSON.stringify(splitArr(req[field])) : null])
    );
    for (const k of SCALAR_FIELDS) {
        if (req[k] !== undefined) frag[k] = req[k] || null;
    }
    if (req.alternateCount !== undefined) {
        frag.alternateCount = Number.isFinite(parseInt(req.alternateCount, 10)) ? parseInt(req.alternateCount, 10) : null;
    }
    if (req.communityRating !== undefined) {
        frag.communityRating = Number.isFinite(parseFloat(req.communityRating))
            ? Math.min(5, Math.max(0, parseFloat(req.communityRating))) : null;
    }
    if (req.blackAndWhite !== undefined) {
        frag.blackAndWhite = req.blackAndWhite === true ? true : null;
    }
    return frag;
}
