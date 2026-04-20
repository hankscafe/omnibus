// src/lib/notifications.ts
import axios from 'axios';
import { prisma } from './db';
import { Logger } from './logger';
import { DiscordNotifier } from './discord';
import { Mailer } from './mailer';
import { getErrorMessage } from './utils/error';

export const SystemNotifier = {
    async sendAlert(event: string, payload: any) {
        // 1. Fetch generic settings for third-party push providers
        const settings = await prisma.systemSetting.findMany({
            where: {
                key: { in: [
                    'discord_enabled',
                    'pushover_enabled', 'pushover_token', 'pushover_user', 'pushover_events',
                    'telegram_enabled', 'telegram_bot_token', 'telegram_chat_id', 'telegram_events',
                    'apprise_enabled', 'apprise_url', 'apprise_events'
                ] }
            }
        });
        const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

        // 2. Trigger existing native Discord Webhooks & Email Mailer
        // (Default to true if missing for backward compatibility)
        if (config.discord_enabled !== 'false') {
            await DiscordNotifier.sendAlert(event, payload).catch(()=>{});
        }
        await Mailer.sendAlert(event, payload).catch(()=>{});

        const title = payload.title || 'Omnibus Alert';
        const message = payload.description || `System Event: ${event} triggered.`;

        // PUSHOVER
        if (config.pushover_enabled === 'true' && config.pushover_token && config.pushover_user) {
            try {
                const events = JSON.parse(config.pushover_events || '[]');
                if (events.includes(event)) {
                    await axios.post('https://api.pushover.net/1/messages.json', {
                        token: config.pushover_token,
                        user: config.pushover_user,
                        title: title,
                        message: message,
                        html: 1
                    });
                }
            } catch(e) { Logger.log(`[Pushover] Error: ${getErrorMessage(e)}`, 'error'); }
        }

        // TELEGRAM
        if (config.telegram_enabled === 'true' && config.telegram_bot_token && config.telegram_chat_id) {
            try {
                const events = JSON.parse(config.telegram_events || '[]');
                if (events.includes(event)) {
                    const text = `*${title}*\n${message}`;
                    await axios.post(`https://api.telegram.org/bot${config.telegram_bot_token}/sendMessage`, {
                        chat_id: config.telegram_chat_id,
                        text: text,
                        parse_mode: 'Markdown'
                    });
                }
            } catch(e) { Logger.log(`[Telegram] Error: ${getErrorMessage(e)}`, 'error'); }
        }

        // APPRISE
        if (config.apprise_enabled === 'true' && config.apprise_url) {
             try {
                const events = JSON.parse(config.apprise_events || '[]');
                if (events.includes(event)) {
                    await axios.post(config.apprise_url, {
                        title: title,
                        body: message,
                        format: 'markdown'
                    });
                }
            } catch(e) { Logger.log(`[Apprise] Error: ${getErrorMessage(e)}`, 'error'); }
        }
    }
}