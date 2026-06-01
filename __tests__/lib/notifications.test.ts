// __tests__/lib/notifications.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SystemNotifier } from '@/lib/notifications';
import axios from 'axios';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findManySettings: vi.fn(),
    log: vi.fn(),
    discordSend: vi.fn().mockResolvedValue(true),
    mailerSend: vi.fn().mockResolvedValue(true)
}));

// 2. Mock Dependencies
vi.mock('axios');
vi.mock('@/lib/db', () => ({
    prisma: { systemSetting: { findMany: mocks.findManySettings } }
}));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('@/lib/discord', () => ({ DiscordNotifier: { sendAlert: mocks.discordSend } }));
vi.mock('@/lib/mailer', () => ({ Mailer: { sendAlert: mocks.mailerSend } }));

describe('Communications: System Notifier', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should dispatch a Pushover alert and log the debug trace if configured', async () => {
        mocks.findManySettings.mockResolvedValueOnce([
            { key: 'pushover_enabled', value: 'true' },
            { key: 'pushover_token', value: 'push_token' },
            { key: 'pushover_user', value: 'push_user' },
            { key: 'pushover_events', value: JSON.stringify(['comic_available']) }
        ]);

        vi.mocked(axios.post).mockResolvedValueOnce({ status: 200 } as any);

        await SystemNotifier.sendAlert('comic_available', { title: 'Batman #1' });

        expect(axios.post).toHaveBeenCalledWith(
            'https://api.pushover.net/1/messages.json',
            expect.objectContaining({ title: 'Batman #1', token: 'push_token', user: 'push_user' })
        );

        // Assert our new debug log was triggered
        expect(mocks.log).toHaveBeenCalledWith(
            expect.stringContaining("[Pushover Debug] Dispatching 'comic_available' alert."),
            'debug'
        );
    });
});