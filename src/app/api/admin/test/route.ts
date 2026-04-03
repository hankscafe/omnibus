// src/app/api/admin/test/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import axios from 'axios';
import { getErrorMessage } from '@/lib/utils/error';
import { Mailer } from '@/lib/mailer';

export async function POST(request: Request) {
  let type = 'unknown';

  try {
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
                hData.forEach((h: any) => { 
                    if (h.key && h.value) headers[h.key] = h.value; 
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
            // Test Weekly Digest Format with rich dummy objects
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

            // Use the mailer to generate the actual template so we test exactly what users see
            const htmlContent = await Mailer.buildWeeklyDigestHtml(dummyComics, dummyManga);

            await transporter.sendMail({
                from: smtp_from || 'omnibus@localhost',
                to: test_email,
                subject: "Omnibus Weekly Digest (Test)",
                html: htmlContent
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
                ? (await prisma.downloadClient.findFirst({ where: { url: config.url } }))?.pass || ""
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
                ? (await prisma.downloadClient.findFirst({ where: { url: config.url } }))?.apiKey || ""
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
        
        return NextResponse.json({ success: true, message: 'Client Ping Sent.' });
    }

    // --- DISCORD WEBHOOK TEST ---
    if (type === 'webhook') {
      if (!config.url) return NextResponse.json({ success: false, message: 'Missing Webhook URL' });

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

      await axios.post(config.url, payload, { timeout: 10000 });

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

    return NextResponse.json({ success: false, message: 'Unknown test type' });

  } catch (error: unknown) {
    const msg = getErrorMessage(error) || "Connection Failed";
    return NextResponse.json({ success: false, message: msg, code: "CONNECTION_ERROR" });
  }
}