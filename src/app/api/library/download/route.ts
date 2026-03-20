import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');

  if (!filePath) return new Response("Missing path parameter", { status: 400 });

  try {
    // NATIVE DB FETCH: Get all configured libraries to authorize the path
    const libraries = await prisma.library.findMany();
    const authorizedRoots = libraries.map(l => path.normalize(l.path).toLowerCase());
    const targetPath = path.normalize(filePath).toLowerCase();

    const isAuthorized = authorizedRoots.some(root => targetPath.startsWith(root));

    if (!isAuthorized) {
      return new Response("Unauthorized path access", { status: 403 });
    }

    if (!fs.existsSync(filePath)) {
      return new Response("File not found on network share", { status: 404 });
    }

    const stat = fs.statSync(filePath);
    const fileName = path.basename(filePath);

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

  } catch (error: unknown) {
    Logger.log(`Download Error: ${getErrorMessage(error)}`, 'error');

    return new Response("Failed to download file", { status: 500 });
  }
}