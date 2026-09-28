// src/lib/komga/search.ts
//
// #206 prep for Paperback's 0.9 "Komga" source (extensions-default branch 0.9, v3.0): it lists a
// series' chapters with POST /api/v1/books/list and searches — and fills its Continue Reading
// section — with POST /api/v1/series/list, sending Komga's search-condition JSON. The body is
// untrusted input, so it is read with a size cap, parsed into a small whitelisted tree (bounded
// depth and clause count; unknown fields and operators dropped and reported), and only that tree
// is turned into Prisma filters — never raw SQL. Library grants are NOT applied here: the data
// layer ANDs them outside whatever the tree says, so no condition can widen what a key can see.
import type { Prisma } from '@prisma/client';

export const SEARCH_LIMITS = { maxBytes: 64 * 1024, maxDepth: 8, maxNodes: 64, maxValueLength: 512, maxFullText: 200 };

export type SearchField = 'libraryId' | 'collectionId' | 'seriesId' | 'genre' | 'tag' | 'readStatus' | 'mediaStatus';

export type SearchNode =
    | { kind: 'all'; nodes: SearchNode[] }
    | { kind: 'any'; nodes: SearchNode[] }
    | { kind: 'field'; field: SearchField; op: 'is' | 'isNot'; value: string }
    | { kind: 'flag'; field: 'deleted'; value: boolean };

export interface SearchBody {
    condition: SearchNode | null;
    fullTextSearch: string | null;
    /** Fields / operators the client asked for that this server doesn't understand (dropped). */
    ignored: string[];
}

export class SearchError extends Error {
    constructor(public status: 400 | 413, message: string) {
        super(message);
    }
}

const FIELDS: readonly SearchField[] = ['libraryId', 'collectionId', 'seriesId', 'genre', 'tag', 'readStatus', 'mediaStatus'];

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The source URL-encodes filter values; a value that isn't valid encoding is kept as typed. */
function decodeValue(v: unknown): string | null {
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    const raw = String(v).slice(0, SEARCH_LIMITS.maxValueLength);
    try { return decodeURIComponent(raw); } catch { return raw; }
}

export function parseSearchBody(raw: unknown): SearchBody {
    const ignored: string[] = [];
    if (raw === null || raw === undefined) return { condition: null, fullTextSearch: null, ignored };
    if (!isPlainObject(raw)) throw new SearchError(400, 'The search body must be an object.');

    let nodes = 0;
    const parse = (c: unknown, depth: number): SearchNode | null => {
        if (depth > SEARCH_LIMITS.maxDepth) throw new SearchError(400, 'The search condition is nested too deeply.');
        if (!isPlainObject(c)) throw new SearchError(400, 'A search condition must be an object.');
        if (++nodes > SEARCH_LIMITS.maxNodes) throw new SearchError(400, 'The search condition has too many clauses.');

        const keys = Object.keys(c);
        // The source writes several constraints as keys of ONE object ({ seriesId, deleted, … }):
        // read that as allOf of each key on its own.
        if (keys.length > 1) return group('all', keys.map(k => parse({ [k]: c[k] }, depth + 1)));
        const [key] = keys;
        if (key === undefined) return null;
        const v = c[key];
        if (key === 'allOf' || key === 'anyOf') {
            if (!Array.isArray(v)) throw new SearchError(400, `${key} must be a list of conditions.`);
            return group(key === 'allOf' ? 'all' : 'any', v.map(x => parse(x, depth + 1)));
        }
        const operator = isPlainObject(v) ? v.operator : undefined;
        if (key === 'deleted') {
            if (operator === 'isTrue' || operator === 'isFalse') return { kind: 'flag', field: 'deleted', value: operator === 'isTrue' };
            ignored.push(`deleted:${String(operator)}`);
            return null;
        }
        if (!(FIELDS as readonly string[]).includes(key)) {
            ignored.push(key);
            return null;
        }
        if (operator !== 'is' && operator !== 'isNot') {
            ignored.push(`${key}:${String(operator)}`);
            return null;
        }
        const value = decodeValue(isPlainObject(v) ? v.value : undefined);
        if (value === null) {
            ignored.push(`${key}:value`);
            return null;
        }
        return { kind: 'field', field: key as SearchField, op: operator, value };
    };

    const condition = raw.condition === undefined || raw.condition === null ? null : parse(raw.condition, 1);
    const text = typeof raw.fullTextSearch === 'string' ? raw.fullTextSearch.trim().slice(0, SEARCH_LIMITS.maxFullText) : '';
    return { condition, fullTextSearch: text || null, ignored };
}

/** A group of kept members: none → no constraint; one → that member. */
function group(kind: 'all' | 'any', members: Array<SearchNode | null>): SearchNode | null {
    const kept = members.filter((m): m is SearchNode => m !== null);
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0];
    return { kind, nodes: kept };
}

/** Read the request body — capped before and after it arrives — and parse it. */
export async function readSearchBody(req: Request): Promise<SearchBody> {
    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > SEARCH_LIMITS.maxBytes) throw new SearchError(413, 'The search body is too large.');
    const text = await req.text();
    if (text.length > SEARCH_LIMITS.maxBytes) throw new SearchError(413, 'The search body is too large.');
    if (!text.trim()) return parseSearchBody(null);
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new SearchError(400, 'The search body is not valid JSON.'); }
    return parseSearchBody(json);
}

// ---------------------------------------------------------------------------------------------
// Tree → Prisma filters. ALWAYS / NEVER are compared by identity while combining.
// ---------------------------------------------------------------------------------------------

export const ALWAYS = Object.freeze({}) as Record<string, never>;
/** Matches no row (Prisma treats `in: []` as false). */
export const NEVER = Object.freeze({ id: Object.freeze({ in: Object.freeze([]) as unknown as string[] }) });

function combine<W extends object>(kind: 'all' | 'any', parts: W[]): W {
    if (kind === 'all') {
        if (parts.some(p => p === (NEVER as unknown))) return NEVER as unknown as W;
        const kept = parts.filter(p => p !== (ALWAYS as unknown));
        if (kept.length === 0) return ALWAYS as unknown as W;
        return kept.length === 1 ? kept[0] : ({ AND: kept } as W);
    }
    if (parts.some(p => p === (ALWAYS as unknown))) return ALWAYS as unknown as W;
    const kept = parts.filter(p => p !== (NEVER as unknown));
    if (kept.length === 0) return NEVER as unknown as W;
    return kept.length === 1 ? kept[0] : ({ OR: kept } as W);
}

const negate = <W extends object>(op: 'is' | 'isNot', w: W): W => {
    if (op === 'is') return w;
    if (w === (ALWAYS as unknown)) return NEVER as unknown as W;
    if (w === (NEVER as unknown)) return ALWAYS as unknown as W;
    return { NOT: w } as W;
};

/**
 * isNot on a column that may be empty: SQL's `NOT (col LIKE …)` / `col <> …` is NULL — false —
 * when the column is NULL, which silently dropped every series with no genres, tags or library.
 * "Not X" includes "nothing at all".
 */
const negateNullable = <W extends object>(op: 'is' | 'isNot', column: string, w: W): W =>
    op === 'is' ? w : ({ OR: [{ [column]: null }, { NOT: w }] } as unknown as W);

/** Whole-value match on a JSON-array string column ("Superhero" never matches "Superheroes"). */
const listHas = (value: string) => ({ contains: `"${value}"` });

export interface SeriesSearchContext {
    userId: string;
    /** The caller's series with an unfinished book — only fetched when the tree asks for it. */
    inProgressSeriesIds: () => Promise<string[]>;
}

export async function seriesWhereFor(node: SearchNode | null, ctx: SeriesSearchContext): Promise<Prisma.SeriesWhereInput> {
    if (!node) return ALWAYS;
    switch (node.kind) {
        case 'all':
        case 'any':
            return combine(node.kind, await Promise.all(node.nodes.map(n => seriesWhereFor(n, ctx))));
        case 'flag':
            return node.value ? (NEVER as Prisma.SeriesWhereInput) : ALWAYS; // nothing here is ever deleted
        case 'field': {
            const { op, value } = node;
            switch (node.field) {
                case 'libraryId': return negateNullable(op, 'libraryId', { libraryId: value });
                case 'seriesId': return negate(op, { id: value });
                case 'genre': return negateNullable(op, 'genres', { genres: listHas(value) });
                case 'tag': return negateNullable(op, 'tags', { tags: listHas(value) });
                case 'collectionId':
                    return negate(op, { collectionItems: { some: { collectionId: value, collection: { userId: ctx.userId } } } });
                case 'readStatus':
                    // Only "in progress" is answerable per series; anything else matches nothing
                    // rather than something wrong.
                    if (value !== 'IN_PROGRESS') return NEVER as Prisma.SeriesWhereInput;
                    return negate(op, { id: { in: await ctx.inProgressSeriesIds() } });
                case 'mediaStatus':
                    return ALWAYS; // a book-level notion; a series list ignores it
            }
        }
    }
}

export function bookWhereFor(node: SearchNode | null, userId: string): Prisma.IssueWhereInput {
    if (!node) return ALWAYS;
    switch (node.kind) {
        case 'all':
        case 'any':
            return combine(node.kind, node.nodes.map(n => bookWhereFor(n, userId)));
        case 'flag':
            return node.value ? (NEVER as Prisma.IssueWhereInput) : ALWAYS;
        case 'field': {
            const { op, value } = node;
            switch (node.field) {
                case 'seriesId': return negate(op, { seriesId: value });
                case 'libraryId': return { series: negateNullable(op, 'libraryId', { libraryId: value }) };
                case 'genre': return { series: negateNullable(op, 'genres', { genres: listHas(value) }) };
                case 'tag': return { series: negateNullable(op, 'tags', { tags: listHas(value) }) };
                case 'collectionId':
                    return negate(op, { series: { collectionItems: { some: { collectionId: value, collection: { userId } } } } });
                case 'mediaStatus':
                    // Every book here has its file: READY is always true, any other status never.
                    return negate(op, value === 'READY' ? ALWAYS : (NEVER as Prisma.IssueWhereInput));
                case 'readStatus':
                    if (value === 'IN_PROGRESS') return negate(op, { readProgresses: { some: { userId, isCompleted: false, currentPage: { gt: 0 } } } });
                    if (value === 'READ') return negate(op, { readProgresses: { some: { userId, isCompleted: true } } });
                    if (value === 'UNREAD') {
                        const started = { readProgresses: { some: { userId, OR: [{ isCompleted: true }, { currentPage: { gt: 0 } }] } } };
                        return op === 'is' ? { NOT: started } : started;
                    }
                    return NEVER as Prisma.IssueWhereInput;
            }
        }
    }
}

/** The one series a book search is pinned to (`seriesId is X`, alone or directly under allOf). */
export function pinnedSeriesId(node: SearchNode | null): string | null {
    if (!node) return null;
    if (node.kind === 'field') return node.field === 'seriesId' && node.op === 'is' ? node.value : null;
    if (node.kind === 'all') {
        const pins = node.nodes.filter(n => n.kind === 'field' && n.field === 'seriesId' && n.op === 'is');
        return pins.length === 1 ? (pins[0] as { value: string }).value : null;
    }
    return null;
}
