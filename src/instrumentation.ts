export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { initDatabase } = await import('./lib/db-init');
        await initDatabase();

        const { initCronJobs } = await import('./lib/cron');
        initCronJobs();
    }
}