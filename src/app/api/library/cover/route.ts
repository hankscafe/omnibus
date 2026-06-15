// src/app/api/library/cover/route.ts
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

const ALLOWED_METADATA_HOSTS = ['comicvine.gamespot.com', 'mangadex.org', 'uploads.mangadex.org', 'metron.cloud', 'static.metron.cloud'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

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
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        const url = new URL(filePath);
        
        const host = url.hostname.toLowerCase();
        // Exact host or a subdomain of an allowed registrable domain — NOT a substring match
        // (e.g. 'metron.cloud.evil.tld' must not pass).
        const allowedSuffixes = ['gamespot.com', 'cbsistatic.com', 'metron.cloud', 'mangadex.org'];
        const isAllowedHost = ALLOWED_METADATA_HOSTS.includes(host) ||
                              allowedSuffixes.some(s => host === s || host.endsWith('.' + s));

        if (!isAllowedHost) {
            return new Response("Forbidden: Untrusted Host", { status: 403 });
        }

        const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.|0\.|169\.254\.)/.test(url.hostname);
        if (isPrivate) return new Response("Forbidden: Internal Address", { status: 403 });

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000); 

            // --- FIX: Mimic a real browser to bypass Cloudflare blocks on Metron/ComicVine image requests
            const imgRes = await fetch(filePath, {
                signal: controller.signal,
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
                }
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
            return getFallbackImage();
        }
    }

    const realTarget = path.normalize(filePath);
    const libraries = await prisma.library.findMany();
    
    const isAuthorized = libraries.some(lib => {
        try {
            const realLibRoot = path.normalize(lib.path).toLowerCase();
            return realTarget.toLowerCase().startsWith(realLibRoot);
        } catch (e) {
            return false;
        }
    });

    if (!isAuthorized) {
      return getFallbackImage(); 
    }

    if (!fs.existsSync(realTarget)) {
        return getFallbackImage();
    }

    const stat = fs.statSync(realTarget);
    if (stat.isDirectory()) {
        const possibleCovers = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'Cover.jpg', 'Cover.png', 'folder.png'];
        for (const pc of possibleCovers) {
            const coverPath = path.join(realTarget, pc);
            if (fs.existsSync(coverPath)) {
                const buffer = fs.readFileSync(coverPath);
                const ext = path.extname(pc).toLowerCase();
                return new NextResponse(buffer, { 
                    headers: { 'Content-Type': ext === '.png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } 
                });
            }
        }
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
    return getFallbackImage();
  }
}