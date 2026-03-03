import { NextResponse } from 'next/server';
import fs from 'fs';
import AdmZip from 'adm-zip';

// Global cache to hold Zip instances in memory temporarily
// This prevents reading a 200MB file from disk on every single page turn
const zipCache = new Map<string, { zip: AdmZip, lastAccessed: number }>();

// Cleanup routine: Remove zip files from memory if untouched for 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [path, data] of Array.from(zipCache.entries())) {
        if (now - data.lastAccessed > 5 * 60 * 1000) {
            zipCache.delete(path);
        }
    }
}, 60000);

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');
  const pageName = searchParams.get('page');

  if (!filePath || !pageName || !fs.existsSync(filePath)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  try {
    // Check Cache first
    let zipInstance = zipCache.get(filePath)?.zip;
    
    if (!zipInstance) {
        zipInstance = new AdmZip(filePath);
        zipCache.set(filePath, { zip: zipInstance, lastAccessed: Date.now() });
    } else {
        // Update access time
        zipCache.set(filePath, { zip: zipInstance, lastAccessed: Date.now() });
    }

    const zipEntry = zipInstance.getEntry(pageName);

    if (!zipEntry) {
        return new NextResponse("Page Not Found", { status: 404 });
    }

    const buffer = zipEntry.getData();
    
    let contentType = 'image/jpeg';
    if (pageName.toLowerCase().endsWith('.png')) contentType = 'image/png';
    if (pageName.toLowerCase().endsWith('.webp')) contentType = 'image/webp';

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400', 
      },
    });
  } catch (error) {
    console.error("Image Extraction Error:", error);
    return new NextResponse("Server Error", { status: 500 });
  }
}