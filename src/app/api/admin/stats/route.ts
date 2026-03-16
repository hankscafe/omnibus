export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export async function GET() {
  try {
    // FIX: ADDED ADMIN AUTHENTICATION GUARD
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    if (session?.user?.role !== 'ADMIN') {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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