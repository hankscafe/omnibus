// src/app/api/admin/test/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import axios from 'axios';
import { getErrorMessage } from '@/lib/utils/error';
import { decryptSecret } from '@/lib/encryption';
import { Logger } from '@/lib/logger';
import { Mailer } from '@/lib/mailer';
import { testAnnasArchiveKey } from '@/lib/annas-test';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

export async function POST(request: Request) {
  let type = 'unknown';

  try {
    // --- SECURITY ENFORCEMENT ---
    const setupStatus = await prisma.systemSetting.findUnique({ where: { key: 'setup_complete' } });
    if (setupStatus?.value === 'true') {
        const authOptions = await getAuthOptions();
        const session = await getServerSession(authOptions);
        if (session?.user?.role !== 'ADMIN') {
            return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
        }
    }

    const body = await request.json();
    type = body.type || 'unknown';
    const { config } = body;

    let headers: any = {
        'User-Agent': 'Omnibus/1.0',
        'Content-Type': 'application/json'
    };

    if (config.custom_headers) {
        try {
            const hData = typeof config.custom_headers === 'string' 
                 ? JSON.parse(config.custom_headers) 
                 : config.custom_headers;
                 
            if (Array.isArray(hData)) {
                // Fetch the real headers from the DB once to avoid multiple queries
                const dbHeaders = await prisma.customHeader.findMany();
                
                hData.forEach((h: any) => { 
                     if (h.key && h.value) {
                         // If masked, pull the real value using the ID
                         if (h.value === '********') {
                             const realHeader = dbHeaders.find(eh => eh.id === h.id);
                             if (realHeader) headers[h.key] = realHeader.value;
                         } else {
                             headers[h.key] = h.value;
                         }
                     } 
                 });
            }
        } catch (e) { }
    }

    const getRealValue = async (key: string, providedValue: string) => {
        if (providedValue === '********') {
            const setting = await prisma.systemSetting.findUnique({ where: { key } });
            return setting?.value || "";
        }
        return providedValue;
    };

    // --- PUSHOVER TEST ---
    if (type === 'pushover') {
        const realToken = await getRealValue('pushover_token', config.pushover_token);

        if (!realToken || !config.pushover_user) {
            return NextResponse.json({ success: false, message: 'Missing Token or User Key.' });
        }
        const res = await axios.post('https://api.pushover.net/1/messages.json', {
            token: realToken, // <-- USE REAL TOKEN
            user: config.pushover_user,
            title: "Omnibus Test",
            message: "✅ Pushover connection successful!"
        });
        return NextResponse.json({ success: res.status === 200, message: "Push notification sent successfully." });
    }

    // --- TELEGRAM TEST ---
    if (type === 'telegram') {
        const realToken = await getRealValue('telegram_bot_token', config.telegram_bot_token);

        if (!realToken || !config.telegram_chat_id) {
            return NextResponse.json({ success: false, message: 'Missing Bot Token or Chat ID.' });
        }
        const res = await axios.post(`https://api.telegram.org/bot${realToken}/sendMessage`, { // <-- USE REAL TOKEN
            chat_id: config.telegram_chat_id,
            text: "*Omnibus Test*\n✅ Telegram connection successful!",
            parse_mode: 'Markdown'
        });
        return NextResponse.json({ success: res.status === 200, message: "Telegram message sent successfully." });
    }

    // --- APPRISE TEST ---
    if (type === 'apprise') {
        const realAppriseUrl = await getRealValue('apprise_url', config.apprise_url); // <-- ADDED
        
        if (!realAppriseUrl) {
            return NextResponse.json({ success: false, message: 'Missing Apprise URL.' });
        }
        
        const res = await axios.post(realAppriseUrl, { // <-- UPDATED
            title: "Omnibus Test",
            body: "✅ Apprise connection successful!",
            format: 'markdown'
        });
        
        return NextResponse.json({ success: res.status === 200, message: "Apprise notification sent successfully." });
    }

    // --- SMTP TEST ---
    if (type === 'smtp' || type === 'smtp_digest') {
        const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, test_email } = config;
        if (!smtp_host || !smtp_port || !test_email) {
            return NextResponse.json({ success: false, message: 'Missing Host, Port, or Test Email.' });
        }

        const realPass = await getRealValue('smtp_pass', smtp_pass);
        
        let nodemailer;
        try {
            nodemailer = await import('nodemailer');
        } catch (e) {
            return NextResponse.json({ success: false, message: "Missing 'nodemailer' package. Please run 'npm install nodemailer' in your terminal." });
        }

        const transporter = nodemailer.createTransport({
            host: smtp_host,
            port: parseInt(smtp_port),
            secure: parseInt(smtp_port) === 465,
            auth: smtp_user ? {
                user: smtp_user,
                pass: realPass
            } : undefined
        });

        if (type === 'smtp') {
            await transporter.sendMail({
                from: smtp_from || 'omnibus@localhost',
                to: test_email,
                subject: "Omnibus SMTP Test",
                text: "If you are reading this, your Omnibus SMTP configuration is working perfectly!"
            });
            return NextResponse.json({ success: true, message: `Test email sent to ${test_email}` });
        } else {
            const dummyComics = [
                {
                    name: "Batman",
                    issues: ["#132", "#133"],
                    coverUrl: "https://comicvine.gamespot.com/a/uploads/scale_large/6/67663/8856799-132a.jpg",
                    publisher: "DC Comics",
                    year: "2016",
                    description: "The Dark Knight faces his greatest challenge as Gotham descends into chaos..."
                },
                {
                    name: "Amazing Spider-Man",
                    issues: ["#24"],
                    coverUrl: "https://comicvine.gamespot.com/a/uploads/scale_large/12/124259/9002237-large-1191590.jpg",
                    publisher: "Marvel",
                    year: "2022",
                    description: "Peter Parker's life takes a dramatic turn after a startling revelation..."
                }
            ];

            const dummyManga = [
                {
                    name: "Chainsaw Man",
                    issues: ["Vol. 12"],
                    coverUrl: "https://comicvine.gamespot.com/a/uploads/scale_large/11136/111365313/8660341-c11.jpg",
                    publisher: "Shueisha",
                    year: "2018",
                    description: "Denji's a poor young man who'll do anything for money..."
                }
            ];

            const payload = await Mailer.buildWeeklyDigestPayload(dummyComics, dummyManga);

            await transporter.sendMail({
                from: smtp_from || 'omnibus@localhost',
                to: test_email,
                subject: "Omnibus Weekly Digest (Test)",
                html: payload.html,
                attachments: payload.attachments
            });

            return NextResponse.json({ success: true, message: `Weekly digest test sent to ${test_email}` });
        }
    }

    // --- CLIENTS TEST ---
    if (type === 'clients') {
        const { clientType, url, user, pass, apiKey } = config;
        const cleanUrl = url?.replace(/\/$/, "");

        if (!cleanUrl) return NextResponse.json({ success: false, message: 'Missing Client URL' });

        if (clientType === 'qbit') {
            const loginParams = new URLSearchParams();
            loginParams.append('username', user || '');
            
            const realPass = (pass === '********') 
                ? await decryptSecret((await prisma.downloadClient.findFirst({ where: { url: config.url } }))?.pass ?? null) || ""
                : pass;

            loginParams.append('password', realPass || '');

            const qbitHeaders = { 
                ...headers, 
                'Content-Type': 'application/x-www-form-urlencoded' 
            };

            const authRes = await axios.post(`${cleanUrl}/api/v2/auth/login`, loginParams, {
                headers: qbitHeaders,
                timeout: 5000 
            });

            if (authRes.data === 'Ok.') {
                return NextResponse.json({ success: true, message: 'qBittorrent Connected Successfully!' });
            } else {
                throw new Error("Authentication failed. Check username/password.");
            }
        } 
        else if (clientType === 'sab') {
            const realApiKey = (apiKey === '********')
                ? await decryptSecret((await prisma.downloadClient.findFirst({ where: { url: config.url } }))?.apiKey ?? null) || ""
                : apiKey;

            const res = await axios.get(`${cleanUrl}/api`, {
                params: { mode: 'version', apikey: realApiKey, output: 'json' },
                headers,
                timeout: 5000
            });
            if (res.data && res.data.version) {
                return NextResponse.json({ success: true, message: `SABnzbd Connected! (v${res.data.version})` });
            } else {
                throw new Error("Invalid API Key or response.");
            }
        }
        else if (clientType === 'nzbget') {
            const realPass = (pass === '********') 
                ? await decryptSecret((await prisma.downloadClient.findFirst({ where: { url: config.url } }))?.pass ?? null) || ""
                : pass;
            const auth = Buffer.from(`${user || ''}:${realPass || ''}`).toString('base64');
            const res = await axios.post(`${cleanUrl}/jsonrpc`, { method: "version", params: [] }, { headers: { ...headers, Authorization: `Basic ${auth}` }, timeout: 5000 });
            if (res.data && res.data.result) {
                return NextResponse.json({ success: true, message: `NZBGet Connected! (v${res.data.result})` });
            } else {
                throw new Error("Invalid credentials or response.");
            }
        }
        else if (clientType === 'deluge') {
            const realPass = (pass === '********') 
                ? await decryptSecret((await prisma.downloadClient.findFirst({ where: { url: config.url } }))?.pass ?? null) || ""
                : pass;
            const authRes = await axios.post(`${cleanUrl}/json`, { method: "auth.login", params: [realPass || ''], id: 1 }, { headers, timeout: 5000 });
            if (authRes.data && authRes.data.result) {
                return NextResponse.json({ success: true, message: `Deluge Connected!` });
            } else {
                throw new Error("Deluge Authentication Failed. Check password.");
            }
        }
        
        return NextResponse.json({ success: true, message: 'Client Ping Sent.' });
    }

    // --- DISCORD WEBHOOK TEST ---
    if (type === 'webhook') {
      let realUrl = config.url;
      
      // Fetch the real URL from the database if masked
      if (realUrl === '********') {
          const dbHook = await prisma.discordWebhook.findUnique({ where: { id: config.id } });
          realUrl = dbHook?.url;
      }

      if (!realUrl) return NextResponse.json({ success: false, message: 'Missing Webhook URL' });

      const payload: any = {
        content: null,
        embeds: [{
            title: "🔔 Omnibus Notification Test",
            description: `This is a test notification for the **${config.name || 'Unnamed'}** webhook. Connection is verified!`,
            color: 3447003,
            footer: { text: "Omnibus" },
            timestamp: new Date().toISOString()
        }]
      };

      if (config.botUsername) payload.username = config.botUsername;
      if (config.botAvatarUrl) payload.avatar_url = config.botAvatarUrl;

      // Make sure we use realUrl here!
      await axios.post(realUrl, payload, { timeout: 10000 });

      return NextResponse.json({ success: true, message: 'Test notification delivered!' });
    }

    // --- PROWLARR TEST ---
    if (type === 'prowlarr') {
      const url = config.prowlarr_url?.replace(/\/$/, '');
      
      const key = await getRealValue('prowlarr_key', config.prowlarr_key);
      
      if (!url || !key) return NextResponse.json({ success: false, message: 'Missing URL/Key' });

      const res = await axios.get(`${url}/api/v1/indexer`, { 
          headers: { 'X-Api-Key': key, ...headers },
          timeout: 10000
      });

      if (typeof res.data === 'string' && res.data.includes('<!DOCTYPE html>')) {
          return NextResponse.json({ success: false, message: "Connection Blocked: Cloudflare Access detected." });
      }

      return NextResponse.json({ success: true, message: `Connected to Prowlarr (${res.data.length} indexers).` });
    }

    // --- ANNA'S ARCHIVE (fast_download API key) ---
    if (type === 'annas_archive') {
        // The key lives in HosterAccount (encrypted), not SystemSetting.
        const account = await prisma.hosterAccount.findFirst({ where: { hoster: 'annas_archive', isActive: true } });
        const key = account?.apiKey ? await decryptSecret(account.apiKey) : "";
        const result = await testAnnasArchiveKey(key, config.annas_archive_base_url);
        return NextResponse.json({ success: result.success, message: result.message });
    }

    // --- CLOUDFLARE SOLVER TEST (FlareSolverr / Byparr) ---
    if (type === 'flaresolverr') {
        const url = config.flaresolverr_url?.replace(/\/$/, '');
        const solverName = config.solver_type === 'byparr' ? 'Byparr' : 'FlareSolverr';
        if (!url) return NextResponse.json({ success: false, message: `Missing ${solverName} URL` });

        // FlareSolverr's root returns JSON {msg, version}; Byparr's root redirects to its Swagger docs.
        const res = await axios.get(url, { timeout: 10000 });
        if (res.data && res.data.msg) {
            return NextResponse.json({ success: true, message: `FlareSolverr Connected! (v${res.data.version || 'Unknown'})` });
        }
        return NextResponse.json({ success: true, message: `${solverName} is reachable.` });
    }

    // --- MAPPING LOGIC ---
    if (type === 'mapping') {
        const { remote, local } = config;
        if (!remote || !local) return NextResponse.json({ success: false, message: "Both paths required." });
        const result = `${remote}/test.cbz`.replace(remote, local);
        return NextResponse.json({ success: true, message: `Logic Verified: ${result}` });
    }
    
    // --- PATHS ---
    if (type === 'paths') {
        return NextResponse.json({ success: true, message: "Paths checked (Simulated)" });
    }

    // --- COMICVINE ---
    if (type === 'comicvine') {
      const apiKey = await getRealValue('cv_api_key', config.cv_api_key);

      if (!apiKey) return NextResponse.json({ success: false, message: 'Missing API Key' });
      await axios.get(`https://comicvine.gamespot.com/api/types/`, {
        params: { api_key: apiKey, format: 'json' },
        headers: { ...headers },
        timeout: 10000
      });
      return NextResponse.json({ success: true, message: 'ComicVine Connected!' });
    }

    // --- METRON.CLOUD ---
    if (type === 'metron') {
      const user = config.metron_user;
      const pass = await getRealValue('metron_pass', config.metron_pass);

      if (!user || !pass) return NextResponse.json({ success: false, message: 'Missing Username or Password' });
      
      await axios.get(`https://metron.cloud/api/series/`, {
        headers, // <-- FIX: Injected headers (includes 'User-Agent': 'Omnibus/1.0')
        auth: { username: user, password: pass },
        timeout: 10000
      });
      return NextResponse.json({ success: true, message: 'Metron.Cloud Connected!' });
    }

    return NextResponse.json({ success: false, message: 'Unknown test type' });

  } catch (error: unknown) {
    const msg = getErrorMessage(error) || "Connection Failed";
    // --- UPDATED: Include the test type in the terminal output ---
    Logger.log(`[Test API] ${type.toUpperCase()} Test Error: ${msg}`, 'error');
    
    if ((error as any)?.response?.status === 401 && type === 'metron') {
        return NextResponse.json({ success: false, message: "Invalid Metron.Cloud credentials.", code: "UNAUTHORIZED" });
    }
    return NextResponse.json({ success: false, message: msg, code: "CONNECTION_ERROR" });
  }
}