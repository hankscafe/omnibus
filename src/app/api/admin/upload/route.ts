// src/app/api/admin/upload/route.ts
//
// Admin-only manual file upload. Streams an uploaded comic file straight to disk into the
// WATCHED (default) or UNMATCHED directory, where the existing watched-sync pipeline imports
// and matches it exactly like a normal download. Used to recover Cloudflare-gated GetComics
// downloads the admin had to fetch by hand, and as a general "get files onto the server" tool
// for admins without filesystem access.
//
// The file is sent as the raw request body (one file per request) rather than multipart/form-data
// so large comics stream to disk instead of buffering in memory — important on NAS hardware.
//
// CHUNKED MODE (beta.015): Cloudflare's edge caps request bodies at ~100MB on free/pro plans, and
// tunnel traffic goes through that edge — so the client slices big files into <50MB chunks. Each
// chunk arrives with uploadId + chunkIndex/totalChunks + chunkOffset; the server appends to a
// deterministic .part file and VERIFIES the offset before every append, so a retried or
// out-of-order chunk can never corrupt the file (mismatch → 409, the client aborts). Offsets are
// verified against the process's OWN append accounting (chunk-session.ts) — never bare fs.stat,
// whose answer is stale for seconds on NFS/SMB-backed drop folders (field bug 2026-07-27) — with
// an open()-based probe as the restart fallback, and the assembled size is verified before the
// final atomic rename. Requests without chunk params behave exactly as before.
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs-extra';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { WATCHED_DIR, UNMATCHED_DIR, isPathWithinRoots } from '@/lib/utils/paths';
import { isComicFile } from '@/lib/utils/formats';
import { sanitizeFilename } from '@/lib/utils/sanitize';
import { noteChunkAppended, sessionBytes, dropSession, sweepSessions, freshFileSize, verifyChunkOffset, verifyAssembledSize } from '@/lib/uploads/chunk-session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_UPLOAD_MB = Number(process.env.OMNIBUS_MAX_UPLOAD_MB) || 2048;
const MAX_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// Find a non-colliding destination by appending " (n)" before the extension, mirroring the
// de-duplication style used elsewhere in the importer.
async function resolveUniquePath(dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let n = 1;
  while (await fs.pathExists(candidate)) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n++;
  }
  return candidate;
}

export async function POST(req: NextRequest) {
  let tmpPath: string | null = null;
  let sessionId: string | null = null;
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const role = session?.user?.role;
    const userId = session?.user?.id;
    if (role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const destination = searchParams.get('destination') === 'unmatched' ? 'unmatched' : 'watched';
    const requestId = searchParams.get('requestId') || undefined;
    // URLSearchParams already URL-decodes; strip any path components, then invalid filename chars.
    const safeName = sanitizeFilename(path.basename(searchParams.get('filename') || ''));
    if (!safeName || !isComicFile(safeName)) {
      return NextResponse.json(
        { error: 'Unsupported or missing filename. Allowed: .cbz, .cbr, .zip, .rar, .cb7, .epub' },
        { status: 400 },
      );
    }

    // Chunked-mode params (all-or-nothing). uploadId lands in the temp filename, so it is
    // restricted to a safe alphabet and never trusted as a path component.
    const uploadIdRaw = searchParams.get('uploadId') || '';
    const isChunked = uploadIdRaw !== '';
    const uploadId = uploadIdRaw.replace(/[^a-zA-Z0-9-]/g, '');
    const chunkIndex = Number(searchParams.get('chunkIndex'));
    const totalChunks = Number(searchParams.get('totalChunks'));
    const chunkOffset = Number(searchParams.get('chunkOffset'));
    if (isChunked && (
      uploadId !== uploadIdRaw || uploadId.length < 8 || uploadId.length > 64 ||
      !Number.isInteger(chunkIndex) || chunkIndex < 0 ||
      !Number.isInteger(totalChunks) || totalChunks < 1 || chunkIndex >= totalChunks ||
      !Number.isInteger(chunkOffset) || chunkOffset < 0 || chunkOffset > MAX_BYTES
    )) {
      return NextResponse.json({ error: 'Invalid chunk parameters.' }, { status: 400 });
    }

    // Cheap up-front rejection before we stream a single byte (cumulative for chunked mode).
    const declared = Number(req.headers.get('content-length') || 0);
    const priorBytes = isChunked ? chunkOffset : 0;
    if (declared && priorBytes + declared > MAX_BYTES) {
      return NextResponse.json({ error: `File exceeds the ${MAX_UPLOAD_MB}MB upload limit.` }, { status: 413 });
    }
    if (!req.body) {
      return NextResponse.json({ error: 'No file body received.' }, { status: 400 });
    }

    const destDir = destination === 'unmatched' ? UNMATCHED_DIR : WATCHED_DIR;
    await fs.ensureDir(destDir);

    // Path-traversal backstop: the resolved destination must live inside one of the two drop dirs.
    const finalPath = path.join(destDir, safeName);
    if (!isPathWithinRoots(finalPath, [WATCHED_DIR, UNMATCHED_DIR])) {
      return NextResponse.json({ error: 'Invalid destination path.' }, { status: 400 });
    }

    // Opportunistic hygiene: abandoned chunk sessions (browser closed mid-upload) leave .part
    // files behind. Sweep ones older than 24h whenever a fresh upload starts — cheap readdir,
    // and .part files are invisible to watched-sync so a sweep can never race an import.
    if (!isChunked || chunkIndex === 0) {
      try {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        sweepSessions(cutoff);
        for (const entry of await fs.readdir(destDir)) {
          if (!entry.startsWith('.upload-') || !entry.endsWith('.part')) continue;
          const p = path.join(destDir, entry);
          const st = await fs.stat(p).catch(() => null);
          if (st && st.mtimeMs < cutoff) await fs.remove(p).catch(() => {});
        }
      } catch { /* best effort */ }
    }

    // Stream to a hidden ".part" sibling on the same volume. watched-sync only matches
    // cbz/cbr/zip/rar/cb7 extensions, so a concurrent sync never grabs the partial; once the body
    // is fully written we rename into place (same-dir rename = atomic, no EXDEV across volumes).
    // Chunked mode uses a DETERMINISTIC name (uploadId) so every chunk appends to the same file;
    // single-shot keeps the timestamped name.
    tmpPath = path.join(destDir, isChunked ? `.upload-${uploadId}-${safeName}.part` : `.upload-${Date.now()}-${safeName}.part`);

    if (isChunked) {
      sessionId = uploadId;
      // Offset verification makes retries/reordering harmless. The process's own append
      // accounting is authoritative (NFS attribute caches serve stale stat() sizes for seconds —
      // field bug 2026-07-27); the open()-based probe only covers a mid-upload server restart.
      if (chunkIndex === 0) {
        // A fresh session (or a clean retry of chunk 0) always starts from zero.
        dropSession(uploadId);
        if (await fs.pathExists(tmpPath)) await fs.remove(tmpPath).catch(() => {});
      } else {
        const verdict = await verifyChunkOffset({
          chunkOffset,
          sessionTotal: sessionBytes(uploadId),
          probe: () => freshFileSize(tmpPath as string),
        });
        if (!verdict.ok) {
          // Leave the .part alone (the age sweep collects it); the client restarts the file.
          dropSession(uploadId);
          tmpPath = null;
          return NextResponse.json(
            { error: `Upload session out of sync (expected offset ${chunkOffset}, have ${verdict.have}). Retry the file.` },
            { status: 409 },
          );
        }
      }
    }

    let bytes = 0;
    let tooLarge = false;
    const counter = new Transform({
      transform(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null, data?: Buffer) => void) {
        bytes += chunk.length;
        if (priorBytes + bytes > MAX_BYTES) {
          tooLarge = true;
          cb(new Error('UPLOAD_TOO_LARGE'));
          return;
        }
        cb(null, chunk);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(req.body as unknown as NodeWebReadableStream),
        counter,
        fs.createWriteStream(tmpPath, isChunked && chunkIndex > 0 ? { flags: 'a' } : undefined),
      );
    } catch (streamErr) {
      if (isChunked) dropSession(uploadId);
      await fs.remove(tmpPath).catch(() => {});
      tmpPath = null;
      if (tooLarge) {
        return NextResponse.json({ error: `File exceeds the ${MAX_UPLOAD_MB}MB upload limit.` }, { status: 413 });
      }
      throw streamErr;
    }

    // The authoritative record of how far this session has gotten — offset checks for the next
    // chunk read THIS, never the NAS's (possibly stale) idea of the file size.
    if (isChunked) noteChunkAppended(uploadId, priorBytes + bytes);

    // Non-final chunk: acknowledge and wait for the rest. tmpPath is nulled so the catch-all
    // cleanup can't delete a live session.
    if (isChunked && chunkIndex < totalChunks - 1) {
      tmpPath = null;
      return NextResponse.json({ success: true, chunkIndex, bytes: priorBytes + bytes });
    }

    const totalBytes = priorBytes + bytes;
    if (totalBytes === 0) {
      if (isChunked) dropSession(uploadId);
      await fs.remove(tmpPath).catch(() => {});
      tmpPath = null;
      return NextResponse.json({ error: 'Empty file.' }, { status: 400 });
    }

    // Final gate for chunked assemblies: the on-disk size must equal what the session
    // accumulated across requests, or the storage backend lost bytes — a truncated comic must
    // never rename into the drop folder (it would import as a corrupt archive).
    if (isChunked) {
      const check = await verifyAssembledSize(totalBytes, () => freshFileSize(tmpPath as string));
      dropSession(uploadId);
      if (!check.ok) {
        await fs.remove(tmpPath).catch(() => {});
        tmpPath = null;
        Logger.log(`[Upload] Assembled size mismatch for ${safeName}: expected ${totalBytes}, on disk ${check.have ?? 'missing'} — rejecting.`, 'error');
        return NextResponse.json(
          { error: `Assembled file is ${check.have ?? 0} bytes but ${totalBytes} were uploaded — the storage backend dropped data. Retry the file.` },
          { status: 500 },
        );
      }
    }

    // Resolve collisions only after a successful write, then move into place.
    const targetPath = await resolveUniquePath(destDir, safeName);
    await fs.move(tmpPath, targetPath, { overwrite: false });
    tmpPath = null;
    const finalName = path.basename(targetPath);

    await AuditLogger.log('MANUAL_UPLOAD', { filename: finalName, destination, bytes: totalBytes, requestId, ...(isChunked ? { chunks: totalChunks } : {}) }, userId);
    Logger.log(`[Upload] Manual upload: ${finalName} -> ${destination} (${totalBytes} bytes${isChunked ? `, ${totalChunks} chunk(s)` : ''})`, 'info');

    return NextResponse.json({ success: true, filename: finalName, destination });
  } catch (error: unknown) {
    if (sessionId) dropSession(sessionId);
    if (tmpPath) await fs.remove(tmpPath).catch(() => {});
    Logger.log(`[Upload] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
