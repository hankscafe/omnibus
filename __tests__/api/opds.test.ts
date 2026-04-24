import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/opds/route';
import * as apiAuth from '@/lib/api-auth';

// 1. Mock the API Auth module
vi.mock('@/lib/api-auth', () => ({
    validateApiKey: vi.fn()
}));

// 2. Mock the Logger
vi.mock('@/lib/logger', () => ({
    Logger: { log: vi.fn() }
}));

describe('API Route: OPDS Root Catalog', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should reject unauthorized requests with a 401 and Basic Auth challenge', async () => {
        // Simulate a bad API key
        vi.mocked(apiAuth.validateApiKey).mockResolvedValueOnce({ valid: false, user: null, keyType: null });
        
        const req = new Request('http://localhost/api/opds');
        const res = await GET(req) as Response;
        
        expect(res.status).toBe(401);
        
        // This specific header is REQUIRED to trigger the password prompt in external apps like Panels or Chunky!
        expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="Omnibus OPDS"');
    });

    it('should return valid Atom XML for an authorized user', async () => {
        // Simulate a valid API key
        vi.mocked(apiAuth.validateApiKey).mockResolvedValueOnce({ 
            valid: true, 
            user: { username: 'TestUser', role: 'USER' }, 
            keyType: 'OPDS_KEY' 
        } as any);

        const req = new Request('http://localhost/api/opds');
        const res = await GET(req) as Response;

        expect(res.status).toBe(200);
        
        // Ensure the content type is correct for OPDS clients
        expect(res.headers.get('Content-Type')).toContain('application/atom+xml');
        
        // Ensure the XML feed generates properly
        const xml = await res.text();
        expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
        expect(xml).toContain('<title>Omnibus Catalog</title>');
        expect(xml).toContain('urn:omnibus:root');
    });
});