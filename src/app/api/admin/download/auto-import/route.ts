import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Importer } from '@/lib/importer';
import { POST as triggerJob } from '@/app/api/admin/jobs/trigger/route'; 

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    try {
        const { torrentName, torrentId } = await request.json();
        
        let adminUser = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
        if (!adminUser) adminUser = await prisma.user.findFirst(); 
        
        // Create a dummy request to bridge with the existing Importer logic
        const req = await prisma.request.create({
            data: {
                userId: adminUser?.id || 'system',
                seriesName: torrentName, 
                volumeId: "0", 
                status: "DOWNLOADING",
                progress: 100,
                activeDownloadName: torrentName,
                downloadLink: torrentId,
                imageUrl: ""
            }
        });

        const success = await Importer.importRequest(req.id);
        if (!success) {
            // Cleanup dummy request if import fails entirely
            await prisma.request.delete({ where: { id: req.id } });
            return NextResponse.json({ error: "Import failed to move file. Ensure path mappings are correct." }, { status: 500 });
        }

        // NEW: Immediately run a background library scan so the new folder is indexed into the DB!
        try {
            const mockRequest = new Request('http://localhost/api/admin/jobs/trigger', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job: 'library' })
            });
            triggerJob(mockRequest).catch(() => {});
        } catch (e) {}

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}