// src/app/api/trophies/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import fs from 'fs-extra';
import path from 'path';
import { Logger } from '@/lib/logger';
import { AuditLogger } from '@/lib/audit-logger';
import { CONFIG_DIR } from '@/lib/utils/paths';
import { getErrorMessage } from '@/lib/utils/error';

const ACTION_TYPES = new Set(['READ_COUNT', 'REQUEST_COUNT', 'PUBLISHER_COUNT']);
// The uploads route serves by extension and only knows these image types, so an icon is stored under
// the extension of what it actually is (it used to be `.png` whatever arrived, and an SVG data URL
// slipped past the prefix strip and was written as a corrupt file).
const ICON_TYPES: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

/** A whole number ≥ 1, from the form's string or the number the list returned. */
function parseTarget(value: unknown): number | null {
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (!/^\d+$/.test(text)) return null;
    const n = Number(text);
    return n >= 1 && Number.isSafeInteger(n) ? n : null;
}

export async function GET() {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    
    try {
        const trophies = await prisma.trophy.findMany({ orderBy: { targetValue: 'asc' } });
        return NextResponse.json(trophies);
    } catch (e) {
        Logger.log(`[Trophies API] Fetch Error: ${getErrorMessage(e)}`, 'error');
        return NextResponse.json({ error: "Failed to fetch trophies." }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const configDir = CONFIG_DIR;

    try {
        const { id, name: rawName, description, actionType, targetValue: rawTarget, iconBase64 } = await req.json();

        const name = typeof rawName === 'string' ? rawName.trim() : '';
        if (!name) return NextResponse.json({ error: "A trophy needs a name." }, { status: 400 });
        if (!ACTION_TYPES.has(actionType)) return NextResponse.json({ error: "Unknown action type." }, { status: 400 });
        const targetValue = parseTarget(rawTarget);
        if (targetValue === null) return NextResponse.json({ error: "The target milestone must be a whole number of 1 or more." }, { status: 400 });

        let icon: { ext: string; data: string } | null = null;
        if (iconBase64) {
            const match = typeof iconBase64 === 'string' ? /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(iconBase64) : null;
            const ext = match ? ICON_TYPES[match[1].toLowerCase()] : undefined;
            if (!match || !ext) return NextResponse.json({ error: "Icon must be a PNG, JPEG, WebP or GIF image." }, { status: 400 });
            icon = { ext, data: match[2] };
        }

        let iconUrl = undefined;
        if (icon) {
            // --- FIX: Saves trophy to /config/uploads/trophies ---
            const trophyDir = path.join(configDir, 'uploads', 'trophies');
            await fs.ensureDir(trophyDir);
            const fileName = `${Date.now()}${icon.ext}`;
            const filePath = path.join(trophyDir, fileName);
            await fs.writeFile(filePath, icon.data, 'base64');

            // --- FIX: Returns updated dynamic path so client can render it immediately ---
            iconUrl = `/api/uploads/trophies/${fileName}`;
        }

        if (id) {
            const data: any = { name, description, actionType, targetValue };
            if (iconUrl) data.iconUrl = iconUrl;
            const updated = await prisma.trophy.update({ where: { id }, data });

            await AuditLogger.log('UPDATE_TROPHY', { trophyId: updated.id, name }, session.user.id);
            return NextResponse.json(updated);
        } else {
            const created = await prisma.trophy.create({
                data: { name, description, actionType, targetValue, iconUrl }
            });
            
            await AuditLogger.log('CREATE_TROPHY', { trophyId: created.id, name }, session.user.id);
            return NextResponse.json(created);
        }
    } catch (e) {
        Logger.log(`[Trophies API] Create/Update Error: ${getErrorMessage(e)}`, 'error');
        return NextResponse.json({ error: "Failed to save trophy. Please check server logs." }, { status: 500 });
    }
}

export async function DELETE(req: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    
    try {
        const { searchParams } = new URL(req.url);
        const id = searchParams.get('id');
        if (id) {
            const trophy = await prisma.trophy.findUnique({ where: { id } });
            await prisma.trophy.delete({ where: { id } });
            await AuditLogger.log('DELETE_TROPHY', { trophyId: id, name: trophy?.name }, session.user.id);
        }
        return NextResponse.json({ success: true });
    } catch (e) {
        Logger.log(`[Trophies API] Delete Error: ${getErrorMessage(e)}`, 'error');
        return NextResponse.json({ error: "Failed to delete trophy." }, { status: 500 });
    }
}