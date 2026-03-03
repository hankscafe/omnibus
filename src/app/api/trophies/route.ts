import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import fs from 'fs-extra';
import path from 'path';

export async function GET() {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const trophies = await prisma.trophy.findMany({ orderBy: { targetValue: 'asc' } });
    return NextResponse.json(trophies);
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
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function DELETE(req: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (id) await prisma.trophy.delete({ where: { id } });
    return NextResponse.json({ success: true });
}