const { PrismaClient } = require('@prisma/client');
const path = require('path');

const prisma = new PrismaClient();

async function testMapping() {
    // 1. Get input from command line
    const remotePath = process.argv[2];
    
    if (!remotePath) {
        Logger.log("\n❌ Error: Please provide a path to test.", 'info');
        Logger.log("Usage: node scripts/test-mapping.js \"/downloads/comic-file.cbz\"\n", 'info');
        process.exit(1);
    }

    Logger.log(`\n🔍 Testing Path: "${remotePath}"`, 'info');

    try {
        // 2. Fetch Mappings from DB
        const settings = await prisma.systemSetting.findUnique({ 
            where: { key: 'remote_path_mappings' } 
        });

        if (!settings || !settings.value) {
            Logger.log("⚠️  Warning: No Path Mappings found in database.", 'info');
            Logger.log(`Result: "${path.normalize(remotePath)}" (No changes)`, 'info');
            return;
        }

        const mappings = JSON.parse(settings.value);
        Logger.log(`✅ Loaded ${mappings.length} mapping rules.`, 'info');

        // 3. Run the logic
        let resolved = remotePath;
        const normalizedInput = remotePath.replace(/\\/g, '/');
        let matched = false;

        for (const mapping of mappings) {
            const normalizedRemote = mapping.remote.replace(/\\/g, '/').replace(/\/$/, '');
            const normalizedLocal = mapping.local.replace(/\\/g, '/').replace(/\/$/, '');

            if (normalizedInput.startsWith(normalizedRemote)) {
                resolved = normalizedInput.replace(normalizedRemote, normalizedLocal);
                resolved = path.normalize(resolved);
                matched = true;
                Logger.log(`\n✨ MATCH FOUND:`, 'info');
                Logger.log(`   Rule:   "${mapping.remote}" -> "${mapping.local}"`, 'info');
                break;
            }
        }

        if (!matched) {
            Logger.log("\n❓ NO MATCH: No rules started with this path prefix.", 'info');
        }

        Logger.log(`\n🚀 FINAL RESOLVED PATH:`, 'info');
        Logger.log(`   "${resolved}"\n`, 'info');

    } catch (error) {
        Logger.log("❌ Script Error:", error.message, 'error');
    } finally {
        await prisma.$disconnect();
    }
}

testMapping();