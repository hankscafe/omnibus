// src/lib/getcomics.ts
//
// The Node GetComics SEARCH stack (GetComicsService.search/performSearch + the FlareSolverr HTML
// fetcher) was retired: every caller now goes through the Rust engine — automation + the retry
// route's recovery search via /api/automation/search, interactive via /api/search/interactive,
// article scraping via /api/getcomics/scrape. What remains here is the engine scrape client and
// the hoster-priority helpers shared by the routes.
import { Logger } from './logger';
import { getErrorMessage } from './utils/error';
import { ENGINE_URL, engineHeaders } from './engine';

/**
 * Resolve a GetComics article to a concrete hoster link via the Rust engine's section-targeting
 * scraper (/api/getcomics/scrape) — instead of the flat Node scrapeDeepLink, which can hand back the
 * wrong volume's archive from a multi-pack page. Pass the request `name` (and per-issue `year`) so the
 * engine can target the section for the requested issue. Returns the top enabled-hoster link; `hoster`
 * is empty when nothing resolved, and `ambiguous` is true when the article is a multi-pack page with no
 * clean match (the caller should NOT grab an arbitrary archive — fall back to a fresh search instead).
 */
export async function scrapeDeepLinkViaEngine(
    articleUrl: string,
    opts?: { name?: string | null; year?: string | null }
): Promise<{ url: string; hoster: string; ambiguous: boolean }> {
    // Only target when the name explicitly names an issue (same marker rule as the engine's caller).
    let issueNum: number | null = null;
    if (opts?.name) {
        const m = opts.name.match(/(?:#|issue\s*#?|ch(?:apter)?\s*\.?)\s*0*(-?\d+(?:\.\d+)?)/i);
        if (m) { const n = parseFloat(m[1]); if (!isNaN(n)) issueNum = n; }
    }
    try {
        const res = await fetch(ENGINE_URL + '/api/getcomics/scrape', {
            method: 'POST',
            headers: engineHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ url: articleUrl, issue_num: issueNum, year: opts?.year ?? null }),
        });
        if (!res.ok) {
            Logger.log(`[GetComics] engine scrape returned ${res.status} for ${articleUrl}`, 'warn');
            return { url: '', hoster: '', ambiguous: false };
        }
        const data = await res.json();
        if (data.ambiguous) return { url: '', hoster: '', ambiguous: true };
        const first = Array.isArray(data.links) && data.links.length > 0 ? data.links[0] : null;
        return first ? { url: first.url, hoster: first.hoster, ambiguous: false } : { url: '', hoster: '', ambiguous: false };
    } catch (e) {
        Logger.log(`[GetComics] engine scrape failed for ${articleUrl}: ${getErrorMessage(e)}`, 'warn');
        return { url: '', hoster: '', ambiguous: false };
    }
}

// --- Shared hoster-priority helpers (kept in lock-step with the Rust engine's getcomics.rs) ---

/** Default hoster order. Both GetComics variants sit at the TOP — `getcomics_direct` (comicfiles CDN)
 *  then `getcomics_main` (getcomics.org/dls/ main server). The /dls/ direct download works for most
 *  issues (only the subset behind a live Cloudflare challenge falls through to the manual-hold), and it
 *  outranks the far-less-reliable third-party mirrors. Matches the original `getcomics`-first ordering. */
// Anna's Archive is its own search source (search_source_priority), not a GetComics mirror, so it's no
// longer part of the hoster-mirror priority list. Its download key still lives in a HosterAccount.
export const DEFAULT_HOSTER_ORDER = ['getcomics_direct', 'getcomics_main', 'mediafire', 'mega', 'pixeldrain', 'rootz', 'vikingfile', 'terabox'];

// Listed but OFF by default — Cloudflare/JS/app-gated, not resolvable by scraping (still toggleable).
export const DEFAULT_DISABLED_HOSTERS = ['rootz', 'vikingfile', 'terabox'];

export type HosterPref = { hoster: string, enabled: boolean };

/** Default hoster prefs: the standard order with the known-unreliable hosters disabled out of the box. */
export function defaultHosterPrefs(): HosterPref[] {
    return DEFAULT_HOSTER_ORDER.map(h => ({ hoster: h, enabled: !DEFAULT_DISABLED_HOSTERS.includes(h) }));
}

/** Migrate a legacy single `getcomics` entry into `getcomics_direct` (kept in place + enabled flag) +
 *  `getcomics_main` (inserted right after it, same enabled flag, so both stay high-priority — the
 *  legacy `getcomics` was first). Idempotent; mirrors Rust migrate_legacy_getcomics. */
export function migrateHosterPrefs(prefs: HosterPref[]): HosterPref[] {
    const out = prefs.map(p => ({ ...p }));
    const i = out.findIndex(p => p.hoster === 'getcomics');
    if (i !== -1) {
        const enabled = out[i].enabled;
        out[i] = { hoster: 'getcomics_direct', enabled };
        if (!out.some(p => p.hoster === 'getcomics_main')) out.splice(i + 1, 0, { hoster: 'getcomics_main', enabled });
    }
    return out;
}

/** Parse a raw `hoster_priority` setting value into an ordered, migrated pref list. Unset → defaults;
 *  empty array → none; string array → all enabled; object array → each entry's `enabled` (default true). */
export function parseHosterPrefs(value?: string | null): HosterPref[] {
    const defaults = defaultHosterPrefs;
    if (!value) return defaults();
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) return defaults();
        if (parsed.length === 0) return [];
        const prefs: HosterPref[] = typeof parsed[0] === 'string'
            ? parsed.map((h: string) => ({ hoster: h, enabled: true }))
            : parsed.map((p: any) => ({ hoster: p.hoster, enabled: p.enabled !== false }));
        return migrateHosterPrefs(prefs);
    } catch { return defaults(); }
}

/** Enabled hoster names in priority order, migrating the legacy `getcomics` key. Mirrors Rust enabled_hosters. */
export function enabledHostersFromSetting(value?: string | null): string[] {
    return parseHosterPrefs(value).filter(p => p.enabled).map(p => p.hoster);
}
