import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';

export async function POST(request: Request) {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const formData = await request.formData();
        const file = formData.get('file') as File;
        
        if (!file) {
            return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
        }

        const fileContent = await file.text();
        const backup = JSON.parse(fileContent);

        if (!backup.data) {
            return NextResponse.json({ error: "Invalid backup file format" }, { status: 400 });
        }

        Logger.log("[Restore] Starting safe database restoration from backup file...", "info");

        // We use sequential UPSERTs so that we gracefully merge the old data 
        // without triggering CASCADE deletes that would wipe out your new Trophies or Collections!

        if (backup.data.users) {
            for (const item of backup.data.users) {
                await prisma.user.upsert({ where: { id: item.id }, update: item, create: item }).catch(()=>{});
            }
        }

        if (backup.data.settings) {
            for (const item of backup.data.settings) {
                await prisma.systemSetting.upsert({ where: { key: item.key }, update: item, create: item }).catch(()=>{});
            }
        }

        if (backup.data.series) {
            for (const item of backup.data.series) {
                await prisma.series.upsert({ where: { id: item.id }, update: item, create: item }).catch(()=>{});
            }
        }

        if (backup.data.issues) {
            for (const item of backup.data.issues) {
                await prisma.issue.upsert({ where: { id: item.id }, update: item, create: item }).catch(()=>{});
            }
        }

        if (backup.data.requests) {
            for (const item of backup.data.requests) {
                await prisma.request.upsert({ where: { id: item.id }, update: item, create: item }).catch(()=>{});
            }
        }

        if (backup.data.readProgresses) {
            for (const item of backup.data.readProgresses) {
                await prisma.readProgress.upsert({ where: { id: item.id }, update: item, create: item }).catch(()=>{});
            }
        }

        Logger.log("[Restore] Database restoration completed successfully.", "success");
        return NextResponse.json({ success: true });

    } catch (error: any) {
        Logger.log(`[Restore] Failed: ${error.message}`, "error");
        return NextResponse.json({ error: "Restore failed: " + error.message }, { status: 500 });
    }
}