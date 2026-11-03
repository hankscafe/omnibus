import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, [
    fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
    'run', '--pool=forks', '--disableConsoleIntercept', '__tests__/integration/transmission-live.test.ts',
    ...process.argv.slice(2),
], {
    stdio: 'inherit',
    env: { ...process.env, TRANSMISSION_LIVE_DOCKER: '1' },
});

child.on('error', error => {
    console.error(error);
    process.exitCode = 1;
});
child.on('exit', code => {
    process.exitCode = code ?? 1;
});