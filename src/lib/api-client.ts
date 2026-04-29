// src/lib/api-client.ts
import axios from 'axios';
import https from 'https';
import http from 'http';

// Create a persistent connection pool
const httpsAgent = new https.Agent({ 
    keepAlive: true, 
    maxSockets: 10,
    keepAliveMsecs: 10000 // Keep connection alive for 10 seconds of inactivity
});

const httpAgent = new http.Agent({ 
    keepAlive: true, 
    maxSockets: 10 
});

export const apiClient = axios.create({
    httpAgent,
    httpsAgent,
    timeout: 15000,
    headers: { 'User-Agent': 'Omnibus/1.0' }
});