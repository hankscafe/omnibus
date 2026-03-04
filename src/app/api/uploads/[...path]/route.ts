import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
    // Reconstruct the file path: public/avatars/filename.jpg
    const filePath = path.join(process.cwd(), 'public', ...params.path);

    if (!fs.existsSync(filePath)) {
        return new NextResponse("Image not found", { status: 404 });
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