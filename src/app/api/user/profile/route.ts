// src/app/api/user/profile/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import fs from 'fs-extra';
import path from 'path';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';

export async function GET(req: Request) {
  const token = await getToken({ req: req as any });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const user = await prisma.user.findUnique({
        where: { id: token.id as string },
        select: { username: true, role: true, avatar: true, banner: true, createdAt: true } 
    });

    const requests = await prisma.request.findMany({
        where: { userId: token.id as string },
        orderBy: { createdAt: 'desc' }
    });

    const historyStats = await prisma.$transaction([
        prisma.readProgress.count({ where: { userId: token.id as string } }),
        prisma.readProgress.count({ where: { userId: token.id as string, isCompleted: true } })
    ]);

    const started = historyStats[0];
    const completed = historyStats[1];
    const completionRate = started > 0 ? Math.round((completed / started) * 100) : 0;

    const stats = {
        total: requests.length,
        active: requests.filter(r => ['DOWNLOADING', 'PENDING', 'MANUAL_DDL'].includes(r.status)).length,
        pendingApproval: requests.filter(r => r.status === 'PENDING_APPROVAL').length,
        completed: requests.filter(r => ['IMPORTED', 'COMPLETED'].includes(r.status)).length,
        failed: requests.filter(r => ['FAILED', 'STALLED', 'ERROR'].includes(r.status)).length,
        historyStarted: started,
        historyCompleted: completed,
        completionRate: completionRate
    };

    const recentProgresses = await prisma.readProgress.findMany({
        where: { userId: token.id as string },
        include: { issue: { include: { series: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 24 
    });

    const recentHistory = recentProgresses.map(rp => {
        const progressPct = rp.totalPages > 0 ? Math.round((rp.currentPage / rp.totalPages) * 100) : 0;
        const folderPath = rp.issue?.series?.folderPath;
        
        let seriesCoverUrl = (rp.issue?.series as any)?.coverUrl || null;
        if (seriesCoverUrl && seriesCoverUrl.startsWith('http')) {
            seriesCoverUrl = `/api/library/cover?path=${encodeURIComponent(seriesCoverUrl)}`;
        } else if (!seriesCoverUrl && folderPath) {
            seriesCoverUrl = `/api/library/cover?path=${encodeURIComponent(folderPath)}`;
        }
        
        return {
            id: rp.id,
            seriesName: rp.issue?.series?.name || "Unknown Series",
            issueNumber: rp.issue?.number || "?",
            progress: progressPct,
            isCompleted: rp.isCompleted || progressPct >= 100,
            updatedAt: rp.updatedAt,
            coverUrl: seriesCoverUrl,
            filePath: rp.issue?.filePath || "", 
            folderPath: folderPath || ""
        };
    });

    const allTrophies = await prisma.trophy.findMany({ orderBy: { targetValue: 'asc' } });
    const userTrophies = await prisma.userTrophy.findMany({ where: { userId: token.id as string } });
    const earnedTrophyIds = new Set(userTrophies.map(ut => ut.trophyId));
    
    const mappedTrophies = allTrophies.map(t => ({
        ...t,
        earned: earnedTrophyIds.has(t.id),
        earnedAt: userTrophies.find(ut => ut.trophyId === t.id)?.earnedAt || null
    }));

    return NextResponse.json({ 
        user, 
        stats, 
        recentRequests: requests.slice(0, 5), 
        recentHistory, 
        trophies: mappedTrophies 
    });
  } catch (error: unknown) {
    Logger.log(`[Profile GET Error]: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const token = await getToken({ req: req as any });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const configDir = process.env.OMNIBUS_CONFIG_DIR || '/config';

  try {
    const { avatarBase64, bannerBase64, removeBanner } = await req.json();
    
    if (!avatarBase64 && !bannerBase64 && !removeBanner) {
        return NextResponse.json({ error: 'No image or action provided' }, { status: 400 });
    }

    if (removeBanner) {
        const currentUser = await prisma.user.findUnique({ where: { id: token.id as string } });
        if (currentUser?.banner) {
            const oldFileName = currentUser.banner.split('?')[0].split('/').pop();
            if (oldFileName) {
                const oldPath = path.join(configDir, 'uploads', 'banners', oldFileName);
                if (await fs.exists(oldPath)) await fs.unlink(oldPath);
            }
        }
        await prisma.user.update({ where: { id: token.id as string }, data: { banner: null } });
        return NextResponse.json({ success: true, bannerUrl: null });
    }

    if (avatarBase64) {
        const avatarDir = path.join(configDir, 'uploads', 'avatars');
        await fs.ensureDir(avatarDir);
        const fileName = `${token.id}.jpg`;
        const filePath = path.join(avatarDir, fileName);
        const base64Data = avatarBase64.replace(/^data:image\/\w+;base64,/, "");
        await fs.writeFile(filePath, base64Data, 'base64');
        
        // --- FIX: Output URL routed through new uploads API endpoint ---
        const avatarUrl = `/api/uploads/avatars/${fileName}?t=${Date.now()}`;
        await prisma.user.update({ where: { id: token.id as string }, data: { avatar: avatarUrl } });
        return NextResponse.json({ success: true, avatarUrl });
    }

    if (bannerBase64) {
        const bannerDir = path.join(configDir, 'uploads', 'banners');
        await fs.ensureDir(bannerDir);
        const fileName = `${token.id}_banner.jpg`;
        const filePath = path.join(bannerDir, fileName);
        const base64Data = bannerBase64.replace(/^data:image\/\w+;base64,/, "");
        await fs.writeFile(filePath, base64Data, 'base64');
        
        // --- FIX: Output URL routed through new uploads API endpoint ---
        const bannerUrl = `/api/uploads/banners/${fileName}?t=${Date.now()}`;
        await prisma.user.update({ where: { id: token.id as string }, data: { banner: bannerUrl } });
        return NextResponse.json({ success: true, bannerUrl });
    }

  } catch (error: unknown) {
    Logger.log(`[Profile POST Error]: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}