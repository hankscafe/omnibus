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

    // Cheap up-front rejection before we stream a single byte.
    const declared = Number(req.headers.get('content-length') || 0);
    if (declared && declared > MAX_BYTES) {
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

    // Stream to a hidden ".part" sibling on the same volume. watched-sync only matches
    // cbz/cbr/zip/rar/cb7 extensions, so a concurrent sync never grabs the partial; once the body
    // is fully written we rename into place (same-dir rename = atomic, no EXDEV across volumes).
    tmpPath = path.join(destDir, `.upload-${Date.now()}-${safeName}.part`);
    let bytes = 0;
    let tooLarge = false;
    const counter = new Transform({
      transform(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null, data?: Buffer) => void) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          tooLarge = true;
          cb(new Error('UPLOAD_TOO_LARGE'));
          return;
        }
        cb(null, chunk);
      },
    });

    try {
      await pipeline(Readable.fromWeb(req.body as unknown as NodeWebReadableStream), counter, fs.createWriteStream(tmpPath));
    } catch (streamErr) {
      await fs.remove(tmpPath).catch(() => {});
      tmpPath = null;
      if (tooLarge) {
        return NextResponse.json({ error: `File exceeds the ${MAX_UPLOAD_MB}MB upload limit.` }, { status: 413 });
      }
      throw streamErr;
    }

    if (bytes === 0) {
      await fs.remove(tmpPath).catch(() => {});
      tmpPath = null;
      return NextResponse.json({ error: 'Empty file.' }, { status: 400 });
    }

    // Resolve collisions only after a successful write, then move into place.
    const targetPath = await resolveUniquePath(destDir, safeName);
    await fs.move(tmpPath, targetPath, { overwrite: false });
    tmpPath = null;
    const finalName = path.basename(targetPath);

    await AuditLogger.log('MANUAL_UPLOAD', { filename: finalName, destination, bytes, requestId }, userId);
    Logger.log(`[Upload] Manual upload: ${finalName} -> ${destination} (${bytes} bytes)`, 'info');

    return NextResponse.json({ success: true, filename: finalName, destination });
  } catch (error: unknown) {
    if (tmpPath) await fs.remove(tmpPath).catch(() => {});
    Logger.log(`[Upload] Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
