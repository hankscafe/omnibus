// src/app/api/library/cover/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

// --- FIXED: Added metron.cloud and static.metron.cloud to the strict whitelist ---
const ALLOWED_METADATA_HOSTS = ['comicvine.gamespot.com', 'mangadex.org', 'uploads.mangadex.org', 'metron.cloud', 'static.metron.cloud'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');

  if (!filePath) return new Response("Missing path", { status: 400 });

  try {
    // 1. SSRF MITIGATION: Validate External URLs
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        const url = new URL(filePath);
        
        // --- FIXED: Expanded to allow ComicVine, Gamespot, AND Metron Cloud CDNs ---
        const isAllowedHost = ALLOWED_METADATA_HOSTS.includes(url.hostname) || 
                              url.hostname.includes('comicvine') || 
                              url.hostname.includes('cbsistatic.com') ||
                              url.hostname.includes('gamespot.com') ||
                              url.hostname.includes('metron.cloud');

        if (!isAllowedHost) {
            return new Response("Forbidden: Untrusted Host", { status: 403 });
        }

        const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.|0\.|169\.254\.)/.test(url.hostname);
        if (isPrivate) return new Response("Forbidden: Internal Address", { status: 403 });

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); 

            const imgRes = await fetch(filePath, {
                signal: controller.signal,
                headers: { 'User-Agent': 'Omnibus/1.0' }
            });
            clearTimeout(timeoutId);

            if (!imgRes.ok) throw new Error(`Status ${imgRes.status}`);
            
            const contentLength = parseInt(imgRes.headers.get('content-length') || '0');
            if (contentLength > MAX_IMAGE_SIZE) return new Response("File too large", { status: 413 });

            const buffer = await imgRes.arrayBuffer();
            return new NextResponse(buffer, {
                headers: {
                    'Content-Type': imgRes.headers.get('content-type') || 'image/jpeg',
                    'Cache-Control': 'public, max-age=86400'
                }
            });
        } catch (e) {
            // Return fallback image on fetch failure
            return NextResponse.redirect(new URL('/favicon.ico', request.url));
        }
    }

    // 2. PATH TRAVERSAL FIX
    const realTarget = fs.realpathSync(filePath);
    const libraries = await prisma.library.findMany();
    
    const isAuthorized = libraries.some(lib => {
        const realLibRoot = fs.realpathSync(lib.path);
        return realTarget.startsWith(realLibRoot);
    });

    if (!isAuthorized) {
      return new Response("Unauthorized", { status: 403 });
    }

    if (!fs.existsSync(realTarget)) {
        // Return fallback image on file missing
        return NextResponse.redirect(new URL('/favicon.ico', request.url));
    }

    const ext = path.extname(realTarget).toLowerCase();
    const buffer = fs.readFileSync(realTarget);
    
    return new NextResponse(buffer, { 
        headers: { 
            'Content-Type': ext === '.png' ? 'image/png' : 'image/jpeg',
            'Cache-Control': 'public, max-age=86400'
        } 
    });
    
  } catch (error) {
    Logger.log(`Cover Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.redirect(new URL('/favicon.ico', request.url));
  }
}