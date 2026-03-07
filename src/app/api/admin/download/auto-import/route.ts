import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Importer } from '@/lib/importer';

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

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}