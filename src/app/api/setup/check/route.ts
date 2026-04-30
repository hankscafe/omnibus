// src/app/api/setup/check/route.ts
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

        // Backward Compatibility Auto-Heal
        if (userCount > 0 && setupSetting?.value !== 'true') {
            setupSetting = await prisma.systemSetting.upsert({
                where: { key: 'setup_complete' },
                update: { value: 'true' },
                create: { key: 'setup_complete', value: 'true' }
            });
        }
        
        const isComplete = setupSetting?.value === 'true' && userCount > 0;
        
        // --- NEW: Expose Force SSO state for the login page ---
        const forceSsoSetting = await prisma.systemSetting.findUnique({
            where: { key: 'oidc_force_sso' }
        });
        const forceSso = forceSsoSetting?.value === 'true';
        
        return NextResponse.json({ requiresSetup: !isComplete, forceSso });
    } catch (error) {
        Logger.log(`Setup Check Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ requiresSetup: true, forceSso: false });
    }
}