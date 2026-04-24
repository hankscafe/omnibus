import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateApiKey } from '@/lib/api-auth';

// 1. Tell Vitest to safely "hoist" these mock functions
const mocks = vi.hoisted(() => ({
    findUniqueApiKey: vi.fn(),
    // FIX: Provide a dummy resolved promise so .catch() doesn't throw an error!
    updateApiKey: vi.fn().mockResolvedValue({}),
    
    findUniqueOpdsKey: vi.fn(),
    // FIX: Same for OPDS keys
    updateOpdsKey: vi.fn().mockResolvedValue({}),
    
    findUniqueSystem: vi.fn().mockResolvedValue(null)
}));

// 2. Mock Prisma to prevent DATABASE_URL crashes and future-proof the suite
vi.mock('@/lib/db', () => ({
  prisma: {
    apiKey: { 
        findUnique: mocks.findUniqueApiKey, 
        update: mocks.updateApiKey 
    },
    opdsKey: { 
        findUnique: mocks.findUniqueOpdsKey, 
        update: mocks.updateOpdsKey 
    },
    systemSetting: { 
        findUnique: mocks.findUniqueSystem 
    }
  }
}));

describe('Security: API Key Validator', () => {
    beforeEach(() => {
        vi.clearAllMocks(); // Reset DB mocks between tests
    });

    it('should reject requests with no API key provided', async () => {
        const req = new Request('http://localhost/api/v1/stats');
        const result = await validateApiKey(req);
        
        expect(result.valid).toBe(false);
        expect(result.error).toBeUndefined(); 
    });

    it('should validate an Admin API key from the x-api-key header', async () => {
        const req = new Request('http://localhost/api/v1/stats', {
            headers: { 'x-api-key': 'valid_admin_key_123' }
        });

        mocks.findUniqueApiKey.mockResolvedValueOnce({
            id: '1', name: 'Test Key', keyHash: 'hashed', prefix: 'val', 
            userId: 'user_1', createdById: 'admin_1', createdAt: new Date(), 
            lastUsedAt: null, expiresAt: null,
            user: { id: 'user_1', username: 'AdminUser', role: 'ADMIN' }
        });

        const result = await validateApiKey(req);
        
        expect(result.valid).toBe(true);
        expect(result.keyType).toBe('ADMIN_KEY');
        expect(result.user?.username).toBe('AdminUser');
        expect(mocks.updateApiKey).toHaveBeenCalled();
    });

    it('should validate an OPDS Key via Basic HTTP Auth', async () => {
        const authHeader = 'Basic ' + Buffer.from('user:my_opds_key').toString('base64');
        const req = new Request('http://localhost/api/opds', {
            headers: { 'authorization': authHeader }
        });

        mocks.findUniqueApiKey.mockResolvedValueOnce(null);
        mocks.findUniqueOpdsKey.mockResolvedValueOnce({
            id: '2', name: 'OPDS Key', keyHash: 'hashed', prefix: 'opds', 
            userId: 'user_1', createdAt: new Date(), lastUsedAt: null,
            user: { id: 'user_1', username: 'StandardUser', role: 'USER' }
        });

        const result = await validateApiKey(req);
        
        expect(result.valid).toBe(true);
        expect(result.keyType).toBe('OPDS_KEY');
        expect(result.user?.username).toBe('StandardUser');
    });

    it('should reject expired API keys', async () => {
        const req = new Request('http://localhost/api/v1/stats', {
            headers: { 'x-api-key': 'expired_key_123' }
        });

        const pastDate = new Date();
        pastDate.setDate(pastDate.getDate() - 1); 

        mocks.findUniqueApiKey.mockResolvedValueOnce({
            id: '1', name: 'Expired', keyHash: 'hash', prefix: 'exp', 
            userId: 'user_1', createdById: 'admin_1', createdAt: new Date(), 
            lastUsedAt: null, expiresAt: pastDate, 
            user: {}
        });

        const result = await validateApiKey(req);
        
        expect(result.valid).toBe(false);
        expect(result.error).toBe("API Key has expired.");
    });
});