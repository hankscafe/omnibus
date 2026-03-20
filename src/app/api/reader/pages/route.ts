import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { prisma } from '@/lib/db'; 
import { Logger } from '@/lib/logger';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');

  if (!filePath || !fs.existsSync(filePath)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  try {
    const libraries = await prisma.library.findMany();
    const authorizedRoots = libraries.map(l => path.normalize(l.path).toLowerCase());
    const targetPath = path.normalize(filePath).toLowerCase();

    const isAuthorized = authorizedRoots.some(root => targetPath.startsWith(root));
    if (!isAuthorized) {
      return NextResponse.json({ error: "Unauthorized path access" }, { status: 403 });
    }

    const isZip = filePath.toLowerCase().match(/\.(cbz|epub|zip)$/);
    const isRar = filePath.toLowerCase().match(/\.(cbr|rar)$/);

    if (isRar) {
        return NextResponse.json({ error: "This .cbr file is waiting to be automatically converted to .cbz. Please check back in a few minutes or run the CBR Auto-Converter job in Admin settings." }, { status: 400 });
    }
    
    if (!isZip) {
        return NextResponse.json({ error: "Unsupported file format." }, { status: 400 });
    }

    const zip = new AdmZip(filePath);
    const zipEntries = zip.getEntries();

    const pages = zipEntries
      .filter(entry => {
        const name = entry.entryName.toLowerCase();
        return !entry.isDirectory && !name.includes('__macosx') && 
               (name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.webp'));
      })
      .map(entry => entry.entryName);

    pages.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    return NextResponse.json({ pages });
  } catch (error: any) {
    Logger.log(`Archive Read Error: ${error.message}`, 'error');
    return NextResponse.json({ error: "Failed to read archive" }, { status: 500 });
  }
}