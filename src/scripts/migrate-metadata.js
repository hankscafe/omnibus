const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function migrate() {
    console.log("Starting metadata migration...");

    // 1. Migrate Series
    const series = await prisma.series.findMany({ where: { cvId: { not: null } } });
    let seriesCount = 0;
    for (const s of series) {
        await prisma.series.update({
            where: { id: s.id },
            data: { metadataId: s.cvId.toString(), metadataSource: "COMICVINE" }
        });
        seriesCount++;
    }
    console.log(`Migrated ${seriesCount} Series.`);

    // 2. Migrate Issues
    const issues = await prisma.issue.findMany({ where: { cvId: { not: null } } });
    let issueCount = 0;
    for (const i of issues) {
        await prisma.issue.update({
            where: { id: i.id },
            data: { metadataId: i.cvId.toString(), metadataSource: "COMICVINE" }
        });
        issueCount++;
    }
    console.log(`Migrated ${issueCount} Issues.`);

    console.log("Migration complete!");
}

migrate()
    .catch(e => console.error(e))
    .finally(() => prisma.$disconnect());