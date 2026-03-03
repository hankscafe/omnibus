export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET() {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [totalRequests, completed30d, failed30d, totalUsers] = await prisma.$transaction([
      prisma.request.count(),
      prisma.request.count({ 
        where: { 
          status: { in: ['IMPORTED', 'COMPLETED'] }, 
          updatedAt: { gte: thirtyDaysAgo } 
        } 
      }),
      prisma.request.count({ 
        where: { 
          status: { in: ['FAILED', 'ERROR', 'STALLED'] }, 
          updatedAt: { gte: thirtyDaysAgo } 
        } 
      }),
      prisma.user.count()
    ]);

    // HEALTH LOGIC: 
    // If more than 15% of recent requests failed, mark as "Warning"
    // If more than 40% failed, mark as "Degraded"
    const totalRecent = completed30d + failed30d;
    const failureRate = totalRecent > 0 ? (failed30d / totalRecent) : 0;
    
    let healthStatus = "HEALTHY";
    if (failureRate > 0.4) healthStatus = "DEGRADED";
    else if (failureRate > 0.15) healthStatus = "WARNING";

    return NextResponse.json({ 
        success: true, 
        totalRequests, 
        completed30d, 
        failed30d, 
        totalUsers,
        healthStatus,
        failureRate: Math.round(failureRate * 100)
    });

  } catch (globalErr: any) {
    return NextResponse.json({ 
        success: false,
        error: globalErr.message,
        totalRequests: 0, completed30d: 0, failed30d: 0, totalUsers: 0,
        healthStatus: "UNKNOWN"
    }, { status: 500 });
  }
}