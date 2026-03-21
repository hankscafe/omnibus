import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import fs from 'fs-extra';
import path from 'path';
import { Logger } from '@/lib/logger';

export async function GET() {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    
    try {
        const trophies = await prisma.trophy.findMany({ orderBy: { targetValue: 'asc' } });
        return NextResponse.json(trophies);
    } catch (e: any) {
        Logger.log(`[Trophies API] Fetch Error: ${e.message}`, 'error');
        return NextResponse.json({ error: "Failed to fetch trophies." }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { id, name, description, actionType, targetValue, iconBase64 } = await req.json();

        let iconUrl = undefined;
        if (iconBase64) {
            const trophyDir = path.join(process.cwd(), 'public', 'trophies');
            await fs.ensureDir(trophyDir);
            const fileName = `${Date.now()}.png`;
            const filePath = path.join(trophyDir, fileName);
            const base64Data = iconBase64.replace(/^data:image\/\w+;base64,/, "");
            await fs.writeFile(filePath, base64Data, 'base64');
            iconUrl = `/trophies/${fileName}`;
        }

        if (id) {
            const data: any = { name, description, actionType, targetValue: parseInt(targetValue) };
            if (iconUrl) data.iconUrl = iconUrl;
            const updated = await prisma.trophy.update({ where: { id }, data });
            return NextResponse.json(updated);
        } else {
            const created = await prisma.trophy.create({
                data: { name, description, actionType, targetValue: parseInt(targetValue), iconUrl }
            });
            return NextResponse.json(created);
        }
    } catch (e: any) {
        // --- SECURITY FIX 1b: Log real error, hide from client ---
        Logger.log(`[Trophies API] Create/Update Error: ${e.message}`, 'error');
        return NextResponse.json({ error: "Failed to save trophy. Please check server logs." }, { status: 500 });
    }
}

export async function DELETE(req: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    
    try {
        const { searchParams } = new URL(req.url);
        const id = searchParams.get('id');
        if (id) await prisma.trophy.delete({ where: { id } });
        return NextResponse.json({ success: true });
    } catch (e: any) {
        Logger.log(`[Trophies API] Delete Error: ${e.message}`, 'error');
        return NextResponse.json({ error: "Failed to delete trophy." }, { status: 500 });
    }
}