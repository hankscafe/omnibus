// Clipboard helper that works on plain-HTTP origins. The async Clipboard API
// (navigator.clipboard) only exists in secure contexts (HTTPS or localhost) — on a LAN deployment
// like http://192.168.x.x:3000 it is undefined, so every `navigator.clipboard.writeText(...)` call
// silently threw while the UI still toasted "Copied!". Callers must use this instead and toast off
// the returned boolean.
export async function copyText(text: string): Promise<boolean> {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* fall through to the legacy path */ }

    // Legacy fallback: off-screen textarea + execCommand('copy') — deprecated but the only
    // mechanism available to insecure origins.
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        document.body.appendChild(ta);
        const selection = document.getSelection();
        const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (previousRange && selection) {
            selection.removeAllRanges();
            selection.addRange(previousRange);
        }
        return ok;
    } catch {
        return false;
    }
}
