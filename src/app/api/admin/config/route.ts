// src/app/api/admin/config/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { AuditLogger } from '@/lib/audit-logger';

const SENSITIVE_KEYS = [
    'cv_api_key', 
    'prowlarr_key', 
    'oidc_client_secret', 
    'discord_webhooks', // Legacy flat key
    'omnibus_api_key',  // Legacy flat key
    'smtp_pass'         
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
  
  // Obfuscate passwords and API keys within Download Clients
  const rawClients = await prisma.downloadClient.findMany();
  const clients = rawClients.map(c => ({
      ...c,
      pass: c.pass ? '********' : null,
      apiKey: c.apiKey ? '********' : null
  }));

  const indexers = await prisma.indexer.findMany();
  const headers = await prisma.customHeader.findMany();
  const acronyms = await prisma.searchAcronym.findMany();
  
  // Parse webhook events from the DB string back into a native array for the frontend
  const webhooksRaw = await prisma.discordWebhook.findMany();
  const webhooks = webhooksRaw.map(w => ({
      ...w,
      events: typeof w.events === 'string' ? JSON.parse(w.events) : w.events
  }));

  // --- THE FIX: EXPOSE DOCKER PATHS (Updated to include Database URL) ---
  const envPaths = {
      DATABASE_URL: (process.env.DATABASE_URL || 'file:./omnibus.db').replace(/:.*@/, ':****@'),
      OMNIBUS_BACKUPS_DIR: process.env.OMNIBUS_BACKUPS_DIR || '/backups',
      OMNIBUS_CACHE_DIR: process.env.OMNIBUS_CACHE_DIR || '/cache',
      OMNIBUS_LOGS_DIR: process.env.OMNIBUS_LOGS_DIR || '/app/config/logs'
  };

  // 3. Return cleanly structured data
  return NextResponse.json({
      settings,
      libraries,
      downloadClients: clients,
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

    // FIX: Only enforce session check if setup is already done.
    // This allows the Setup Wizard to perform the first save.
    let userId: string | null = null;

    if (isSetupComplete) {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') {
            return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
        }
        userId = (session.user as any).id;
    } else {
        // Double-check as a fallback: if setup isn't complete, ensure at least one user exists
        const userCount = await prisma.user.count();
        if (userCount === 0) {
             return NextResponse.json({ error: "Admin account must be created first." }, { status: 400 });
        }
    }

    const body = await request.json();
    
    // Explicitly destructure the native objects from the payload
    const {
        settings,
        libraries, 
        downloadClients, 
        discordWebhooks,
        indexers, 
        customHeaders, 
        searchAcronyms
    } = body;

    // Run everything in a massive transaction so it all succeeds or fails together
    await prisma.$transaction(async (tx) => {
        
        // 1. Update Flat Key-Value Settings
        if (settings) {
            for (const [key, value] of Object.entries(settings)) {
                // --- SECURITY FIX: Skip writing obfuscated tokens to prevent overwriting secrets ---
                if (value === '********') continue;

                const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value ?? "");
                await tx.systemSetting.upsert({
                    where: { key },
                    update: { value: stringValue },
                    create: { key, value: stringValue }
                });
            }
        }

        // 2. Native Relational Array Sync Engine
        const syncTable = async (model: any, data: any[], pk: string = 'id') => {
            if (!data || !Array.isArray(data)) return;
            
            const existing = await model.findMany();
            
            // Ignore temporary frontend IDs when checking what to delete
            const incomingIds = data
                .map(d => d[pk])
                .filter(id => id !== undefined && id !== null && !(typeof id === 'string' && (id.startsWith('tmp_') || id.startsWith('0.'))));
            
            // Delete removed items
            const toDelete = existing.filter((e: any) => !incomingIds.includes(e[pk]));
            if (toDelete.length > 0) {
                await model.deleteMany({ where: { [pk]: { in: toDelete.map((e:any) => e[pk]) } } });
            }

            // Create or Update items
            for (const item of data) {
                const isTempId = typeof item[pk] === 'string' && (item[pk].startsWith('tmp_') || item[pk].startsWith('0.'));
                const { [pk]: idField, ...rest } = item;
                
                // --- SECURITY FIX: Remove obfuscated keys so Prisma ignores them in the update
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
        if (indexers) await syncTable(tx.indexer, indexers);
        if (customHeaders) await syncTable(tx.customHeader, customHeaders);
        if (searchAcronyms) await syncTable(tx.searchAcronym, searchAcronyms, 'key');

        if (discordWebhooks) {
            // Stringify the events array for the database column
            const parsedHooks = discordWebhooks.map((w: any) => ({
                ...w,
                events: JSON.stringify(w.events || [])
            }));
            await syncTable(tx.discordWebhook, parsedHooks);
        }
    });

    // --- AUDIT LOG ---
    if (isSetupComplete) {
        await AuditLogger.log('UPDATE_SYSTEM_CONFIG', {
            message: "System configuration and integrations updated.",
            updatedSections: Object.keys(body).filter(k => body[k] !== undefined)
        }, userId);
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    Logger.log(`Settings Save Error: ${getErrorMessage(error)}`, 'error');

    // --- SECURITY FIX: Replaced error.message with a generic string ---
    return NextResponse.json({ error: "Failed to save configuration. Please check the server logs." }, { status: 500 });
  }
}