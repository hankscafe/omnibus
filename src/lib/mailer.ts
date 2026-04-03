// src/lib/mailer.ts
import { prisma } from './db';
import { Logger } from './logger';
import { getErrorMessage } from './utils/error';

const DEFAULT_TEMPLATES: Record<string, string> = {
    account_approved: `<h2 style="color: #f8fafc; margin-top: 0;">Welcome aboard!</h2>\n<p>Hello <strong>{{user}}</strong>,</p>\n<p>Your account has been approved by an administrator. You can now log in to your Omnibus library and begin reading.</p>`,
    comic_available: `<h2 style="color: #f8fafc; margin-top: 0;">Ready to Read</h2>\n<p>Good news!</p>\n<p>Your request for <strong>{{title}}</strong> has finished downloading and is now available in the library.</p>`,
    request_approved: `<h2 style="color: #f8fafc; margin-top: 0;">Request Accepted</h2>\n<p>Your request for <strong>{{title}}</strong> has been approved by {{user}}.</p>\n<p>It has been sent to the download client and will be available in your library shortly.</p>`,
    pending_request: `<h2 style="color: #f8fafc; margin-top: 0;">Approval Required</h2>\n<p>User <strong>{{user}}</strong> has requested <strong>{{title}}</strong>.</p>\n<p>Please review and approve the request in the Omnibus admin dashboard.</p>`,
    pending_account: `<h2 style="color: #f8fafc; margin-top: 0;">Account Approval Required</h2>\n<p>A new user <strong>{{user}}</strong> ({{email}}) has registered and is waiting for approval to access the server.</p>`,
    weekly_digest: `<h2 style="color: #f8fafc; margin-top: 0; font-size: 24px; font-weight: 800;">This Week's Additions</h2>\n<p style="color: #cbd5e1; font-size: 15px; margin-bottom: 24px;">Here are the latest issues that have been downloaded and added to your library over the past 7 days.</p>\n{{comics_html}}\n{{manga_html}}`
};

export const Mailer = {
  async getTransporter() {
    const settings = await prisma.systemSetting.findMany({
      where: { key: { in: ['smtp_enabled', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from'] } }
    });
    const config = Object.fromEntries(settings.map(s => [s.key, s.value]));

    if (config.smtp_enabled !== 'true' || !config.smtp_host) return null;

    let nodemailer;
    try {
        nodemailer = await import('nodemailer');
    } catch (e) {
        Logger.log("[Mailer] 'nodemailer' package is not installed. Run 'npm install nodemailer'", "error");
        return null;
    }

    return {
      transporter: nodemailer.createTransport({
        host: config.smtp_host,
        port: parseInt(config.smtp_port || '587'),
        secure: parseInt(config.smtp_port || '587') === 465,
        auth: config.smtp_user ? {
          user: config.smtp_user,
          pass: config.smtp_pass,
        } : undefined,
      }),
      from: config.smtp_from || 'omnibus@localhost'
    };
  },

  async getAdminEmails() {
     const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { email: true } });
     return admins.map(a => a.email);
  },

  // Base HTML template formatted to match the Omnibus dark slate theme and Login Header
  getBaseTemplate(content: string) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; margin: 0; padding: 0; color: #cbd5e1; }
      </style>
    </head>
    <body style="background-color: #0f172a; margin: 0; padding: 0; color: #cbd5e1;">
      <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px; font-family: sans-serif;">
        <div style="background-color: #1e293b; border-radius: 12px; border: 1px solid #334155; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.3);">
          <div style="background-color: #020817; padding: 30px; text-align: center; border-bottom: 4px solid #3b82f6;">
            <h1 style="color: #ffffff; margin: 0; font-size: 32px; font-weight: 900; letter-spacing: 8px; font-family: Arial, sans-serif;">OMNIBUS</h1>
            <p style="color: #94a3b8; margin: 8px 0 0 0; font-size: 12px; font-weight: bold; letter-spacing: 4px; font-family: Arial, sans-serif;">YOUR UNIVERSE. ORGANIZED.</p>
          </div>
          <div style="padding: 32px 24px; color: #cbd5e1; line-height: 1.6; font-size: 16px;">
            ${content}
          </div>
        </div>
        <div style="text-align: center; padding: 24px 20px;">
          <h2 style="color: #64748b; margin: 0; font-size: 16px; font-weight: 900; letter-spacing: 6px; font-family: Arial, sans-serif;">OMNIBUS</h2>
        </div>
      </div>
    </body>
    </html>
    `;
  },

  async getTemplate(templateKey: string, variables: Record<string, string>) {
      const setting = await prisma.systemSetting.findUnique({ where: { key: `email_template_${templateKey}` } });
      let template = setting?.value || DEFAULT_TEMPLATES[templateKey] || "";

      for (const [key, value] of Object.entries(variables)) {
          template = template.replace(new RegExp(`{{${key}}}`, 'g'), value || '');
      }
      return template;
  },

  async sendAlert(event: string, payload: any) {
     try {
         const mailConfig = await this.getTransporter();
         if (!mailConfig) return;

         let to: string[] = [];
         let subject = '';
         let content = '';

         const variables: Record<string, string> = {
             user: payload.user || '',
             title: payload.title || '',
             email: payload.email || ''
         };

         switch(event) {
             case 'account_approved':
                 if (!payload.email) return;
                 to = [payload.email];
                 subject = 'Your Omnibus Account has been Approved!';
                 content = await this.getTemplate('account_approved', variables);
                 break;
             case 'comic_available':
                 if (!payload.email) return;
                 to = [payload.email];
                 subject = `Request Complete: ${payload.title}`;
                 content = await this.getTemplate('comic_available', variables);
                 break;
             case 'request_approved':
                 if (!payload.email) return;
                 to = [payload.email];
                 subject = `Request Approved: ${payload.title}`;
                 content = await this.getTemplate('request_approved', variables);
                 break;
             case 'pending_request':
                 to = await this.getAdminEmails();
                 subject = `New Request Pending: ${payload.title}`;
                 content = await this.getTemplate('pending_request', variables);
                 break;
             case 'pending_account':
                 to = await this.getAdminEmails();
                 subject = `New Account Pending: ${payload.user}`;
                 content = await this.getTemplate('pending_account', variables);
                 break;
             default:
                 return; // Unhandled event
         }

         if (to.length === 0) return;

         await mailConfig.transporter.sendMail({
             from: `"Omnibus" <${mailConfig.from}>`,
             to: to.join(', '),
             subject: subject,
             html: this.getBaseTemplate(content)
         });

         Logger.log(`[Mailer] Sent '${event}' email to ${to.join(', ')}`, 'success');

     } catch (error) {
         Logger.log(`[Mailer] Error sending email: ${getErrorMessage(error)}`, 'error');
     }
  },

  // Exposes HTML building for both the Test UI route and the actual automated Queue
  async buildWeeklyDigestHtml(comics: any[], manga: any[]) {
      const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';

      const buildGrid = (items: any[], accentColor: string) => {
          let html = '';
          for (let i = 0; i < items.length; i += 2) {
              const item1 = items[i];
              const item2 = items[i + 1];
              
              const renderItem = (item: any) => {
                  if (!item) return `<td width="48%" valign="top" style="padding: 15px;"></td>`;
                  const finalCover = item.coverUrl ? (item.coverUrl.startsWith('http') ? item.coverUrl : `${baseUrl}${item.coverUrl}`) : `${baseUrl}/favicon.ico`;
                  let desc = item.description || "No synopsis available.";
                  desc = desc.replace(/(<([^>]+)>)/gi, "");
                  if (desc.length > 120) desc = desc.substring(0, 117) + '...';

                  return `
                  <td width="48%" valign="top" style="padding: 15px; box-sizing: border-box; background-color: #0f172a; border: 1px solid #334155; border-radius: 8px;">
                      <table width="100%" cellpadding="0" cellspacing="0" border="0">
                          <tr>
                              <td align="center" style="padding-bottom: 15px;">
                                  <img src="${finalCover}" alt="Cover" style="width: 100%; max-width: 180px; height: 270px; object-fit: cover; border-radius: 6px; box-shadow: 0 4px 6px rgba(0,0,0,0.4); background-color: #1e293b;" />
                              </td>
                          </tr>
                          <tr>
                              <td>
                                  <h4 style="margin: 0 0 6px 0; font-size: 16px; color: #f8fafc; line-height: 1.3;">${item.name}</h4>
                                  <p style="margin: 0 0 6px 0; font-size: 13px; color: ${accentColor}; font-weight: bold;">New Issues: ${item.issues.join(', ')}</p>
                                  <p style="margin: 0 0 8px 0; font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px;">${item.publisher} &bull; ${item.year}</p>
                                  <p style="margin: 0; font-size: 12px; color: #cbd5e1; line-height: 1.5;">${desc}</p>
                              </td>
                          </tr>
                      </table>
                  </td>`;
              };

              html += `
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 15px;">
                  <tr>
                      ${renderItem(item1)}
                      <td width="4%"></td>
                      ${renderItem(item2)}
                  </tr>
              </table>`;
          }
          return html;
      };

      let comicsHtml = "";
      if (comics.length > 0) {
          comicsHtml += `<h3 style="color: #3b82f6; border-bottom: 2px solid #334155; padding-bottom: 8px; margin-top: 24px; margin-bottom: 16px; font-size: 18px; text-transform: uppercase; letter-spacing: 1px;">Recently Added Comics</h3>\n${buildGrid(comics, '#3b82f6')}`;
      }

      let mangaHtml = "";
      if (manga.length > 0) {
          mangaHtml += `<h3 style="color: #f97316; border-bottom: 2px solid #334155; padding-bottom: 8px; margin-top: 24px; margin-bottom: 16px; font-size: 18px; text-transform: uppercase; letter-spacing: 1px;">Recently Added Manga</h3>\n${buildGrid(manga, '#f97316')}`;
      }

      const content = await this.getTemplate('weekly_digest', {
          comics_html: comicsHtml,
          manga_html: mangaHtml
      });

      return this.getBaseTemplate(content);
  },

  async sendWeeklyDigest(toEmails: string[], comics: any[], manga: any[]) {
      try {
          const mailConfig = await this.getTransporter();
          if (!mailConfig || toEmails.length === 0) return;

          const htmlContent = await this.buildWeeklyDigestHtml(comics, manga);

          await mailConfig.transporter.sendMail({
              from: `"Omnibus" <${mailConfig.from}>`,
              to: toEmails.join(', '),
              subject: "Omnibus - Weekly Library Digest",
              html: htmlContent
          });

          Logger.log(`[Mailer] Sent Weekly Digest to ${toEmails.length} users`, 'success');
      } catch (error) {
          Logger.log(`[Mailer] Error sending weekly digest: ${getErrorMessage(error)}`, 'error');
      }
  }
};