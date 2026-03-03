import fs from 'fs-extra';
import path from 'path';
import { prisma } from '@/lib/db';

export async function processDownload(cvId: string, fileName: string) {
  // 1. Get Paths from Settings
  const settings = await prisma.systemSetting.findMany();
  const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

  const source = path.join(config.download_path, fileName);
  const request = await prisma.comicRequest.findUnique({ where: { cvId } });

  if (!request || !fs.existsSync(source)) return { success: false, error: "File or Request not found" };

  // 2. Format Destination: Library/Series Name (Year)/File.cbz
  const seriesFolder = `${request.name} (${request.year})`;
  const destDir = path.join(config.library_path, seriesFolder);
  const destFile = path.join(destDir, fileName);

  try {
    await fs.ensureDir(destDir);
    await fs.move(source, destFile, { overwrite: true });

    // 3. Update Database
    await prisma.$transaction([
      // Add to Library
      prisma.comic.create({
        data: {
          cvId: request.cvId,
          name: request.name,
          issueNumber: fileName.match(/#(\d+)/)?.[1] || "0", // Try to extract issue #
          filePath: destFile,
        }
      }),
      // Mark request as imported
      prisma.comicRequest.update({
        where: { cvId },
        data: { status: 'IMPORTED' }
      })
    ]);

    return { success: true };
  } catch (error) {
    console.error("Post-Processing Error:", error);
    return { success: false, error };
  }
}