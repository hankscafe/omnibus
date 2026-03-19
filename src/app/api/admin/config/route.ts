import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';

export async function GET(request: Request) {
  const authOptions = await getAuthOptions();
  const session = await getServerSession(authOptions);
  
  if (session?.user?.role !== 'ADMIN') {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 1. Fetch flat settings
  const settings = await prisma.systemSetting.findMany();
  
  // 2. Fetch the native relational data
  const libraries = await prisma.library.findMany();
  const clients = await prisma.downloadClient.findMany();
  const indexers = await prisma.indexer.findMany();
  const headers = await prisma.customHeader.findMany();
  const acronyms = await prisma.searchAcronym.findMany();
  
  // Parse webhook events from the DB string back into a native array for the frontend
  const webhooksRaw = await prisma.discordWebhook.findMany();
  const webhooks = webhooksRaw.map(w => ({
      ...w,
      events: typeof w.events === 'string' ? JSON.parse(w.events) : w.events
  }));

  // 3. Return cleanly structured data
  return NextResponse.json({
      settings,
      libraries,
      downloadClients: clients,
      discordWebhooks: webhooks,
      indexers,
      customHeaders: headers,
      searchAcronyms: acronyms
  });
}

export async function POST(request: Request) {
  try {
    const setupStatus = await prisma.systemSetting.findUnique({ where: { key: 'setup_complete' } });
    const isSetupComplete = setupStatus?.value === 'true';

    if (isSetupComplete) {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') {
            return NextResponse.json({ error: "Unauthorized. Setup is already complete." }, { status: 403 });
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

    return NextResponse.json({ success: true });
  } catch (error: any) {
    Logger.log("Settings Save Error:", error.message, 'error');
    // --- SECURITY FIX: Replaced error.message with a generic string ---
    return NextResponse.json({ error: "Failed to save configuration. Please check the server logs." }, { status: 500 });
  }
}