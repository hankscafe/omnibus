import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export async function GET() {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // 1. STORAGE DATA: Optimized Database Aggregation
        // Instead of scanning the disk, we group by publisher and sum the pre-calculated 'size' field
        const storageDataRaw = await prisma.series.groupBy({
            by: ['publisher'],
            _sum: {
                size: true
            }
        });

        const storageData = storageDataRaw
            .map(item => ({
                name: item.publisher || "Unknown",
                // Convert stored bytes to GB for the chart
                value: parseFloat(((item._sum.size || 0) / 1024 / 1024 / 1024).toFixed(2))
            }))
            .filter(item => item.value > 0)
            .sort((a, b) => b.value - a.value)
            .slice(0, 8);

        // 2. USER ENGAGEMENT
        const topUsers = await prisma.user.findMany({
            select: {
                username: true,
                _count: { select: { readProgresses: true } }
            },
            orderBy: { readProgresses: { _count: 'desc' } },
            take: 5
        });

        // 3. DOWNLOAD HEALTH: Last 30 Days
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const logs = await prisma.jobLog.findMany({
            where: { 
                createdAt: { gte: thirtyDaysAgo }, 
                jobType: { in: ['LIBRARY_SCAN', 'METADATA_SYNC', 'SERIES_MONITOR', 'DIAGNOSTICS'] } 
            }
        });

        const healthData = logs.reduce((acc: any, log) => {
            const date = log.createdAt.toISOString().split('T')[0];
            if (!acc[date]) acc[date] = { date, success: 0, fail: 0 };
            if (log.status === 'COMPLETED') acc[date].success++;
            else acc[date].fail++;
            return acc;
        }, {});

        // 4. GLOBAL POPULARITY: (By favorites count)
        const popularSeries = await prisma.series.findMany({
            select: {
                name: true,
                _count: { select: { favorites: true } }
            },
            orderBy: { favorites: { _count: 'desc' } },
            take: 5
        });

        // 5. INACTIVE SERIES: (Oldest items with no favorites)
        const inactiveSeries = await prisma.series.findMany({
            where: { favorites: { none: {} } },
            select: { id: true, name: true, publisher: true }, // <-- ADDED ID HERE
            orderBy: { id: 'asc' },
            take: 10
        });

        return NextResponse.json({
            storageData,
            engagementData: topUsers.map(u => ({ name: u.username, count: u._count.readProgresses })),
            healthData: Object.values(healthData),
            popularSeriesData: popularSeries.map(s => ({ name: s.name, completedCount: s._count.favorites })),
            inactiveSeries: inactiveSeries.map(s => ({ id: s.id, name: s.name, publisher: s.publisher || "Unknown" })), // <-- ADDED ID TO RESPONSE
            timestamp: new Date().toISOString()
        });

    } catch (error: any) {
        console.error("Analytics Error Details:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}