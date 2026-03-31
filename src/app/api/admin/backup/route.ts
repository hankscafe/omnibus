// src/app/api/admin/backup/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import crypto from 'crypto';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const algorithm = 'aes-256-cbc';
        const secret = process.env.NEXTAUTH_SECRET || 'omnibus_default_encryption_key_!@#';
        const key = crypto.createHash('sha256').update(String(secret)).digest();
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(algorithm, key, iv);

        // --- THE FIX: STREAMING CIPHER ENGINE ---
        // Instead of loading the DB into RAM, we stream chunks directly through the cipher to the client
        const stream = new ReadableStream({
            async start(controller) {
                const encEncoder = new TextEncoder();
                
                controller.enqueue(encEncoder.encode(`{\n  "encrypted": true,\n  "version": "2.2",\n  "iv": "${iv.toString('hex')}",\n  "data": "`));

                cipher.on('data', (chunk) => {
                    controller.enqueue(encEncoder.encode(chunk.toString('hex')));
                });

                cipher.on('end', () => {
                    controller.enqueue(encEncoder.encode(`"\n}`));
                    controller.close();
                });

                cipher.write('{"timestamp":"' + new Date().toISOString() + '","data":{');

                // Ordered safely for foreign key restoration
                const tables = [
                    { name: 'users', model: prisma.user },
                    { name: 'settings', model: prisma.systemSetting },
                    { name: 'libraries', model: prisma.library },
                    { name: 'downloadClients', model: prisma.downloadClient },
                    { name: 'discordWebhooks', model: prisma.discordWebhook },
                    { name: 'indexers', model: prisma.indexer },
                    { name: 'customHeaders', model: prisma.customHeader },
                    { name: 'searchAcronyms', model: prisma.searchAcronym },
                    { name: 'collections', model: prisma.collection },
                    { name: 'readingLists', model: prisma.readingList },
                    { name: 'trophies', model: prisma.trophy },
                    { name: 'series', model: prisma.series },
                    { name: 'issues', model: prisma.issue },
                    { name: 'requests', model: prisma.request },
                    { name: 'readProgresses', model: prisma.readProgress },
                    { name: 'collectionItems', model: prisma.collectionItem },
                    { name: 'readingListItems', model: prisma.readingListItem },
                    { name: 'userTrophies', model: prisma.userTrophy },
                    { name: 'issueReports', model: prisma.issueReport }
                ];

                let firstTable = true;
                for (const table of tables) {
                    if (!firstTable) cipher.write(',');
                    firstTable = false;
                    
                    cipher.write(`"${table.name}":[`);
                    
                    let skip = 0;
                    const take = 500; // Chunk size to keep RAM usage low
                    let firstRow = true;
                    
                    while (true) {
                        // @ts-ignore
                        const rows = await table.model.findMany({ skip, take });
                        if (rows.length === 0) break;
                        
                        for (const row of rows) {
                            if (!firstRow) cipher.write(',');
                            firstRow = false;
                            cipher.write(JSON.stringify(row));
                        }
                        skip += take;
                    }
                    cipher.write(`]`);
                }

                cipher.write('}}');
                cipher.end(); // Triggers cipher 'end' event which closes the HTTP stream
            }
        });

        return new NextResponse(stream, {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Content-Disposition': `attachment; filename="omnibus_backup_${new Date().toISOString().split('T')[0]}.json"`,
            },
        });

    } catch (error: unknown) {
        Logger.log(`[Backup API] Generation Failed: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: "Backup generation failed. Please check the server logs." }, { status: 500 });
    }
}