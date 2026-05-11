self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    // Ignore Next.js development and hot-reload requests
    if (
        event.request.url.includes('/_next/') || 
        event.request.url.includes('/__nextjs') ||
        event.request.url.includes('chrome-extension')
    ) {
        return;
    }

    event.respondWith(
        fetch(event.request).catch((err) => {
            // If the network is entirely offline, fail gracefully
            console.error('PWA Network request failed:', err);
            throw err;
        })
    );
});