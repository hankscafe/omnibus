// src/app/api/library/cover/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { CACHE_DIR as BASE_CACHE_DIR, isPathWithinRoots } from '@/lib/utils/paths';
import { getLibraryRoots } from '@/lib/library-roots';
import { ENGINE_URL, engineHeaders } from '@/lib/engine';

const ALLOWED_METADATA_HOSTS = ['comicvine.gamespot.com', 'mangadex.org', 'uploads.mangadex.org', 'metron.cloud', 'static.metron.cloud'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

// Stored covers are frequently the RAW first page of an archive (importer + scanner 5C write it
// unresized, 1-4MB for modern scans) — far too heavy for a ~200px grid cell. ?w=<whitelisted>
// answers with a cached WebP thumbnail instead of the full file. The whitelist keeps the disk
// cache bounded: an arbitrary integer would let one client mint unlimited variants per cover.
const ALLOWED_WIDTHS = [160, 320, 480, 640, 1024];

// A cover's bytes only change when its source changes, and every response carries an ETag derived
// from that source (file mtime+size / render cache key / remote URL) — so a long fresh window is
// safe: after it lapses the browser revalidates and gets a 304 instead of re-downloading the wall.
// Admin-driven cover changes (upload/match) additionally cache-bust via &v= in the stored URL.
const CACHE_OK = 'public, max-age=604800, stale-while-revalidate=86400';

// First-page issue covers (discussion #182, local-first ingest): rendered once via the engine,
// then served from disk. Weekly-unaccessed eviction — unlike reader pages these are grid-hot, and
// the read path touches mtime to keep live ones out of the reaper. cover_thumbs (the ?w= variants
// of series/folder/remote covers) shares the same policy.
const ISSUE_COVER_CACHE_DIR = path.join(BASE_CACHE_DIR, 'issue_covers');
const THUMB_CACHE_DIR = path.join(BASE_CACHE_DIR, 'cover_thumbs');

setInterval(() => {
    for (const dir of [ISSUE_COVER_CACHE_DIR, THUMB_CACHE_DIR]) {
        try {
            if (!fs.existsSync(dir)) continue;
            const now = Date.now();
            for (const file of fs.readdirSync(dir)) {
                const filePath = path.join(dir, file);
                if (now - fs.statSync(filePath).mtimeMs > 7 * 24 * 60 * 60 * 1000) {
                    fs.unlinkSync(filePath);
                }
            }
        } catch (e) { /* best-effort cleanup */ }
    }
}, 60 * 60 * 1000);

// RFC 7232 comparison, tolerant of weak validators and multi-value headers. Strong-enough here:
// every ETag this route mints is unique per (source, variant).
function etagMatches(header: string | null, etag: string): boolean {
    if (!header) return false;
    if (header.trim() === '*') return true;
    return header.split(',').some(t => t.trim().replace(/^W\//, '') === etag);
}

function notModified(etag: string): NextResponse {
    // 304 re-carries the validator + freshness so the browser's entry is renewed for another window.
    return new NextResponse(null, { status: 304, headers: { 'ETag': etag, 'Cache-Control': CACHE_OK } });
}

function serveImage(buffer: Buffer, contentType: string, etag?: string): NextResponse {
    const headers: Record<string, string> = { 'Content-Type': contentType, 'Cache-Control': CACHE_OK };
    if (etag) headers['ETag'] = etag;
    return new NextResponse(buffer as unknown as BodyInit, { headers });
}

async function readCacheFile(cacheFile: string): Promise<Buffer | null> {
    try {
        const cached = await fs.promises.readFile(cacheFile);
        fs.promises.utimes(cacheFile, new Date(), new Date()).catch(() => {});
        return cached;
    } catch { return null; }
}

// Atomic temp→rename write (same pattern as the reader page cache) so concurrent grid requests
// can't read a half-written cover. Best-effort, fire-and-forget.
function writeCacheFile(dir: string, cacheFile: string, buffer: Buffer): void {
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tempFile = `${cacheFile}.${Date.now()}.${Math.random().toString(36).substring(7)}.tmp`;
        fs.promises.writeFile(tempFile, buffer)
            .then(() => fs.promises.rename(tempFile, cacheFile))
            .catch(() => { fs.promises.unlink(tempFile).catch(() => {}); });
    } catch { /* cache write is optional */ }
}

// Null when sharp can't decode the source (rare: exotic formats, corrupt files) — the caller then
// serves the original bytes, which is deterministic per source so shared ETags stay honest.
async function resizeToWebp(source: Buffer, width: number): Promise<Buffer | null> {
    try {
        return await sharp(source).resize({ width, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    } catch { return null; }
}

const contentTypeFor = (ext: string) => ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';

// Renders page 0 of an issue archive as a WebP cover via the engine's reader endpoint (the only
// RAR-capable extractor) with an mtime-keyed disk cache. Null on ANY failure (engine down, page
// unreadable, file gone) — the caller falls back to the series folder cover.
async function renderIssueFirstPage(archivePath: string): Promise<{ buffer: Buffer; etag: string } | null> {
    let stat;
    try {
        stat = await fs.promises.stat(archivePath);
    } catch {
        return null;
    }
    const keyHex = crypto.createHash('md5').update(`${archivePath}-cover0-${stat.mtimeMs}`).digest('hex');
    const cacheFile = path.join(ISSUE_COVER_CACHE_DIR, keyHex + '.webp');
    const etag = `"i-${keyHex}"`;
    const cached = await readCacheFile(cacheFile);
    if (cached) return { buffer: cached, etag };

    try {
        // Bounded wait (issue #183): while a library scan has the engine's blocking pool pinned,
        // a cold render can queue far longer than a grid card is worth — every card on the page
        // then hangs on its cover and the library "freezes". Give up fast and let the caller fall
        // back to the series folder cover; the render is retried on a later, calmer request.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        let engineRes;
        try {
            engineRes = await fetch(ENGINE_URL + '/api/reader/page', {
                method: 'POST',
                headers: engineHeaders({ 'Content-Type': 'application/json' }),
                // 640px covers the series-detail hero; grid thumbnails downscale client-side.
                body: JSON.stringify({ path: archivePath, index: 0, width: 640, quality: 80 }),
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeoutId);
        }
        if (!engineRes.ok) return null;
        const buffer = Buffer.from(await engineRes.arrayBuffer());
        if (buffer.length === 0) return null;

        writeCacheFile(ISSUE_COVER_CACHE_DIR, cacheFile, buffer);
        return { buffer, etag };
    } catch {
        return null;
    }
}

function getFallbackImage(cacheControl: string = 'public, max-age=86400') {
    const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600">
        <rect width="100%" height="100%" fill="#0f172a"/>
        <defs>
            <mask id="slice-mask">
                <rect x="0" y="0" width="100%" height="100%" fill="white"/>
                <rect x="0" y="296" width="100%" height="6" fill="black"/>
            </mask>
        </defs>
        <g fill="#334155">
            <text x="200" y="320" font-family="Arial, sans-serif" font-size="60" font-weight="900" text-anchor="middle" letter-spacing="8" mask="url(#slice-mask)">OMNIBUS</text>
            <text x="200" y="345" font-family="Arial, sans-serif" font-size="10" font-weight="bold" text-anchor="middle" letter-spacing="4">YOUR UNIVERSE. ORGANIZED.</text>
        </g>
    </svg>`;

    return new NextResponse(svg.trim(), {
        headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': cacheControl
        }
    });
}

// Serve a library-root-checked image file, optionally as a cached ?w= WebP thumbnail. The ETag
// derives from the SOURCE file (mtime+size+variant), so a provider sync overwriting cover.jpg
// rolls the validator naturally and a 304 can be answered from the stat alone — no read, no resize.
async function serveLocalImage(request: NextRequest, absPath: string, stat: fs.Stats, w: number | null): Promise<NextResponse> {
    const etag = `"c-${stat.mtimeMs}-${stat.size}${w ? `-w${w}` : ''}"`;
    if (etagMatches(request.headers.get('if-none-match'), etag)) return notModified(etag);

    if (w) {
        const thumbKey = crypto.createHash('md5').update(`${absPath}|${stat.mtimeMs}|${stat.size}|w${w}`).digest('hex') + '.webp';
        const thumbFile = path.join(THUMB_CACHE_DIR, thumbKey);
        const cached = await readCacheFile(thumbFile);
        if (cached) return serveImage(cached, 'image/webp', etag);

        const source = await fs.promises.readFile(absPath);
        const resized = await resizeToWebp(source, w);
        if (resized) {
            writeCacheFile(THUMB_CACHE_DIR, thumbFile, resized);
            return serveImage(resized, 'image/webp', etag);
        }
        return serveImage(source, contentTypeFor(path.extname(absPath).toLowerCase()), etag);
    }

    const buffer = await fs.promises.readFile(absPath);
    return serveImage(buffer, contentTypeFor(path.extname(absPath).toLowerCase()), etag);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  let filePath = searchParams.get('path');
  const issueId = searchParams.get('issueId');
  const wRaw = parseInt(searchParams.get('w') || '', 10);
  const w = ALLOWED_WIDTHS.includes(wRaw) ? wRaw : null;

  // --- ISSUE FIRST-PAGE COVERS (discussion #182, local-first ingest) ---
  // ?issueId=<id>: an issue scanned without provider metadata has no coverUrl row of its own; its
  // archive's first page IS its cover, rendered on demand with zero API calls. A FAILED render
  // answers with the neutral placeholder + no-store — NEVER the series folder art (2026-07-25
  // worklist item 10: serving the folder cover here made every issue of a freshly-imported series
  // wear identical volume-1 art whenever the engine was busy post-scan; no-store lets the next
  // request retry the render instead of caching the miss). ?w= is ignored here: renders are
  // already 640px WebP thumbnails.
  if (issueId) {
    try {
      const issue = await prisma.issue.findUnique({
        where: { id: issueId },
        select: { filePath: true },
      });
      if (issue?.filePath) {
        // Containment re-checked even though the path came from our own DB — defense in depth,
        // same posture as the ?path= branch.
        if (isPathWithinRoots(path.normalize(issue.filePath), await getLibraryRoots())) {
          const rendered = await renderIssueFirstPage(issue.filePath);
          if (rendered) {
            if (etagMatches(request.headers.get('if-none-match'), rendered.etag)) return notModified(rendered.etag);
            return serveImage(rendered.buffer, 'image/webp', rendered.etag);
          }
        }
      }
    } catch (e) {
      Logger.log(`[Cover] Issue first-page render failed for ${issueId}: ${getErrorMessage(e)}`, 'warn');
    }
    return getFallbackImage('no-store');
  }

  if (!filePath) return new Response("Missing path", { status: 400 });

  try {
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        const url = new URL(filePath);

        const host = url.hostname.toLowerCase();
        // Exact host or a subdomain of an allowed registrable domain — NOT a substring match
        // (e.g. 'metron.cloud.evil.tld' must not pass).
        const allowedSuffixes = ['gamespot.com', 'cbsistatic.com', 'metron.cloud', 'mangadex.org'];
        const isAllowedHost = ALLOWED_METADATA_HOSTS.includes(host) ||
                              allowedSuffixes.some(s => host === s || host.endsWith('.' + s));

        if (!isAllowedHost) {
            return new Response("Forbidden: Untrusted Host", { status: 403 });
        }

        const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.|0\.|169\.254\.)/.test(url.hostname);
        if (isPrivate) return new Response("Forbidden: Internal Address", { status: 403 });

        // ?w= remote covers get the same disk cache as local thumbnails, keyed by URL+width —
        // provider image URLs are content-stable (art changes mint new filenames), so a warm entry
        // never round-trips upstream again. The no-w path is left byte-identical for external
        // consumers (OPDS clients fetch these URLs without w and may not speak WebP).
        let remoteEtag: string | null = null;
        let remoteFile: string | null = null;
        if (w) {
            const remoteKey = crypto.createHash('md5').update(`${filePath}|w${w}`).digest('hex');
            remoteEtag = `"r-${remoteKey}"`;
            if (etagMatches(request.headers.get('if-none-match'), remoteEtag)) return notModified(remoteEtag);
            remoteFile = path.join(THUMB_CACHE_DIR, remoteKey + '.webp');
            const cached = await readCacheFile(remoteFile);
            if (cached) return serveImage(cached, 'image/webp', remoteEtag);
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);

            // --- FIX: Mimic a real browser to bypass Cloudflare blocks on Metron/ComicVine image requests
            const imgRes = await fetch(filePath, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
                }
            });
            clearTimeout(timeoutId);

            if (!imgRes.ok) throw new Error(`Status ${imgRes.status}`);

            const contentLength = parseInt(imgRes.headers.get('content-length') || '0');
            if (contentLength > MAX_IMAGE_SIZE) return new Response("File too large", { status: 413 });

            const buffer = Buffer.from(await imgRes.arrayBuffer());
            // The header check above trusts upstream; re-check the actual payload.
            if (buffer.byteLength > MAX_IMAGE_SIZE) return new Response("File too large", { status: 413 });

            if (w && remoteFile && remoteEtag) {
                const resized = await resizeToWebp(buffer, w);
                if (resized) {
                    writeCacheFile(THUMB_CACHE_DIR, remoteFile, resized);
                    return serveImage(resized, 'image/webp', remoteEtag);
                }
                // Undecodable → fall through to the legacy pass-through, uncached.
            }

            return new NextResponse(buffer as unknown as BodyInit, {
                headers: {
                    'Content-Type': imgRes.headers.get('content-type') || 'image/jpeg',
                    'Cache-Control': 'public, max-age=86400'
                }
            });
        } catch (e) {
            return getFallbackImage();
        }
    }

    const realTarget = path.normalize(filePath);

    // Separator-aware containment (root === target, or under root + path.sep). A bare startsWith let a
    // sibling root like "/data/comics-private" satisfy the "/data/comics" check and leak arbitrary files.
    if (!isPathWithinRoots(realTarget, await getLibraryRoots())) {
      return getFallbackImage();
    }

    // Async stat (also serves as the existence check) — this route is hit for every grid card and
    // discover tile, so blocking the event loop with sync fs here serializes the whole Node worker.
    let stat;
    try {
        stat = await fs.promises.stat(realTarget);
    } catch {
        return getFallbackImage();
    }

    if (stat.isDirectory()) {
        const possibleCovers = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'folder.jpg', 'Cover.jpg', 'Cover.png', 'folder.png'];
        for (const pc of possibleCovers) {
            const coverPath = path.join(realTarget, pc);
            try {
                // Stat (not read) so a 304 costs one syscall and the thumbnail path can key off
                // the candidate's mtime+size; a missing candidate throws to the next.
                const coverStat = await fs.promises.stat(coverPath);
                if (!coverStat.isFile()) continue;
                return await serveLocalImage(request, coverPath, coverStat, w);
            } catch { /* try the next candidate */ }
        }
        return getFallbackImage();
    }

    return await serveLocalImage(request, realTarget, stat, w);

  } catch (error) {
    Logger.log(`Cover Error: ${getErrorMessage(error)}`, 'error');
    return getFallbackImage();
  }
}
