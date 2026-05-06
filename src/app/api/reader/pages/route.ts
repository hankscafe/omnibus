import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { prisma } from '@/lib/db'; 
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');

  Logger.log(`[Reader Debug] Page extraction requested for physical path: ${filePath}`, 'debug');

  if (!filePath || !fs.existsSync(filePath)) {
    Logger.log(`[Reader Debug] File not found on disk.`, 'debug');
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  try {
    const libraries = await prisma.library.findMany();
    
    // BULLETPROOF PATH CHECK
    const cleanTarget = filePath.replace(/\\/g, '/').toLowerCase();
    
    const isAuthorized = libraries.some(lib => {
        let cleanRoot = lib.path.replace(/\\/g, '/').toLowerCase();
        if (!cleanRoot.endsWith('/')) cleanRoot += '/';
        const match = cleanTarget === cleanRoot || cleanTarget.startsWith(cleanRoot);
        if (match) Logger.log(`[Reader Debug] Path authorized via library match: ${lib.name} (${cleanRoot})`, 'debug');
        return match;
    });
    
    if (!isAuthorized) {
      Logger.log(`[Reader Debug] Access denied. Path is outside of configured library roots: ${cleanTarget}`, 'warn');
      return NextResponse.json({ error: "Unauthorized path access" }, { status: 403 });
    }

    const isZip = filePath.toLowerCase().match(/\.(cbz|epub|zip)$/);
    const isRar = filePath.toLowerCase().match(/\.(cbr|rar)$/);

    if (isRar) {
        Logger.log(`[Reader Debug] Extraction failed: Unsupported CBR format requested.`, 'debug');
        return NextResponse.json({ error: "This .cbr file is waiting to be automatically converted to .cbz. Please check back in a few minutes or run the CBR Auto-Converter job in Admin settings." }, { status: 400 });
    }
    
    if (!isZip) {
        Logger.log(`[Reader Debug] Extraction failed: Unsupported file extension.`, 'debug');
        return NextResponse.json({ error: "Unsupported file format." }, { status: 400 });
    }

    Logger.log(`[Reader Debug] Initiating AdmZip extraction...`, 'debug');
    const zip = new AdmZip(filePath);
    const zipEntries = zip.getEntries();
    Logger.log(`[Reader Debug] Archive contains ${zipEntries.length} total raw entries. Filtering for valid images...`, 'debug');

    const pages = zipEntries
      .filter(entry => {
        const name = entry.entryName.toLowerCase();
        return !entry.isDirectory && !name.includes('__macosx') && 
               (name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.webp'));
      })
      .map(entry => entry.entryName);

    pages.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    Logger.log(`[Reader Debug] Successfully extracted and sorted ${pages.length} readable image pages.`, 'debug');
    return NextResponse.json({ pages });
  } catch (error: unknown) {
    Logger.log(`[Reader Debug] Archive processing threw an exception: ${getErrorMessage(error)}`, 'debug');
    Logger.log(`Archive Read Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: "Failed to read archive" }, { status: 500 });
  }
}