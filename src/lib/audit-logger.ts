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
            // --- FIX: Prisma expects a valid User ID or null for foreign keys. ---
            // We map 'System' to null for the database, but keep it for the text log.
            const validUserId = (userId === 'System' || userId === 'system') ? null : userId;

            await prisma.auditLog.create({
                data: {
                    action,
                    details: typeof details === 'string' ? details : JSON.stringify(details),
                    userId: validUserId,
                    ipAddress
                }
            });

            // Retrieve the human-readable username for the text log
            let displayName = 'System';
            if (validUserId) {
                const user = await prisma.user.findUnique({
                    where: { id: validUserId },
                    select: { username: true }
                });
                // Fall back to ID if the user was somehow deleted
                displayName = user?.username || validUserId;
            }
            
            // Also log it to the standard rotating log file for redundancy
            Logger.log(`[AUDIT] ${action} by User:${displayName} - ${typeof details === 'string' ? details : JSON.stringify(details)}`, 'warn');
        } catch (error: any) {
            Logger.log(`Failed to write audit log: ${error.message}`, 'error');
        }
    }
};