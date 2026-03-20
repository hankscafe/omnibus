import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const userCount = await prisma.user.count();
        
        let setupSetting = await prisma.systemSetting.findUnique({ 
            where: { key: 'setup_complete' } 
        });

        // Backward Compatibility Auto-Heal:
        // If users exist but the setup flag is missing/false, force it to true.
        if (userCount > 0 && setupSetting?.value !== 'true') {
            setupSetting = await prisma.systemSetting.upsert({
                where: { key: 'setup_complete' },
                update: { value: 'true' },
                create: { key: 'setup_complete', value: 'true' }
            });
        }
        
        const isComplete = setupSetting?.value === 'true' && userCount > 0;
        
        return NextResponse.json({ requiresSetup: !isComplete });
    } catch (error) {
        Logger.log(`Setup Check Error: ${getErrorMessage(error)}`, 'error');

        return NextResponse.json({ requiresSetup: true });
    }
}