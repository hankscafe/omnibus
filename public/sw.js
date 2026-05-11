self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    // Ignore Next.js development and extension requests
    if (
        event.request.url.includes('/_next/') || 
        event.request.url.includes('/__nextjs') ||
        event.request.url.includes('chrome-extension')
    ) {
        return;
    }

    event.respondWith(
        fetch(event.request).catch((err) => {
            // CRITICAL PWA FIX: Only return the HTML fallback for actual page navigation
            if (event.request.mode === 'navigate') {
                return new Response(
                    '<html><head><title>Omnibus Offline</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="background:#0f172a;color:#94a3b8;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;"><h2>Omnibus is Offline</h2><p>Please check your internet connection.</p></body></html>',
                    { status: 200, headers: { 'Content-Type': 'text/html' } }
                );
            }
            
            // For background API requests (like clicking a button), return a safe JSON response
            return new Response(
                JSON.stringify({ success: false, error: 'You are currently offline.' }),
                { status: 503, headers: { 'Content-Type': 'application/json' } }
            );
        })
    );
});