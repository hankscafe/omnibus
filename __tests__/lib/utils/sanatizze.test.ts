import { describe, it, expect } from 'vitest';
import { sanitizeDescription, providerWikiBase } from '../../../src/lib/utils/sanitize';

describe('Utility: HTML Sanitizer', () => {
    it('should return an empty string for null or undefined input', () => {
        expect(sanitizeDescription(null)).toBe('');
        expect(sanitizeDescription(undefined)).toBe('');
        expect(sanitizeDescription('')).toBe('');
    });

    it('should allow safe tags like p, b, i, and br', () => {
        const input = '<p>This is <b>bold</b> and <i>italic</i><br/>text.</p>';
        
        // sanitize-html automatically normalizes <br/> into <br />
        const expectedOutput = '<p>This is <b>bold</b> and <i>italic</i><br />text.</p>';
        
        expect(sanitizeDescription(input)).toBe(expectedOutput);
    });

    it('should completely strip dangerous tags like script, iframe, and object', () => {
        const input = '<p>Safe Text</p><script>alert("XSS")</script><iframe src="bad.html"></iframe>';
        expect(sanitizeDescription(input)).toBe('<p>Safe Text</p>');
    });

    it('should enforce safe attributes on anchor tags', () => {
        // We throw a malicious onclick event at it
        const input = '<a href="https://example.com" onclick="stealData()">Click me</a>';
        const output = sanitizeDescription(input);

        // It should keep the link, but force it to open in a new tab securely, and strip the onclick
        expect(output).toContain('href="https://example.com"');
        expect(output).toContain('target="_blank"');
        expect(output).toContain('rel="noopener noreferrer"');
        expect(output).not.toContain('onclick');
    });
});

// Fork review 2026-07-29, their #8: ComicVine embeds root-relative wiki links (/wolverine/4005-1440/)
// in description HTML; they used to survive sanitization verbatim and 404 against the Omnibus origin.
// With a provider base they resolve absolute; with no base the href is dropped (unclickable text
// beats a guaranteed 404). Absolute links and the XSS posture are unchanged.
describe('Utility: provider wiki link resolution', () => {
    const CV = providerWikiBase('COMICVINE')!;

    it('maps known sources case-insensitively and rejects unknowns', () => {
        expect(providerWikiBase('COMICVINE')).toBe('https://comicvine.gamespot.com');
        expect(providerWikiBase('metron')).toBe('https://metron.cloud');
        expect(providerWikiBase('MANGADEX')).toBe('https://mangadex.org');
        expect(providerWikiBase(null)).toBeNull();
        expect(providerWikiBase('SOMETHING_ELSE')).toBeNull();
    });

    it('resolves CV root-relative wiki links to absolute CV URLs (the 404 fix)', () => {
        const input = '<p>See <a href="/wolverine/4005-1440/">Wolverine</a> for more.</p>';
        const output = sanitizeDescription(input, CV);

        expect(output).toContain('href="https://comicvine.gamespot.com/wolverine/4005-1440/"');
        expect(output).toContain('target="_blank"');
        expect(output).toContain('rel="noopener noreferrer"');
    });

    it('resolves dotted relative paths against the base too', () => {
        const output = sanitizeDescription('<a href="../volume/4050-123/">V</a>', CV);
        expect(output).toContain('href="https://comicvine.gamespot.com/volume/4050-123/"');
    });

    it('drops the href but keeps the text when there is no base to resolve against', () => {
        const output = sanitizeDescription('<a href="/wolverine/4005-1440/">Wolverine</a>');
        expect(output).not.toContain('href');
        expect(output).toContain('Wolverine');
    });

    it('leaves absolute links untouched apart from the security attributes', () => {
        const output = sanitizeDescription('<a href="https://example.com/page">x</a>', CV);
        expect(output).toContain('href="https://example.com/page"');
    });

    it('never lets a javascript: href through, base or not', () => {
        expect(sanitizeDescription('<a href="javascript:alert(1)">x</a>', CV)).not.toContain('javascript');
        expect(sanitizeDescription('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript');
    });
});