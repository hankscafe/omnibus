export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        // #199: honor the *arr-convention UMASK env var BEFORE anything touches disk, so everything
        // this process creates (library folders, the SQLite db, covers, logs) gets the operator's
        // chosen default modes. The container runs as a fixed uid; without this, new folders are
        // 0755 — read-only for every other account on shared storage. Unset/invalid = leave the
        // process umask alone. try/catch: setting a umask is POSIX-only, never let it stop boot.
        const umask = (process.env.UMASK || '').trim();
        if (/^[0-7]{1,4}$/.test(umask)) {
            try { process.umask(parseInt(umask, 8)); } catch { /* unsupported platform (Windows dev) */ }
        }

        const { initDatabase } = await import('./lib/db-init');
        await initDatabase();

        const { initCronJobs } = await import('./lib/cron');
        initCronJobs();

        // Initialize BullMQ Worker
        const { initWorker } = await import('./lib/queue');
        initWorker();
    }
}