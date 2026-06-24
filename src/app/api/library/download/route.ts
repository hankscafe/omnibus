import fs from 'fs';
import path from 'path';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path');

  if (!filePath) return new Response("Missing path parameter", { status: 400 });

  try {
    // Enforce the download permission server-side — UI gating alone lets any
    // authenticated user fetch files by path. Fresh DB lookup (not the JWT)
    // so revoking the permission takes effect immediately.
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);

    let user = null;
    const userId = (session?.user as any)?.id;
    if (userId) {
        user = await prisma.user.findUnique({ where: { id: userId } });
    } else if (session?.user?.email) {
        user = await prisma.user.findUnique({ where: { email: session.user.email } });
    }

    if (!user) return new Response("Unauthorized", { status: 401 });

    const canDownload = user.role === 'ADMIN' || user.canDownload === true;
    if (!canDownload) {
        return new Response("Forbidden: You do not have permission to download files.", { status: 403 });
    }
    // NATIVE DB FETCH: Get all configured libraries to authorize the path
    const libraries = await prisma.library.findMany();
    const authorizedRoots = libraries.map(l => path.normalize(l.path).toLowerCase());
    const targetPath = path.normalize(filePath).toLowerCase();

    const isAuthorized = authorizedRoots.some(root => 
    targetPath === root || targetPath.startsWith(root + path.sep)
    );

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