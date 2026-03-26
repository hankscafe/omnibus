// src/app/api/opds/download/route.ts
import { prisma } from '@/lib/db';
import { validateApiKey } from '@/lib/api-auth';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    const auth = await validateApiKey(req);
    
    // 1. Authenticate the user via their OPDS API Key
    if (!auth.valid || !auth.user) {
        return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Omnibus OPDS"' } });
    }

    // 2. Strictly enforce the download permission
    const canDownload = auth.user.role === 'ADMIN' || auth.user.canDownload === true;
    if (!canDownload) {
        return new Response('Forbidden: You do not have permission to download full files.', { status: 403 });
    }

    const url = new URL(req.url);
    const issueId = url.searchParams.get('issueId');

    if (!issueId) return new Response("Missing issue ID", { status: 400 });

    try {
        const issue = await prisma.issue.findUnique({ where: { id: issueId } });

        if (!issue || !issue.filePath || !fs.existsSync(issue.filePath)) {
            return new Response("File not found on server", { status: 404 });
        }

        const stat = fs.statSync(issue.filePath);
        const fileName = path.basename(issue.filePath);

        // 3. Stream the file directly to the client app
        const stream = fs.createReadStream(issue.filePath);
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

    } catch (error) {
        return new Response("Failed to download file", { status: 500 });
    }
}