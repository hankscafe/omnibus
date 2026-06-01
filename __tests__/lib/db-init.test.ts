// __tests__/lib/db-init.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initDatabase } from '@/lib/db-init';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    countSettings: vi.fn(),
    findUniqueSetting: vi.fn(),
    createSetting: vi.fn(),
    deleteSetting: vi.fn(),
    countLibraries: vi.fn(),
    countClients: vi.fn(),
    createClient: vi.fn(),
    log: vi.fn()
}));

// 2. Mock Dependencies
vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { 
            count: mocks.countSettings,
            findUnique: mocks.findUniqueSetting,
            create: mocks.createSetting,
            delete: mocks.deleteSetting
        },
        library: { count: mocks.countLibraries },
        downloadClient: { 
            count: mocks.countClients,
            create: mocks.createClient
        },
        discordWebhook: { count: vi.fn().mockResolvedValue(1) },
        indexer: { count: vi.fn().mockResolvedValue(1) },
        customHeader: { count: vi.fn().mockResolvedValue(1) },
        searchAcronym: { count: vi.fn().mockResolvedValue(1) },
        series: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
        issue: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
        readingList: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() }
    }
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log, setLevel: vi.fn() } }));

describe('System: Database Initializer & Migrations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.countSettings.mockResolvedValue(1); // Assume encryption key exists
        mocks.countLibraries.mockResolvedValue(1); // Assume libraries exist
    });

    it('should migrate legacy download clients from JSON to DB rows and log the debug trace', async () => {
        // Simulate no download clients existing in the new table
        mocks.countClients.mockResolvedValueOnce(0);
        
        // Simulate legacy JSON config existing in system settings
        mocks.findUniqueSetting.mockImplementation(async (args) => {
            if (args.where.key === 'download_clients_config') {
                return { value: JSON.stringify([{ name: 'Old qBit', type: 'qbit' }]) };
            }
            return null;
        });

        await initDatabase();

        expect(mocks.createClient).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ name: 'Old qBit', type: 'qbit' })
        }));
        
        // Assert our new debug log was triggered
        expect(mocks.log).toHaveBeenCalledWith(
            expect.stringContaining('[DB Init Debug] Migrating legacy download client: Old qBit (qbit)'),
            'debug'
        );
        expect(mocks.deleteSetting).toHaveBeenCalledWith({ where: { key: 'download_clients_config' } });
    });
});