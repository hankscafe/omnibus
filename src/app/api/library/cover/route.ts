import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');

  if (!filePath) return new Response("Missing path", { status: 400 });

  try {
    // NATIVE DB FETCH: Get all configured libraries to authorize the path
    const libraries = await prisma.library.findMany();
    const authorizedRoots = libraries.map(l => path.normalize(l.path).toLowerCase());
    const targetPath = path.normalize(filePath).toLowerCase();

    const isAuthorized = authorizedRoots.some(root => 
    targetPath === root || targetPath.startsWith(root + path.sep)
    );

    if (!isAuthorized) {
      return new Response("Unauthorized", { status: 403 });
    }

    if (!fs.existsSync(filePath)) return new Response("Not Found", { status: 404 });

    let finalPath = filePath;
    const stat = fs.statSync(filePath);
    
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

    const ext = path.extname(finalPath).toLowerCase();
    let contentType = 'image/jpeg';
    if (ext === '.png') contentType = 'image/png';
    if (ext === '.webp') contentType = 'image/webp';

    const buffer = fs.readFileSync(finalPath);
    
    return new NextResponse(buffer, { 
        headers: { 
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400, stale-while-revalidate=43200' 
        } 
    });
    
  } catch (error) {
    Logger.log(`Cover Error: ${getErrorMessage(error)}`, 'error');

    return new Response("Error", { status: 500 });
  }
}