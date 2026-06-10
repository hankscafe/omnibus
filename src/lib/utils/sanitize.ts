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
    return str.replace(/[<>:"/\\|?*]/g, '').trim();
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