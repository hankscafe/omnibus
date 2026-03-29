import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import axios from 'axios';
import { getErrorMessage } from '@/lib/utils/error';

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

    // --- HELPER: Resolve obfuscated keys from the DB ---
    const getRealValue = async (key: string, providedValue: string) => {
        if (providedValue === '********') {
            const setting = await prisma.systemSetting.findUnique({ where: { key } });
            return setting?.value || "";
        }
        return providedValue;
    };

    // --- CLIENTS TEST ---
    if (type === 'clients') {
        const { clientType, url, user, pass, apiKey } = config;
        const cleanUrl = url?.replace(/\/$/, "");

        if (!cleanUrl) return NextResponse.json({ success: false, message: 'Missing Client URL' });

        if (clientType === 'qbit') {
            const loginParams = new URLSearchParams();
            loginParams.append('username', user || '');
            
            // Resolve real password if frontend sent the obfuscated placeholder
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
            // Resolve real API key if obfuscated
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
      
      // Resolve the real key from DB if the placeholder was sent
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
      // Resolve the real key from DB if the placeholder was sent
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