import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { prisma } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');

  if (!filePath) return new Response("Missing path", { status: 400 });

  try {
    const configSetting = await prisma.systemSetting.findMany({ 
        where: { key: { in: ['library_path', 'manga_library_path'] } } 
    });
    const config = Object.fromEntries(configSetting.map(s => [s.key, s.value]));

    const libRoot = (config.library_path && config.library_path.trim() !== '') ? path.normalize(config.library_path).toLowerCase() : null;
    const mangaRoot = (config.manga_library_path && config.manga_library_path.trim() !== '') ? path.normalize(config.manga_library_path).toLowerCase() : null;
    const targetPath = path.normalize(filePath).toLowerCase();

    const isAuthorized = (libRoot && targetPath.startsWith(libRoot)) || (mangaRoot && targetPath.startsWith(mangaRoot));

    if (!isAuthorized) {
      return new Response("Unauthorized", { status: 403 });
    }

    if (!fs.existsSync(filePath)) return new Response("Not Found", { status: 404 });

    let finalPath = filePath;
    const stat = fs.statSync(filePath);
    
    // --- DEFERRED DISK CHECK ---
    // If the library page handed us a folder, look for the cover inside it!
    if (stat.isDirectory()) {
        const possibleCovers = ['cover.jpg', 'cover.png', 'folder.jpg', 'poster.jpg'];
        let found = false;
        for (const coverName of possibleCovers) {
            const testPath = path.join(filePath, coverName);
            if (fs.existsSync(testPath)) {
                finalPath = testPath;
                found = true;
                break;
            }
        }
        if (!found) return new Response("Not Found", { status: 404 });
    }

    // Determine content type dynamically
    const ext = path.extname(finalPath).toLowerCase();
    let contentType = 'image/jpeg';
    if (ext === '.png') contentType = 'image/png';
    if (ext === '.webp') contentType = 'image/webp';

    const buffer = fs.readFileSync(finalPath);
    
    return new NextResponse(buffer, { 
        headers: { 
            'Content-Type': contentType,
            // Cache aggressively in the browser for 24 hours to eliminate future load times
            'Cache-Control': 'public, max-age=86400, stale-while-revalidate=43200' 
        } 
    });
    
  } catch (error) {
    console.error("Cover Error:", error);
    return new Response("Error", { status: 500 });
  }
}