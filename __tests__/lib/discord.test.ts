import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordNotifier } from '@/lib/discord';
import axios from 'axios';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findManyWebhooks: vi.fn(),
    log: vi.fn()
}));

// 2. Mock Axios and Dependencies
vi.mock('axios');
vi.mock('@/lib/db', () => ({
    prisma: { discordWebhook: { findMany: mocks.findManyWebhooks } }
}));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

describe('Notifications: Discord Webhooks', () => {
    beforeEach(() => { 
        vi.clearAllMocks(); 
    });

    it('should do nothing and exit cleanly if no webhooks are configured', async () => {
        mocks.findManyWebhooks.mockResolvedValueOnce([]); // Empty array = no webhooks
        
        await DiscordNotifier.sendAlert('comic_available', { title: 'Batman' });
        
        expect(axios.post).not.toHaveBeenCalled();
    });

    it('should send a correctly formatted embed for a new pending request', async () => {
        mocks.findManyWebhooks.mockResolvedValueOnce([
            { id: '1', url: 'http://discord.com/api/webhooks/123', isActive: true, events: JSON.stringify(['pending_request']) }
        ]);
        vi.mocked(axios.post).mockResolvedValueOnce({ status: 200 } as any);

        await DiscordNotifier.sendAlert('pending_request', {
            title: 'Spider-Man #1',
            user: 'PeterParker',
            publisher: 'Marvel Comics'
        });

        expect(axios.post).toHaveBeenCalledTimes(1);
        
        // Grab the exact JSON payload sent to axios.post
        const payload = vi.mocked(axios.post).mock.calls[0][1] as any;
        
        // Assert the visual formatting is correct
        expect(payload.embeds[0].title).toBe('🔔 New Request Pending');
        expect(payload.embeds[0].fields).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'Requested By', value: 'PeterParker' }),
            expect.objectContaining({ name: 'Publisher', value: 'Marvel Comics' })
        ]));
    });

    it('should truncate extremely long descriptions to prevent Discord API rejections', async () => {
        mocks.findManyWebhooks.mockResolvedValueOnce([
            { id: '1', url: 'http://webhook', isActive: true, events: JSON.stringify(['comic_available']) }
        ]);
        vi.mocked(axios.post).mockResolvedValueOnce({ status: 200 } as any);

        // Generate a massive 500-character description
        const longDesc = "A".repeat(500);
        await DiscordNotifier.sendAlert('comic_available', { title: 'Test Comic', description: longDesc });

        const payload = vi.mocked(axios.post).mock.calls[0][1] as any;
        const descField = payload.embeds[0].fields.find((f: any) => f.name === 'Synopsis');
        
        // Omnibus should truncate it down to 250 characters (247 + "...")
        expect(descField.value.length).toBeLessThanOrEqual(255);
        expect(descField.value.endsWith('...')).toBe(true);
    });
});