import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
    const resolvedParams = await params;
    const pathArray = resolvedParams.path;

    const baseDir = path.resolve(process.cwd(), 'public');
    const filePath = path.resolve(baseDir, ...pathArray);

    if (!filePath.startsWith(baseDir)) {
        return new NextResponse("Forbidden", { status: 403 });
    }

    if (!fs.existsSync(filePath)) {
        return new NextResponse("Image not found", { status: 404 });
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
        return new NextResponse("Forbidden", { status: 403 });
    }

    const extension = path.extname(filePath).toLowerCase();
    
    // Explicitly define Safe Image extensions
    const contentTypes: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
    };

    const contentType = contentTypes[extension];

    // --- SECURITY FIX 1c: Block unknown file types entirely ---
    if (!contentType) {
        return new NextResponse("Forbidden file type. Only recognized image extensions are allowed.", { status: 403 });
    }

    const fileBuffer = fs.readFileSync(filePath);

    return new NextResponse(fileBuffer, {
        headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000, immutable',
        },
    });
}