import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export async function POST(request: Request) {
  try {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    
    // 1. Authenticate the User
    let userId = (session?.user as any)?.id || null;
    
    if (!userId && session?.user) {
        const sessionEmail = session.user.email;
        const sessionName = session.user.name;
        
        const user = await prisma.user.findFirst({
            where: {
                OR: [
                    ...(sessionEmail ? [{ email: sessionEmail }] : []),
                    ...(sessionName ? [{ username: sessionName }] : [])
                ]
            }
        });
        userId = user?.id || null;
    }

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2. Safely delete the progress record
    const { progressId } = await request.json();

    if (!progressId) {
        return NextResponse.json({ error: "Missing Progress ID" }, { status: 400 });
    }

    // Using deleteMany ensures a user can only delete their own progress
    await prisma.readProgress.deleteMany({
        where: { 
            id: progressId,
            userId: userId 
        }
    });

    return NextResponse.json({ success: true });

  } catch (error: unknown) {
    Logger.log(`Mark Unread API Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}