// src/app/komga/api/v1/[...rest]/route.ts — #206 Komga facade: every /komga/api/v1 path no route
// answers. Next would render its HTML not-found page, which Paperback's source JSON.parses into an
// error; a Komga-style JSON 404 parses, and the source shows nothing instead of failing. Every
// specific route, static or [id], takes precedence over this catch-all.
import { komgaError } from '@/lib/komga/auth';

export const dynamic = 'force-dynamic';

function notFound(req: Request): Response {
    return komgaError(404, new URL(req.url).pathname.replace(/^\/komga/, ''));
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
