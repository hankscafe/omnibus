import { prisma } from '@/lib/db';

export async function getCustomHeaders() {
  const setting = await prisma.systemSetting.findUnique({
    where: { key: 'custom_headers' }
  });

  if (!setting || !setting.value) return {};

  try {
    const headersArray = JSON.parse(setting.value);
    const headerObj: any = {};
    headersArray.forEach((h: any) => {
      if (h.key && h.value) headerObj[h.key] = h.value;
    });
    return headerObj;
  } catch (e) {
    return {};
  }
}