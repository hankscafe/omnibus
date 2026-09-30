// Which Metron credentials a settings map holds - client-safe (no Prisma), for the pages that show or
// hide a Metron feature and for the Health check. Metron is retiring username/password sign-in for its
// API in favour of API tokens, so a token alone is a complete setup, and it wins when both are saved.
//
// A masked value (`********`, what /api/admin/config returns for a stored secret) counts as set: it
// means one is saved. Sending a request is different - authFromSettings (metron/client.ts) never
// treats the mask as a credential.

export type MetronCredentialKind = 'token' | 'password' | null;

type SettingsLike = Record<string, string | null | undefined> | { key: string; value: string }[] | null | undefined;

const filled = (v: string | null | undefined) => (v ?? '').trim() !== '';

/** 'token' (an API token is saved), 'password' (a username and password, no token), or null. */
export function metronCredentialKind(settings: SettingsLike): MetronCredentialKind {
    if (!settings) return null;
    const get = Array.isArray(settings)
        ? (key: string) => settings.find(s => s.key === key)?.value
        : (key: string) => settings[key];
    if (filled(get('metron_api_token'))) return 'token';
    return filled(get('metron_user')) && filled(get('metron_pass')) ? 'password' : null;
}

/** Whether Metron is set up at all (a token, or a username and password). */
export function hasMetronCredentials(settings: SettingsLike): boolean {
    return metronCredentialKind(settings) !== null;
}
