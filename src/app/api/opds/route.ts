// src/app/api/opds/route.ts
import { validateApiKey } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    // 1. Authenticate the request via HTTP Basic Auth
    const auth = await validateApiKey(req);
    if (!auth.valid) {
        return new Response('Unauthorized', { 
            status: 401, 
            headers: { 'WWW-Authenticate': 'Basic realm="Omnibus OPDS"' } 
        });
    }

    const baseUrl = new URL(req.url).origin;

    // 2. Generate the Root OPDS XML
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:omnibus:root</id>
  <title>Omnibus Catalog</title>
  <updated>${new Date().toISOString()}</updated>
  <author><name>Omnibus</name></author>
  <link rel="self" href="${baseUrl}/api/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="start" href="${baseUrl}/api/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  
  <entry>
    <title>All Series</title>
    <id>urn:omnibus:series:all</id>
    <updated>${new Date().toISOString()}</updated>
    <content type="text">Browse all comic and manga series in your library.</content>
    <link rel="subsection" href="${baseUrl}/api/opds/series" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  </entry>
</feed>`;

    return new Response(xml, {
        headers: { 'Content-Type': 'application/atom+xml;profile=opds-catalog; charset=utf-8' }
    });
}