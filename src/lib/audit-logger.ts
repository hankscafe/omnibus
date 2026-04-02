// src/lib/audit-logger.ts
import { prisma } from '@/lib/db';
import { Logger } from '@/lib/logger';

export const AuditLogger = {
    async log(
        action: string, 
        details: Record<string, any> | string, 
        userId?: string | null, 
        ipAddress?: string | null
    ) {
        try {
            await prisma.auditLog.create({
                data: {
                    action,
                    details: typeof details === 'string' ? details : JSON.stringify(details),
                    userId,
                    ipAddress
                }
            });
            
            // Also log it to the standard rotating log file for redundancy
            Logger.log(`[AUDIT] ${action} by User:${userId || 'System'} - ${JSON.stringify(details)}`, 'warn');
        } catch (error: any) {
            Logger.log(`Failed to write audit log: ${error.message}`, 'error');
        }
    }
};