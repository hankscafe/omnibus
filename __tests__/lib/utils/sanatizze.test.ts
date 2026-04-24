import { describe, it, expect } from 'vitest';
import { sanitizeDescription } from '../../../src/lib/utils/sanitize';

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