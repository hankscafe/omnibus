import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Importer } from '@/lib/importer';
import { POST as triggerJob } from '@/app/api/admin/jobs/trigger/route'; 
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    try {
        const reqBody = (await request.json()) as any;
        const { torrentName, torrentId } = reqBody;
        
        let adminUser = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
        if (!adminUser) adminUser = await prisma.user.findFirst(); 
        
        // Create a dummy request to bridge with the existing Importer logic
        // FIXED: Removed seriesName as it doesn't exist on the Request Prisma model!
        const dbReq = await prisma.request.create({
            data: {
                userId: adminUser?.id || 'system',
                volumeId: "0", 
                status: "DOWNLOADING",
                progress: 100,
                activeDownloadName: torrentName,
                downloadLink: torrentId,
                imageUrl: ""
            }
        });

        const success = await Importer.importRequest(dbReq.id);
        if (!success) {
            // Cleanup dummy request if import fails entirely
            await prisma.request.delete({ where: { id: dbReq.id } });
            return NextResponse.json({ error: "Import failed to move file. Ensure path mappings are correct." }, { status: 500 });
        }

        try {
            const mockRequest = new Request('http://localhost/api/admin/jobs/trigger', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job: 'library' })
            });
            triggerJob(mockRequest).catch(() => {});
        } catch (e) {}

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}