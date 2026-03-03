import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { prisma } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');

  if (!filePath) return new Response("Missing path parameter", { status: 400 });

  try {
    // Security verification
    const configSetting = await prisma.systemSetting.findMany({ 
        where: { key: { in: ['library_path', 'manga_library_path'] } } 
    });
    const config = Object.fromEntries(configSetting.map(s => [s.key, s.value]));

    const libRoot = (config.library_path && config.library_path.trim() !== '') ? path.normalize(config.library_path).toLowerCase() : null;
    const mangaRoot = (config.manga_library_path && config.manga_library_path.trim() !== '') ? path.normalize(config.manga_library_path).toLowerCase() : null;
    const targetPath = path.normalize(filePath).toLowerCase();

    const isAuthorized = (libRoot && targetPath.startsWith(libRoot)) || (mangaRoot && targetPath.startsWith(mangaRoot));

    if (!isAuthorized) {
      return new Response("Unauthorized path access", { status: 403 });
    }

    if (!fs.existsSync(filePath)) {
      return new Response("File not found on network share", { status: 404 });
    }

    const stat = fs.statSync(filePath);
    const fileName = path.basename(filePath);

    // Convert standard Node stream into Web ReadableStream for Next.js
    const stream = fs.createReadStream(filePath);
    const readableStream = new ReadableStream({
        start(controller) {
            stream.on('data', (chunk) => controller.enqueue(chunk));
            stream.on('end', () => controller.close());
            stream.on('error', (err) => controller.error(err));
        },
        cancel() { stream.destroy(); }
    });

    return new Response(readableStream, {
        headers: {
            'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
            'Content-Type': 'application/vnd.comicbook+zip',
            'Content-Length': stat.size.toString()
        }
    });

  } catch (error: any) {
    console.error("Download Error:", error);
    return new Response("Failed to download file", { status: 500 });
  }
}