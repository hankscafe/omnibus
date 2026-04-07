// src/app/api/library/cover/route.ts
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
    // --- FIX 1: Proxy External URLs to bypass hotlinking protection ---
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        try {
            const imgRes = await fetch(filePath, {
                headers: { 
                    'User-Agent': 'Omnibus/1.0',
                    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
                }
            });
            if (!imgRes.ok) throw new Error(`Status ${imgRes.status}`);
            
            const buffer = await imgRes.arrayBuffer();
            const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
            
            return new NextResponse(buffer, {
                headers: {
                    'Content-Type': contentType,
                    'Cache-Control': 'public, max-age=86400, stale-while-revalidate=43200'
                }
            });
        } catch (e) {
            Logger.log(`External Image Fetch Failed: ${getErrorMessage(e)}`, 'warn');
            return new Response("External Image Fetch Failed", { status: 500 });
        }
    }

    // --- LOCAL FILE LOGIC ---
    // NATIVE DB FETCH: Get all configured libraries to authorize the path
    const libraries = await prisma.library.findMany();
    
    // --- FIX 2: Bulletproof Path Check to fix broken local covers ---
    const cleanTarget = filePath.replace(/\\/g, '/').toLowerCase();
    const isAuthorized = libraries.some(lib => {
        let cleanRoot = lib.path.replace(/\\/g, '/').toLowerCase();
        if (!cleanRoot.endsWith('/')) cleanRoot += '/';
        return cleanTarget === cleanRoot || cleanTarget.startsWith(cleanRoot);
    });

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