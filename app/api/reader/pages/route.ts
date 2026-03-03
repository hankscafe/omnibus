import { NextResponse } from 'next/server';
import fs from 'fs';
import AdmZip from 'adm-zip';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');

  if (!filePath || !fs.existsSync(filePath)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  try {
    // Note: This currently handles .cbz. For .cbr, you'd need a RAR library.
    if (!filePath.toLowerCase().endsWith('.cbz')) {
        return NextResponse.json({ error: "Currently only .cbz files are supported for web reading." }, { status: 400 });
    }

    const zip = new AdmZip(filePath);
    const zipEntries = zip.getEntries();

    // Filter for images and ignore hidden files/folders (like __MACOSX)
    const pages = zipEntries
      .filter(entry => {
        const name = entry.entryName.toLowerCase();
        return !entry.isDirectory && 
               !name.includes('__macosx') && 
               (name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.webp'));
      })
      .map(entry => entry.entryName)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })); // Smart alphanumeric sort

    return NextResponse.json({ pages });
  } catch (error: any) {
    console.error("Archive Read Error:", error);
    return NextResponse.json({ error: "Failed to read archive" }, { status: 500 });
  }
}