import { prisma } from '@/lib/db';

export async function getCustomHeaders() {
  try {
    // NATIVE DB FETCH: Read from the new CustomHeader table
    const customHeaders = await prisma.customHeader.findMany();
    
    if (customHeaders.length === 0) return {};

    const headerObj: any = {};
    customHeaders.forEach((h: any) => {
      if (h.key && h.value) headerObj[h.key.trim()] = h.value.trim();
    });
    
    return headerObj;
  } catch (e) {
    return {};
  }
}