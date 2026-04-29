// src/lib/discord.ts
import axios from 'axios';
import { prisma } from './db';
import { Logger } from './logger';
import { getErrorMessage } from './utils/error';

interface DiscordEmbed {
    title?: string;
    description?: string;
    color?: number;
    timestamp: string;
    footer: { text: string };
    fields: { name: string; value: string; inline: boolean }[];
    thumbnail?: { url: string };
}

export const DiscordNotifier = {
  async sendAlert(event: string, payload: { 
    title?: string, 
    description?: string | null, 
    imageUrl?: string | null, 
    user?: string | null,
    email?: string, 
    date?: string,
    publisher?: string | null,
    year?: string | null,
    version?: string | null
  }) {
    try {
      const webhooks = await prisma.discordWebhook.findMany({
          where: { isActive: true }
      });

      if (webhooks.length === 0) return;

      const activeWebhooks = webhooks.filter(w => {
          try {
              const events = JSON.parse(w.events);
              return Array.isArray(events) && events.includes(event);
          } catch(e: unknown) { return false; }
      });

      if (activeWebhooks.length === 0) return;

      // Type-safe Embed!
      const embed: DiscordEmbed = {
        timestamp: new Date().toISOString(),
        footer: { text: "Omnibus" },
        fields: []
      };

      if (payload.imageUrl) {
          embed.thumbnail = { url: payload.imageUrl };
      }

      const appendMetadata = () => {
          if (payload.publisher && payload.publisher !== "Unknown" && payload.publisher !== "Other") {
              embed.fields.push({ name: "Publisher", value: payload.publisher, inline: true });
          }
          if (payload.year && payload.year !== "????") {
              embed.fields.push({ name: "Release Year", value: payload.year, inline: true });
          }
          if (payload.description) {
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
          
        case 'account_approved':
          embed.title = "🎉 Account Approved";
          embed.description = `**${payload.user || "A new user"}** has been approved and granted access to Omnibus.`;
          embed.color = 3066993; // Green
          if (payload.email) embed.fields.push({ name: "Email", value: payload.email, inline: true });
          break;

        case 'system_alert':
          embed.title = "⚠️ System Health Alert";
          embed.description = payload.description || "A system event requires attention.";
          embed.color = 15844367; // Yellow
          break;

        case 'update_available':
          embed.title = "🚀 System Update Available!";
          embed.description = payload.description || `A new version of Omnibus is available on GitHub.`;
          embed.color = 3447003; // Blue
          if (payload.version) embed.fields.push({ name: "Latest Version", value: payload.version, inline: true });
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

        case 'job_db_backup':
          embed.title = "💾 Database Backup Complete";
          embed.description = payload.description || "The automated database backup completed successfully.";
          embed.color = 3066993; // Green
          break;

        case 'job_library_scan':
          embed.title = "📂 Library Auto-Scan Complete";
          embed.description = payload.description || "The automated library scan has finished running.";
          embed.color = 3447003; // Blue
          break;

        case 'job_metadata_sync':
          embed.title = "🔍 Deep Metadata Sync Complete";
          embed.description = payload.description || "The deep metadata sync has finished processing the library.";
          embed.color = 10181046; // Purple
          break;

        case 'job_issue_monitor':
          embed.title = "📅 New Issue Monitor Complete";
          embed.description = payload.description || "Successfully checked for new releases for monitored series.";
          embed.color = 3066993; // Green
          break;

        case 'job_discover_sync':
          embed.title = "🌐 Discover Sync Complete";
          embed.description = payload.description || "The discover timeline and popular comics have been refreshed.";
          embed.color = 3447003; // Blue
          break;

        case 'job_diagnostics':
          embed.title = "🩺 System Diagnostics Complete";
          embed.description = payload.description || "Automated system diagnostics have been run.";
          embed.color = 15844367; // Yellow
          break;

        case 'job_cache_cleanup':
          embed.title = "🗑️ Cache Cleanup Complete";
          embed.description = payload.description || "The automated cache cleanup has finished running.";
          embed.color = 9807270; // Gray
          break;
      }

      for (const hook of activeWebhooks) {
        // Build payload cleanly without any
        const discordPayload: Record<string, unknown> = { embeds: [embed] };
        
        if (hook.botUsername) discordPayload.username = hook.botUsername;
        if (hook.botAvatarUrl) discordPayload.avatar_url = hook.botAvatarUrl;

        await axios.post(hook.url, discordPayload).catch((e: unknown) => {
            Logger.log(`[Discord] Failed to send webhook to ${hook.name}: ${getErrorMessage(e)}`, "error");
        });
      }
    } catch (error: unknown) {
      Logger.log(`[Discord] Error processing webhooks: ${getErrorMessage(error)}`, "error");
    }
  }
};