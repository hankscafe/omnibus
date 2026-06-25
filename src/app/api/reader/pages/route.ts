import { NextResponse } from 'next/server';
import fs from 'fs';
import AdmZip from 'adm-zip';
import { prisma } from '@/lib/db'; 
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { IMAGE_EXT_REGEX } from '@/lib/utils/formats';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { getAccessibleLibraryPaths, canAccessPath } from '@/lib/library-access';
import { isPathWithinRoots } from '@/lib/utils/paths';

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

    // Separator-safe containment so `..` / sibling-prefix paths can't escape a library root.
    if (!isPathWithinRoots(filePath, libraries.map(lib => lib.path))) {
      Logger.log(`[Reader Debug] Access denied. Path is outside of configured library roots: ${filePath}`, 'warn');
      return NextResponse.json({ error: "Unauthorized path access" }, { status: 403 });
    }

    // Per-library access: the file must live under a library THIS user has been granted (admins bypass),
    // matching reader/image. Without it, any authenticated user could enumerate the page entries of any
    // archive in any library — including ones they were never granted.
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const accessiblePaths = await getAccessibleLibraryPaths((session?.user as any)?.id, (session?.user as any)?.role);
    if (!canAccessPath(accessiblePaths, filePath)) {
      return NextResponse.json({ error: "You don't have access to this library." }, { status: 403 });
    }

    const isZip = filePath.toLowerCase().match(/\.(cbz|epub|zip)$/);
    const needsConversion = filePath.toLowerCase().match(/\.(cbr|rar|cb7)$/);

    if (needsConversion) {
        Logger.log(`[Reader Debug] Extraction failed: Archive format requires conversion to CBZ.`, 'debug');
        return NextResponse.json({ error: "This archive is waiting to be automatically converted to .cbz. Please check back in a few minutes or run the CBR Auto-Converter job in Admin settings." }, { status: 400 });
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
        return !entry.isDirectory && !name.includes('__macosx') && IMAGE_EXT_REGEX.test(name);
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