import sanitizeHtml from 'sanitize-html';

/**
 * Robustly sanitizes HTML strings from external metadata providers.
 * Strips dangerous tags (script, object, iframe) and 
 * dangerous attributes (onerror, onclick, onload).
 */
/**
 * Strips characters that are invalid in file/folder names.
 * Used everywhere Omnibus builds paths from series/publisher names —
 * all callers MUST use this so renames and imports produce identical paths.
 */
export function sanitizeFilename(str: string): string {
    const cleaned = str.replace(/[<>:"/\\|?*]/g, '').trim();
    // Neutralize path traversal: strip leading/trailing dots so a value can't become a "." or ".." path
    // segment once joined into a folder path. Untrusted ComicInfo metadata (series/publisher/universe)
    // feeds this, and the folder-naming pattern inserts a separator between fields — so a bare ".." here
    // would otherwise escape the library root. A value that was ONLY dots collapses to "_" rather than an
    // empty (silently dropped) segment.
    const safe = cleaned.replace(/^\.+/, '').replace(/\.+$/, '').trim();
    if (!safe && cleaned) return '_';
    return safe;
}

export function sanitizeDescription(html: string | null | undefined): string {
    if (!html) return "";

    return sanitizeHtml(html, {
        allowedTags: [
            'b', 'i', 'em', 'strong', 'a', 'p', 'br', 'ul', 'ol', 'li', 'h2', 'h3', 'blockquote'
        ],
        allowedAttributes: {
            'a': ['href', 'target', 'rel']
        },
        allowedSchemes: ['http', 'https', 'mailto'],
        // Forces security best practices for all links
        transformTags: {
            'a': sanitizeHtml.simpleTransform('a', { 
                rel: 'noopener noreferrer', 
                target: '_blank' 
            })
        }
    });
}