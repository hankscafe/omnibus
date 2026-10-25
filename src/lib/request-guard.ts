// src/lib/request-guard.ts
//
// v1.4.10-beta.011: a search or a download that is still running never reopens a request a person
// closed meanwhile. Every automated search is queued for a PENDING request; between that and the
// search's answer (seconds to minutes), and through the download that follows, the request can be
// cancelled (My Requests), marked completed (Request Management, the Smart Matcher, the Series
// Monitor), handed to the watched folder or deleted. The search worker (queue.ts) and the direct
// downloader (download-clients.ts) used to write their outcome over whatever the request had become.
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/** Where a request is finished with: closed by a person or an import, or handed to the watched folder
 *  (import-handoff.ts settles those). A running search or download writes nothing over these. */
export const CLOSED_REQUEST_STATUSES: readonly string[] = ['CANCELLED', 'COMPLETED', 'IMPORTED', 'IMPORTING'];

/** Write `data` unless the request was closed or deleted meanwhile; says whether the write landed. */
export async function writeUnlessClosed(requestId: string, data: Prisma.RequestUpdateManyMutationInput): Promise<boolean> {
    const { count } = await prisma.request.updateMany({
        where: { id: requestId, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
        data,
    });
    return count > 0;
}
