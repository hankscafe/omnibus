import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import fs from 'fs-extra';
import path from 'path';

export async function GET(req: Request) {
  const token = await getToken({ req });
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
        prisma.readProgress.count({ 
            where: { userId: token.id as string } 
        }),
        prisma.readProgress.count({ 
            where: { userId: token.id as string, isCompleted: true } 
        })
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
        include: { 
            issue: { include: { series: true } } 
        },
        orderBy: { updatedAt: 'desc' },
        take: 24 
    });

    const seriesCvIds = recentProgresses.map(rp => rp.issue?.series?.cvId?.toString()).filter(Boolean) as string[];
    const relatedRequests = await prisma.request.findMany({
        where: { volumeId: { in: seriesCvIds } },
        select: { volumeId: true, imageUrl: true }
    });

    const coverMap = new Map<string, string>();
    for (const req of relatedRequests) {
        if (req.imageUrl) coverMap.set(req.volumeId, req.imageUrl);
    }

    const recentHistory = recentProgresses.map(rp => {
        const progressPct = rp.totalPages > 0 ? Math.round((rp.currentPage / rp.totalPages) * 100) : 0;
        const cvIdStr = rp.issue?.series?.cvId?.toString();
        const folderPath = rp.issue?.series?.folderPath;
        const localCoverPath = folderPath ? path.join(folderPath, 'cover.jpg') : null;
        
        return {
            id: rp.id,
            seriesName: rp.issue?.series?.name || "Unknown Series",
            issueNumber: rp.issue?.number || "?",
            progress: progressPct,
            isCompleted: rp.isCompleted || progressPct >= 100,
            updatedAt: rp.updatedAt,
            coverUrl: cvIdStr ? coverMap.get(cvIdStr) || null : null,
            localCoverPath: localCoverPath, 
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
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const token = await getToken({ req });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { avatarBase64, bannerBase64, removeBanner } = await req.json();
    
    if (!avatarBase64 && !bannerBase64 && !removeBanner) {
        return NextResponse.json({ error: 'No image or action provided' }, { status: 400 });
    }

    // --- REMOVE BANNER ---
    if (removeBanner) {
        const currentUser = await prisma.user.findUnique({ where: { id: token.id as string } });
        if (currentUser?.banner) {
            // Updated to handle path logic with the api/uploads prefix
            const oldFileName = currentUser.banner.split('?')[0].split('/').pop();
            if (oldFileName) {
                const oldPath = path.join(process.cwd(), 'public', 'banners', oldFileName);
                if (await fs.exists(oldPath)) await fs.unlink(oldPath);
            }
        }
        await prisma.user.update({ where: { id: token.id as string }, data: { banner: null } });
        return NextResponse.json({ success: true, bannerUrl: null });
    }

    // --- UPLOAD AVATAR ---
    if (avatarBase64) {
        const avatarDir = path.join(process.cwd(), 'public', 'avatars');
        await fs.ensureDir(avatarDir);
        const fileName = `${token.id}.jpg`;
        const filePath = path.join(avatarDir, fileName);
        const base64Data = avatarBase64.replace(/^data:image\/\w+;base64,/, "");
        await fs.writeFile(filePath, base64Data, 'base64');
        
        // FIX: Prefix with api/uploads to use the static image handler
        const avatarUrl = `/api/uploads/avatars/${fileName}?t=${Date.now()}`;
        await prisma.user.update({ where: { id: token.id as string }, data: { avatar: avatarUrl } });
        return NextResponse.json({ success: true, avatarUrl });
    }

    // --- UPLOAD BANNER ---
    if (bannerBase64) {
        const bannerDir = path.join(process.cwd(), 'public', 'banners');
        await fs.ensureDir(bannerDir);
        const fileName = `${token.id}_banner.jpg`;
        const filePath = path.join(bannerDir, fileName);
        const base64Data = bannerBase64.replace(/^data:image\/\w+;base64,/, "");
        await fs.writeFile(filePath, base64Data, 'base64');
        
        // FIX: Prefix with api/uploads to use the static image handler
        const bannerUrl = `/api/uploads/banners/${fileName}?t=${Date.now()}`;
        await prisma.user.update({ where: { id: token.id as string }, data: { banner: bannerUrl } });
        return NextResponse.json({ success: true, bannerUrl });
    }

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}