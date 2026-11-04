// src/app/api/opds/opensearch/route.ts
//
// The OpenSearch description document (#221 point 1) that the catalog root advertises with
// `<link rel="search" type="application/opensearchdescription+xml">`. Clients read it to learn the
// search URL template; OPDS 1.2 §2.3/§3 puts search behind exactly this pair.
import { validateApiKey } from '@/lib/api-auth';
import { getErrorMessage } from '@/lib/utils/error';
import { Logger } from '@/lib/logger';
import { getPublicBaseUrl } from '@/lib/opds-base-url';
import { opdsFlavourFor } from '@/lib/opds-flavour';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    try {
        const auth = await validateApiKey(req);
        if (!auth.valid) {
            return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Omnibus OPDS"' } });
        }

        const baseUrl = getPublicBaseUrl(req);
        const flavour = opdsFlavourFor(req);

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Omnibus</ShortName>
  <Description>Search the Omnibus catalog</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Url type="application/atom+xml;profile=opds-catalog;kind=acquisition" template="${baseUrl}${flavour.base}/search?q={searchTerms}"/>
</OpenSearchDescription>`;

        return new Response(xml, {
            headers: { 'Content-Type': 'application/opensearchdescription+xml; charset=utf-8' }
        });
    } catch (error: unknown) {
        Logger.log(`[OPDS OpenSearch API] Error: ${getErrorMessage(error)}`, 'error');
        return new Response('Internal Server Error', { status: 500 });
    }
}
