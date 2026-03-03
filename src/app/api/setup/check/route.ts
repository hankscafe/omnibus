import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        // Check 1: Does an Admin user exist?
        const userCount = await prisma.user.count();
        
        // Check 2: Has the setup wizard completed?
        const setupSetting = await prisma.systemSetting.findUnique({ 
            where: { key: 'setup_complete' } 
        });
        
        const isComplete = setupSetting?.value === 'true' && userCount > 0;
        
        return NextResponse.json({ requiresSetup: !isComplete });
    } catch (e) {
        // If the database is completely empty/uninitialized, it will throw an error.
        // We catch it and safely tell the frontend to run the setup wizard!
        return NextResponse.json({ requiresSetup: true });
    }
}