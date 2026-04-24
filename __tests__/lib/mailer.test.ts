import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Mailer } from '@/lib/mailer';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findUniqueSetting: vi.fn(),
    findManySettings: vi.fn()
}));

// 2. Mock Prisma and Nodemailer
vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { 
            findUnique: mocks.findUniqueSetting,
            findMany: mocks.findManySettings 
        }
    }
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));

describe('Communications: Email Mailer Engine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should correctly parse templates and inject dynamic variables', async () => {
        // Mock a custom user-defined template in the database
        mocks.findUniqueSetting.mockResolvedValueOnce({
            value: '<h1>Hello {{user}}!</h1> <p>You requested {{title}}.</p>'
        });

        const result = await Mailer.getTemplate('request_approved', {
            user: 'Bruce Wayne',
            title: 'Detective Comics #27'
        });

        expect(result).toBe('<h1>Hello Bruce Wayne!</h1> <p>You requested Detective Comics #27.</p>');
    });

    it('should correctly format multiple comics into the HTML grid', async () => {
        // Create 3 dummy comics
        const dummyComics = Array.from({ length: 3 }, (_, i) => ({
            name: `Comic Series ${i}`,
            issues: ['#1', '#2'],
            coverUrl: null,
            publisher: 'DC',
            year: '2024',
            description: 'Test'
        }));

        // Pass to mailer
        const payload = await Mailer.buildWeeklyDigestPayload(dummyComics, []);

        // The HTML payload should correctly render all 3 items into the table grid
        const html = payload.html;
        
        expect(html).toContain('Comic Series 0');
        expect(html).toContain('Comic Series 1');
        expect(html).toContain('Comic Series 2');
    });
});