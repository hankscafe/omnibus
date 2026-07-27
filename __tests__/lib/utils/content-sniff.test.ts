// Issue #197 layer 2: an indexer/CDN answering a file fetch with an HTML page (Cloudflare
// challenge, login wall) must never be handed to a download client as "the file" — that's
// NZBGet's "Fetch: success / Scan: skipped" in the field.
import { describe, it, expect } from 'vitest';
import { looksLikeHtmlPage } from '@/lib/utils/content-sniff';

describe('looksLikeHtmlPage (issue #197)', () => {
    it('recognizes Cloudflare-style HTML block pages', () => {
        expect(looksLikeHtmlPage(Buffer.from('<!DOCTYPE html><html><head><title>Just a moment...</title>'))).toBe(true);
        expect(looksLikeHtmlPage(Buffer.from('<html lang="en"><body>Access denied</body></html>'))).toBe(true);
        expect(looksLikeHtmlPage(Buffer.from('﻿  \n<!doctype html><html>'))).toBe(true); // BOM + whitespace
    });

    it('passes real NZB and torrent payloads through', () => {
        expect(looksLikeHtmlPage(Buffer.from('<?xml version="1.0" encoding="iso-8859-1" ?>\n<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">'))).toBe(false);
        expect(looksLikeHtmlPage(Buffer.from('d8:announce44:udp://tracker.example.org:6969/announce13:announce-list'))).toBe(false);
        expect(looksLikeHtmlPage(Buffer.alloc(0))).toBe(false);
    });
});
