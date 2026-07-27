// src/lib/utils/content-sniff.ts
//
// Issue #197: an indexer/CDN answering a file fetch with an HTML page (Cloudflare challenge,
// login wall, error page) must never be handed to a download client as "the file" — NZBGet
// reports that as "Fetch: success / Scan: skipped" and the download silently dies. Real payloads
// are XML (<?xml … <nzb) or bencode (d8:announce…), neither of which carries an <html tag in
// its head.

export function looksLikeHtmlPage(buf: Buffer): boolean {
    if (!buf || buf.length === 0) return false;
    const head = buf.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
    return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<html');
}
