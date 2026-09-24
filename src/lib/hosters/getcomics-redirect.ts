// src/lib/hosters/getcomics-redirect.ts
//
// #209 (anacronismo): GetComics hides some mirror buttons (PixelDrain on his page) behind its own
// getcomics.org/dls/ redirect. The engine classifies such a button by its label, so a candidate can
// arrive as { hoster: 'pixeldrain', url: 'https://getcomics.org/dls/…' } — a URL the PixelDrain
// resolver cannot read (it needs /u/<id>). Before a third-party hoster's resolver sees its link, the
// redirect is followed through the engine, which owns the Cloudflare warm-up and solver, and the
// landed URL is what the resolver gets. GetComics' own hosters never take the hop: the engine
// streams those links itself, challenge and all.
import { ENGINE_URL, engineHeaders, engineFetchLong } from '@/lib/engine';
import { Logger } from '@/lib/logger';

const GETCOMICS_OWN_HOSTERS = new Set(['getcomics', 'getcomics_direct', 'getcomics_main', 'unknown']);

/** A getcomics.org /dls/ link — the redirector, never a mirror's own address. */
export function isGetComicsRedirect(url: string): boolean {
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        return (host === 'getcomics.org' || host.endsWith('.getcomics.org')) && u.pathname.startsWith('/dls/');
    } catch {
        return false;
    }
}

/** Ask the engine where the redirect lands. Throws when it never leaves GetComics or the engine fails. */
export async function resolveGetComicsRedirect(url: string): Promise<string> {
    const res = await engineFetchLong(ENGINE_URL + '/api/getcomics/resolve', {
        method: 'POST',
        headers: engineHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ url }),
    });
    if (!res.ok) throw new Error(`Engine resolve endpoint returned ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error(`GetComics redirect could not be resolved: ${data.error || 'unknown reason'}`);
    if (!data.landed_url) throw new Error('GetComics redirect resolved with no landed URL');
    return data.landed_url as string;
}

/**
 * The URL a hoster's resolver should be given: the link itself, unless it is a GetComics redirect
 * standing in for a third-party mirror — then the landed URL. A failure propagates so the caller's
 * candidate loop moves on to the next hoster.
 */
export async function resolveHosterUrl(url: string, hoster: string): Promise<string> {
    if (GETCOMICS_OWN_HOSTERS.has(hoster) || !isGetComicsRedirect(url)) return url;
    Logger.log(`[Internal DL] ${hoster} link is a GetComics redirect; following it through the engine first.`, 'info');
    const landed = await resolveGetComicsRedirect(url);
    Logger.log(`[Internal DL] GetComics redirect resolved for ${hoster}: ${landed}`, 'info');
    return landed;
}
