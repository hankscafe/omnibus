// src/app/api/library/cover/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

const ALLOWED_METADATA_HOSTS = ['comicvine.gamespot.com', 'mangadex.org', 'uploads.mangadex.org', 'metron.cloud', 'static.metron.cloud'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

// --- NEW: High-Resolution Scalable Vector Graphic (SVG) Fallback ---
// This generates a perfectly crisp, 2:3 aspect ratio placeholder matching the Omnibus branding
function getFallbackImage() {
    const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600">
        <rect width="100%" height="100%" fill="#0f172a"/>
        <defs>
            <mask id="slice-mask">
                <rect x="0" y="0" width="100%" height="100%" fill="white"/>
                <rect x="0" y="296" width="100%" height="6" fill="black"/>
            </mask>
        </defs>
        <g fill="#334155">
            <text x="200" y="320" font-family="Arial, sans-serif" font-size="60" font-weight="900" text-anchor="middle" letter-spacing="8" mask="url(#slice-mask)">OMNIBUS</text>
            <text x="200" y="345" font-family="Arial, sans-serif" font-size="10" font-weight="bold" text-anchor="middle" letter-spacing="4">YOUR UNIVERSE. ORGANIZED.</text>
        </g>
    </svg>`;
    
    return new NextResponse(svg.trim(), {
        headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'public, max-age=86400'
        }
    });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');

  if (!filePath) return new Response("Missing path", { status: 400 });

  try {
    // 1. SSRF MITIGATION: Validate External URLs
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        const url = new URL(filePath);
        
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
            // --- UPDATED: Return the high-res SVG fallback ---
            return getFallbackImage();
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
        // --- UPDATED: Return the high-res SVG fallback ---
        return getFallbackImage();
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
    // --- UPDATED: Return the high-res SVG fallback ---
    return getFallbackImage();
  }
}