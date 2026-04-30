// src/app/api/admin/config/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';
import { syncSchedules } from '@/lib/queue';

const SENSITIVE_KEYS = [
    'cv_api_key', 
    'prowlarr_key', 
    'oidc_client_secret', 
    'discord_webhooks', 
    'omnibus_api_key',  
    'smtp_pass',
    'metron_pass' // <-- ADDED: Securely hide Metron Password
];

export async function GET(request: Request) {
  const authOptions = await getAuthOptions();
  const session = await getServerSession(authOptions);
  
  if (session?.user?.role !== 'ADMIN') {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 1. Fetch flat settings and securely obfuscate tokens
  const rawSettings = await prisma.systemSetting.findMany();
  const settings = rawSettings.map(s => {
      if (SENSITIVE_KEYS.includes(s.key) && s.value) {
          return { ...s, value: '********' };
      }
      return s;
  });
  
  // 2. Fetch the native relational data
  const libraries = await prisma.library.findMany();
  
  const rawClients = await prisma.downloadClient.findMany();
  const clients = rawClients.map(c => ({
      ...c,
      pass: c.pass ? '********' : null,
      apiKey: c.apiKey ? '********' : null
  }));

  const rawHosters = await prisma.hosterAccount.findMany();
  const hosterAccounts = rawHosters.map(h => ({
      ...h,
      password: h.password ? '********' : null,
      apiKey: h.apiKey ? '********' : null
  }));

  const indexers = await prisma.indexer.findMany();
  const headers = await prisma.customHeader.findMany();
  const acronyms = await prisma.searchAcronym.findMany();
  
  const webhooksRaw = await prisma.discordWebhook.findMany();
  const webhooks = webhooksRaw.map(w => ({
      ...w,
      events: typeof w.events === 'string' ? JSON.parse(w.events) : w.events
  }));

  const envPaths = {
      DATABASE_URL: (process.env.DATABASE_URL || 'file:./omnibus.db').replace(/:.*@/, ':****@'),
      OMNIBUS_BACKUPS_DIR: process.env.OMNIBUS_BACKUPS_DIR || '/backups',
      OMNIBUS_CACHE_DIR: process.env.OMNIBUS_CACHE_DIR || '/cache',
      OMNIBUS_LOGS_DIR: process.env.OMNIBUS_LOGS_DIR || '/app/config/logs',
      OMNIBUS_WATCHED_DIR: process.env.OMNIBUS_WATCHED_DIR || '/watched',
      OMNIBUS_AWAITING_MATCH_DIR: process.env.OMNIBUS_AWAITING_MATCH_DIR || '/unmatched'
  };

  return NextResponse.json({
      settings,
      libraries,
      downloadClients: clients,
      hosterAccounts, 
      discordWebhooks: webhooks,
      indexers,
      customHeaders: headers,
      searchAcronyms: acronyms,
      envPaths 
  });
}

export async function POST(request: Request) {
  try {
    const setupStatus = await prisma.systemSetting.findUnique({ where: { key: 'setup_complete' } });
    const isSetupComplete = setupStatus?.value === 'true';

    let userId: string | null = null;

    if (isSetupComplete) {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') {
            return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
        }
        userId = (session.user as any).id;
    } else {
        const userCount = await prisma.user.count();
        if (userCount === 0) {
             return NextResponse.json({ error: "Admin account must be created first." }, { status: 400 });
        }
    }

    const body = await request.json();
    
    const {
        settings,
        libraries, 
        downloadClients, 
        hosterAccounts, 
        discordWebhooks,
        indexers, 
        customHeaders, 
        searchAcronyms
    } = body;

    // --- NEW: SAFETY NET VALIDATION ---
    if (settings?.oidc_force_sso === 'true') {
        const adminWithPassword = await prisma.user.findFirst({
            where: {
                role: 'ADMIN',
                password: { not: '' }
            }
        });

        if (!adminWithPassword) {
            return NextResponse.json({ 
                error: "Cannot enable Force SSO: No Admin account with a local password exists. Please set a local password for an Admin account first to prevent lockouts." 
            }, { status: 400 });
        }
    }

    await prisma.$transaction(async (tx) => {
        
        if (settings) {
            for (const [key, value] of Object.entries(settings)) {
                if (value === '********') continue;

                const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value ?? "");
                await tx.systemSetting.upsert({
                    where: { key },
                    update: { value: stringValue },
                    create: { key, value: stringValue }
                });
            }
        }

        const syncTable = async (model: any, data: any[], pk: string = 'id') => {
            if (!data || !Array.isArray(data)) return;
            
            const existing = await model.findMany();
            
            const incomingIds = data
                .map(d => d[pk])
                .filter(id => id !== undefined && id !== null && !(typeof id === 'string' && (id.startsWith('tmp_') || id.startsWith('0.'))));
            
            const toDelete = existing.filter((e: any) => !incomingIds.includes(e[pk]));
            if (toDelete.length > 0) {
                await model.deleteMany({ where: { [pk]: { in: toDelete.map((e:any) => e[pk]) } } });
            }

            for (const item of data) {
                const isTempId = typeof item[pk] === 'string' && (item[pk].startsWith('tmp_') || item[pk].startsWith('0.'));
                const { [pk]: idField, ...rest } = item;
                
                for (const k in rest) {
                    if (rest[k] === '********') {
                        delete rest[k];
                    }
                }

                if (isTempId || item[pk] === undefined || item[pk] === null) {
                    await model.create({ data: rest });
                } else {
                    await model.upsert({
                        where: { [pk]: item[pk] },
                        update: rest,
                        create: { [pk]: item[pk], ...rest }
                    });
                }
            }
        };

        if (libraries) await syncTable(tx.library, libraries);
        if (downloadClients) await syncTable(tx.downloadClient, downloadClients);
        if (hosterAccounts) await syncTable(tx.hosterAccount, hosterAccounts); 
        if (indexers) await syncTable(tx.indexer, indexers);
        if (customHeaders) await syncTable(tx.customHeader, customHeaders);
        if (searchAcronyms) await syncTable(tx.searchAcronym, searchAcronyms, 'key');

        if (discordWebhooks) {
            const parsedHooks = discordWebhooks.map((w: any) => ({
                ...w,
                events: JSON.stringify(w.events || [])
            }));
            await syncTable(tx.discordWebhook, parsedHooks);
        }
    });

    const isFinishingSetup = !isSetupComplete && settings?.setup_complete === 'true';

    if (isSetupComplete || isFinishingSetup) {
        await AuditLogger.log('UPDATE_SYSTEM_CONFIG', {
            message: isFinishingSetup ? "Initial system setup completed." : "System configuration and integrations updated.",
            updatedSections: Object.keys(body).filter(k => body[k] !== undefined)
        }, userId || 'System');

        if (isFinishingSetup) {
            Logger.log("[Setup] Initial configuration saved successfully. Welcome to Omnibus!", "success");
        }

        // Tell BullMQ to wipe the old schedules and apply the new intervals
        await syncSchedules().catch(e => Logger.log(`Failed to sync BullMQ schedules: ${getErrorMessage(e)}`, 'error'));
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    Logger.log(`Settings Save Error: ${getErrorMessage(error)}`, 'error');
    return NextResponse.json({ error: "Failed to save configuration. Please check the server logs." }, { status: 500 });
  }
}