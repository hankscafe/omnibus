/**
 * Replace a naming token case-insensitively while treating the metadata value as
 * literal text. String replacement treats `$&`, `$1`, and similar sequences in
 * metadata as replacement directives; a callback keeps those values intact.
 */
export function replaceNamingToken(input: string, token: string, value: string): string {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return input.replace(new RegExp(escaped, 'gi'), () => value);
}

/** Sanitize one metadata value before it becomes a folder or filename component. */
export function sanitizeNamingPart(value: string): string {
    const cleaned = String(value || '').replace(/[<>:"/\\|?*]/g, '').trim();
    const safe = cleaned.replace(/^\.+/, '').replace(/\.+$/, '').trim();
    return !safe && cleaned ? '_' : safe;
}
