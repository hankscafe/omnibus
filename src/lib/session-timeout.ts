// src/lib/session-timeout.ts
//
// Inactivity-window rules shared by the NextAuth jwt callback and the middleware.
// Edge-safe: pure constants and arithmetic only.
export const ADMIN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const USER_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export function isInactivityExpired(
    role: string | undefined | null,
    lastActive: number | undefined | null,
    now: number = Date.now()
): boolean {
    // No stamp = legacy token from before the window existed; the jwt callback stamps it next run.
    if (!lastActive) return false;
    const limit = role === 'ADMIN' ? ADMIN_TIMEOUT_MS : USER_TIMEOUT_MS;
    return now - lastActive > limit;
}
