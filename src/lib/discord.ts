import axios from 'axios';
import { prisma } from './db';
import { Logger } from './logger';

export const DiscordNotifier = {
  async sendAlert(event: string, payload: { 
    title: string, 
    description?: string | null, 
    imageUrl?: string | null, 
    user?: string | null,
    email?: string, 
    date?: string,
    publisher?: string | null,
    year?: string | null
  }) {
    try {
      const setting = await prisma.systemSetting.findUnique({ where: { key: 'discord_webhooks' } });
      if (!setting?.value) return;

      let webhooks: any[] = [];
      try {
          webhooks = JSON.parse(setting.value);
      } catch (e) { return; }

      const activeWebhooks = webhooks.filter(w => w.isActive && w.events.includes(event));
      if (activeWebhooks.length === 0) return;

      let embed: any = {
        timestamp: new Date().toISOString(),
        footer: { text: "Omnibus" },
        fields: []
      };

      if (payload.imageUrl) {
          embed.thumbnail = { url: payload.imageUrl };
      }

      // Helper to uniformly inject rich metadata across all comic events
      const appendMetadata = () => {
          if (payload.publisher && payload.publisher !== "Unknown" && payload.publisher !== "Other") {
              embed.fields.push({ name: "Publisher", value: payload.publisher, inline: true });
          }
          if (payload.year && payload.year !== "????") {
              embed.fields.push({ name: "Release Year", value: payload.year, inline: true });
          }
          if (payload.description) {
              // Strip HTML tags from ComicVine synopses
              let cleanDesc = payload.description.replace(/(<([^>]+)>)/gi, "").replace(/&nbsp;/gi, " ").trim();
              if (cleanDesc.length > 250) cleanDesc = cleanDesc.substring(0, 247) + "...";
              if (cleanDesc.length > 0) {
                  embed.fields.push({ name: "Synopsis", value: cleanDesc, inline: false });
              }
          }
      };

      switch (event) {
        case 'comic_available':
          embed.title = "📗 Comic Available!";
          embed.description = `**${payload.title}** has been successfully imported and is ready to read.`;
          embed.color = 3066993; // Green
          appendMetadata();
          if (payload.user) embed.fields.push({ name: "Requested By", value: payload.user, inline: true });
          break;

        case 'pending_request':
          embed.title = "🔔 New Request Pending";
          embed.description = `**${payload.title}** is waiting for admin approval.`;
          embed.color = 15105570; // Orange
          appendMetadata();
          if (payload.user) embed.fields.push({ name: "Requested By", value: payload.user, inline: true });
          break;

        case 'request_approved':
          embed.title = "✅ Request Approved";
          embed.description = `**${payload.title}** has been approved and is now downloading.`;
          embed.color = 3447003; // Blue
          appendMetadata();
          if (payload.user) embed.fields.push({ name: "Approved By", value: payload.user, inline: true });
          break;

        case 'download_failed':
          embed.title = "❌ Download Failed";
          embed.description = `Encountered an error downloading **${payload.title}**.`;
          embed.color = 15158332; // Red
          appendMetadata();
          if (payload.user) embed.fields.push({ name: "Requester", value: payload.user, inline: true });
          break;

        case 'pending_account':
          embed.title = "👤 New Account Pending Approval";
          embed.color = 10181046; // Purple
          embed.fields.push(
            { name: "Username", value: payload.user || "Unknown", inline: true },
            { name: "Email", value: payload.email || "Unknown", inline: true },
            { name: "Requested On", value: payload.date || new Date().toLocaleDateString(), inline: false }
          );
          break;
          
        case 'system_alert':
          embed.title = "⚠️ System Health Alert";
          embed.description = payload.description || "A system event requires attention.";
          embed.color = 15844367; // Yellow
          break;

        case 'library_cleanup':
          embed.title = "🗑️ Library Cleanup";
          embed.description = `**${payload.title}** has been deleted from the library.`;
          embed.color = 9807270; // Gray
          if (payload.description) embed.fields.push({ name: "Details", value: payload.description, inline: false });
          if (payload.user) embed.fields.push({ name: "Deleted By", value: payload.user, inline: true });
          break;

        case 'metadata_match':
          embed.title = "✨ Metadata Matched!";
          embed.description = `**${payload.title}** has been successfully matched to ComicVine!`;
          embed.color = 15844367; // Gold
          appendMetadata();
          if (payload.user) embed.fields.push({ name: "Matched By", value: payload.user, inline: true });
          break;
      }

      for (const hook of activeWebhooks) {
        await axios.post(hook.url, { embeds: [embed] }).catch(e => {
            Logger.log(`[Discord] Failed to send webhook to ${hook.name}`, "error");
        });
      }
    } catch (error) {
      Logger.log(`[Discord] Error processing webhooks`, "error");
    }
  }
};