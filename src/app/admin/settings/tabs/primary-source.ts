// src/app/admin/settings/tabs/primary-source.ts
//
// The settings page moves the primary metadata source to the other provider when the chosen one
// has lost its credentials and the other one has them (a cleared ComicVine key while Metron has a
// token, say). Pure, so the page's effect can key on its answer instead of reading the whole config.
import { hasMetronCredentials } from '@/lib/metron/credentials';

type ConfigLike = Record<string, string | null | undefined>;

/** Whether a provider has what it needs to be the primary source (a masked saved secret counts). */
export function sourceHasCredentials(config: ConfigLike, source: string): boolean {
    if (source === 'COMICVINE') return (config.cv_api_key ?? '').trim() !== '';
    // An API token alone is a complete Metron setup (Metron is retiring username/password sign-in).
    if (source === 'METRON') return hasMetronCredentials(config);
    return false;
}

/** The provider the primary source should move to, or null to leave it as it is. */
export function primarySourceFallback(config: ConfigLike): 'COMICVINE' | 'METRON' | null {
    const primary = config.primary_metadata_source;
    if (primary === 'METRON' && !sourceHasCredentials(config, 'METRON') && sourceHasCredentials(config, 'COMICVINE')) return 'COMICVINE';
    if (primary === 'COMICVINE' && !sourceHasCredentials(config, 'COMICVINE') && sourceHasCredentials(config, 'METRON')) return 'METRON';
    return null;
}
