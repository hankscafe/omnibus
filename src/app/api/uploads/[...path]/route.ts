import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
    // 1. Establish the absolute safe base directory
    const baseDir = path.resolve(process.cwd(), 'public');
    
    // 2. Resolve the requested file path
    const filePath = path.resolve(baseDir, ...params.path);

    // 3. SECURITY CRITICAL: Ensure the resolved path strictly starts with the base directory.
    // Because path.resolve() evaluates all `../` segments, if the user tries to escape 
    // the public folder, the resulting path will no longer start with `baseDir`.
    if (!filePath.startsWith(baseDir)) {
        return new NextResponse("Forbidden", { status: 403 });
    }

    if (!fs.existsSync(filePath)) {
        return new NextResponse("Image not found", { status: 404 });
    }

    // 4. SECURITY: Ensure the target is actually a file, not a directory
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
        return new NextResponse("Forbidden", { status: 403 });
    }

    const fileBuffer = fs.readFileSync(filePath);
    const extension = path.extname(filePath).toLowerCase();
    
    // Set the correct Content-Type header
    const contentTypes: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
    };

    return new NextResponse(fileBuffer, {
        headers: {
            'Content-Type': contentTypes[extension] || 'application/octet-stream',
            'Cache-Control': 'public, max-age=31536000, immutable',
        },
    });
}