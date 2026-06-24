// src/app/api/library/archive-cover/route.ts
//
// Admin-only, read-only: returns the FIRST page of a comic archive as a small cover-sized JPEG.
// The Smart Matcher metadata editor calls this to preview a loose file's OWN cover art, so an admin
// can opt to use it as the issue cover instead of waiting on the metadata provider.
//
// Pure-Node extraction (no Rust engine): we extract the first page IN-PROCESS, mirroring the
// multi-format logic the converter uses — adm-zip for .cbz/.zip (and zip-in-disguise .cbr), the
// `unrar` CLI for genuine .cbr/.rar, and `unar` for .cb7/.7z — then resize/re-encode with sharp.
// Locked to library roots + the unmatched dir (where loose files live). If nothing extracts, the
// UI falls back to an upload or the provider's cover.
import { NextResponse } from 'next/server';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { isPathWithinRoots, UNMATCHED_DIR } from '@/lib/utils/paths';
import { IMAGE_EXT_REGEX } from '@/lib/utils/formats';

const execFileAsync = promisify(execFile);

// Reads the leading magic bytes of a file; returns an empty buffer on any failure.
// Mirrors converter.ts so a ZIP-in-disguise .cbr is routed to adm-zip, not unrar.
async function readFileSignature(filePath: string): Promise<Buffer> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fsp.open(filePath, 'r');
    const buffer = Buffer.alloc(4);
    await fd.read(buffer, 0, 4, 0);
    return buffer;
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

// Natural/alphabetical sort identical to converter.ts so the chosen page matches the reader.
function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// True for archive entry names that are real image pages (skips macOS junk + AppleDouble files).
function isImagePage(name: string): boolean {
  if (!IMAGE_EXT_REGEX.test(name)) return false;
  if (name.toLowerCase().includes('__macosx')) return false;
  const base = name.split(/[/\\]/).pop() || name;
  if (base.startsWith('._')) return false;
  return true;
}

// First natural-sorted image page out of a zip-based archive (.cbz/.zip or zip-in-disguise .cbr).
function firstImageFromZip(filePath: string): { buffer: Buffer; ext: string } | null {
  const zip = new AdmZip(filePath);
  const names = zip
    .getEntries()
    .filter((e) => !e.isDirectory && isImagePage(e.entryName))
    .map((e) => e.entryName)
    .sort(naturalSort);

  const first = names[0];
  if (!first) return null;

  const entry = zip.getEntry(first);
  if (!entry) return null;

  return { buffer: entry.getData(), ext: path.extname(first).slice(1).toLowerCase() };
}

// Recursively collect image-page paths under a directory (post-extraction discovery).
async function findImages(dir: string, out: string[] = []): Promise<string[]> {
  const items = await fsp.readdir(dir, { withFileTypes: true });
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      await findImages(full, out);
    } else if (isImagePage(item.name)) {
      out.push(full);
    }
  }
  return out;
}

// First image of a RAR-family archive via the `unrar` CLI, matching converter.ts's binary + flags.
// Targeted extraction: list bare entries (`lb`), pick the first image, extract ONLY that one file.
// The exit code is never trusted (vintage RAR 2.0 quirks); success is judged by what landed on disk.
async function firstImageFromRar(filePath: string): Promise<{ buffer: Buffer; ext: string } | null> {
  const execOpts = { maxBuffer: 10 * 1024 * 1024 };
  const tempDir = path.join(os.tmpdir(), `omnibus_cover_${crypto.randomBytes(8).toString('hex')}`);

  // List bare entry paths. Salvage stdout even on a non-zero exit (parity with converter.ts) — an
  // empty listing means "not a unrar-readable RAR" (e.g. a real 7z), so fall through to unar.
  let listing: string | null = null;
  try {
    const { stdout } = await execFileAsync('unrar', ['lb', '-p-', filePath], execOpts);
    listing = typeof stdout === 'string' && stdout.trim() !== '' ? stdout : null;
  } catch (err: unknown) {
    const stdout = (err as { stdout?: string })?.stdout;
    listing = typeof stdout === 'string' && stdout.trim() !== '' ? stdout : null;
  }

  let target: string | null = null;
  if (listing !== null) {
    target = listing
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && isImagePage(l))
      .sort(naturalSort)[0] ?? null;
    // A readable RAR with no image pages: a full extraction wouldn't find any either.
    if (target === null) return null;
  }

  await fsp.mkdir(tempDir, { recursive: true });
  try {
    if (target !== null) {
      // Extract just that entry, flattened into tempDir. `--` ends switch parsing so a name
      // beginning with '-' isn't read as a flag. `-y -o+ -p- -idq` mirror converter.ts.
      try {
        await execFileAsync(
          'unrar',
          ['e', '-y', '-o+', '-p-', '-idq', '--', filePath, target, `${tempDir}${path.sep}`],
          execOpts,
        );
      } catch {
        // Ignore the exit code; success is judged by what actually landed below.
      }
    } else {
      // unrar couldn't list it (genuine 7z or odd input) — full native extraction via unar.
      try {
        await execFileAsync('unar', ['-q', '-p', '', '-o', tempDir, '-f', '-D', filePath], execOpts);
      } catch (unarErr: unknown) {
        const e = unarErr as { code?: string; stderr?: string; message?: string };
        const detail =
          e?.code === 'ENOENT'
            ? 'unar binary not found on PATH (is it installed in this environment?)'
            : e?.stderr || e?.message || 'Unknown CLI error';
        throw new Error(`Native extraction failed: ${detail}`);
      }
    }

    const images = (await findImages(tempDir)).sort(naturalSort);
    const first = images[0];
    if (!first) return null;

    const buffer = await fsp.readFile(first);
    return { buffer, ext: path.extname(first).slice(1).toLowerCase() };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// First image of a 7z-family archive via the `unar` CLI, matching converter.ts's binary + flags.
async function firstImageFrom7z(filePath: string): Promise<{ buffer: Buffer; ext: string } | null> {
  const execOpts = { maxBuffer: 10 * 1024 * 1024 };
  const tempDir = path.join(os.tmpdir(), `omnibus_cover_${crypto.randomBytes(8).toString('hex')}`);

  await fsp.mkdir(tempDir, { recursive: true });
  try {
    try {
      await execFileAsync('unar', ['-q', '-p', '', '-o', tempDir, '-f', '-D', filePath], execOpts);
    } catch (unarErr: unknown) {
      const e = unarErr as { code?: string; stderr?: string; message?: string };
      const detail =
        e?.code === 'ENOENT'
          ? 'unar binary not found on PATH (is it installed in this environment?)'
          : e?.stderr || e?.message || 'Unknown CLI error';
      throw new Error(`Native extraction failed: ${detail}`);
    }

    const images = (await findImages(tempDir)).sort(naturalSort);
    const first = images[0];
    if (!first) return null;

    const buffer = await fsp.readFile(first);
    return { buffer, ext: path.extname(first).slice(1).toLowerCase() };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function POST(request: Request) {
  // Admin gate (mirrors src/app/api/library/repack/route.ts).
  const authOptions = await getAuthOptions();
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Input contract matches the engine route's `path` field; accept `filePath` as an alias.
  let filePath: string | undefined;
  try {
    const body = await request.json();
    filePath = body?.path ?? body?.filePath;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!filePath || typeof filePath !== 'string') {
    return NextResponse.json({ error: 'Missing file path' }, { status: 400 });
  }
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  try {
    // Range-check before touching the file: it must live under a library root or the unmatched dir
    // (where loose files awaiting a match live). Normalizes both sides so `..` can't escape a root.
    const libraries = await prisma.library.findMany();
    if (!isPathWithinRoots(filePath, [...libraries.map((l) => l.path), UNMATCHED_DIR])) {
      return NextResponse.json({ error: 'Unauthorized path access' }, { status: 403 });
    }

    const absolutePath = path.resolve(filePath);
    const ext = path.extname(absolutePath).slice(1).toLowerCase();

    // Extensions lie: .cbr files are frequently ZIPs in disguise. The real container format, sniffed
    // from the magic bytes, picks the decoder — never the extension alone (matches converter.ts).
    const signature = await readFileSignature(absolutePath);
    const isActuallyZip =
      signature.length >= 2 && signature[0] === 0x50 && signature[1] === 0x4b; // "PK"

    let extracted: { buffer: Buffer; ext: string } | null = null;
    if (ext === 'cbz' || ext === 'zip' || isActuallyZip) {
      extracted = firstImageFromZip(absolutePath);
    } else if (ext === 'cbr' || ext === 'rar') {
      extracted = await firstImageFromRar(absolutePath);
    } else if (ext === 'cb7' || ext === '7z') {
      extracted = await firstImageFrom7z(absolutePath);
    } else {
      return NextResponse.json({ error: 'Unsupported archive format' }, { status: 400 });
    }

    if (!extracted || extracted.buffer.length === 0) {
      // No readable page — the dialog treats this as "no archive cover" and falls back.
      Logger.log(`[Archive Cover] No extractable page in ${absolutePath}`, 'debug');
      return NextResponse.json({ error: 'No archive cover' }, { status: 404 });
    }

    // Downscale to a cover thumbnail and re-encode to JPEG — it's both the preview and the bytes that
    // get saved to <issueId>.jpg if the admin keeps it, so JPEG matches the stored extension.
    let body: Buffer = extracted.buffer;
    let contentType = 'image/jpeg';
    try {
      body = await sharp(extracted.buffer)
        .resize({ width: 500, withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
    } catch {
      // sharp couldn't decode it — serve the raw page so the admin at least sees something.
      const byExt: Record<string, string> = {
        png: 'image/png',
        webp: 'image/webp',
        gif: 'image/gif',
      };
      contentType = byExt[extracted.ext] || 'image/jpeg';
    }

    return new NextResponse(body as unknown as BodyInit, {
      headers: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=300' },
    });
  } catch (error: unknown) {
    Logger.log(
      `[Archive Cover] Failed to extract first page for ${filePath}: ${getErrorMessage(error)}`,
      'warn',
    );
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
