const { PrismaClient } = require('@prisma/client');
const path = require('path');

const prisma = new PrismaClient();

async function testMapping() {
    // 1. Get input from command line
    const remotePath = process.argv[2];
    
    if (!remotePath) {
        console.log("\n❌ Error: Please provide a path to test.");
        console.log("Usage: node scripts/test-mapping.js \"/downloads/comic-file.cbz\"\n");
        process.exit(1);
    }

    console.log(`\n🔍 Testing Path: "${remotePath}"`);

    try {
        // 2. Fetch Mappings from DB
        const settings = await prisma.systemSetting.findUnique({ 
            where: { key: 'remote_path_mappings' } 
        });

        if (!settings || !settings.value) {
            console.log("⚠️  Warning: No Path Mappings found in database.");
            console.log(`Result: "${path.normalize(remotePath)}" (No changes)`);
            return;
        }

        const mappings = JSON.parse(settings.value);
        console.log(`✅ Loaded ${mappings.length} mapping rules.`);

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
                console.log(`\n✨ MATCH FOUND:`);
                console.log(`   Rule:   "${mapping.remote}" -> "${mapping.local}"`);
                break;
            }
        }

        if (!matched) {
            console.log("\n❓ NO MATCH: No rules started with this path prefix.");
        }

        console.log(`\n🚀 FINAL RESOLVED PATH:`);
        console.log(`   "${resolved}"\n`);

    } catch (error) {
        console.error("❌ Script Error:", error.message);
    } finally {
        await prisma.$disconnect();
    }
}

testMapping();