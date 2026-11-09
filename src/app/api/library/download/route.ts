import fs from 'fs';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { isPathWithinRoots } from '@/lib/utils/paths';
import { rememberKoreaderDocumentForPath } from '@/lib/koreader-documents';
import { sendFileResponse } from '@/lib/file-download';
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
    const userId = session?.user?.id;
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
    if (!isPathWithinRoots(filePath, libraries.map(l => l.path))) {
      return new Response("Unauthorized path access", { status: 403 });
    }

    if (!fs.existsSync(filePath)) {
      return new Response("File not found on network share", { status: 404 });
    }

    // A book downloaded here and copied to a KOReader device syncs to its issue too: record KOReader's
    // document IDs for these bytes when the path is an issue's file (#211). Never fails the download.
    await rememberKoreaderDocumentForPath(filePath);

    // Same response shape as the OPDS acquisition download (#219, #220): the media type comes from
    // the extension, Content-Disposition is RFC 6266, and Range is honoured.
    return sendFileResponse(request, filePath);

  } catch (error: unknown) {
    Logger.log(`Download Error: ${getErrorMessage(error)}`, 'error');

    return new Response("Failed to download file", { status: 500 });
  }
}