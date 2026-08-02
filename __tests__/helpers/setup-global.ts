// __tests__/helpers/setup-global.ts
//
// Global mocks for the observability/infra modules that ~130 per-file copies used to hand-roll
// (beta.014 test refactor). Registered via vitest.config `setupFiles`, so every test file gets
// them. A per-file vi.mock for the same path still overrides these (last registration wins), and
// a file that needs the REAL module calls vi.unmock — __tests__/lib/logger.test.ts does exactly
// that to test the real Logger/isoWeekKey.
//
// The spies are exported because ~24 files assert on logger/audit calls. `clearMocks: true` in
// vitest.config wipes call history between tests but keeps the default implementations set here
// (mockClear, not mockReset) — so the resolved-Promise defaults survive every test.
import { vi } from 'vitest';

const spies = vi.hoisted(() => ({
    loggerLog: vi.fn(),
    loggerSetLevel: vi.fn(),
    // Routes chain .catch() onto these — a bare vi.fn() returning undefined would throw.
    auditLog: vi.fn().mockResolvedValue(true),
    notifierSendAlert: vi.fn().mockResolvedValue(true),
    discordSendAlert: vi.fn().mockResolvedValue(true),
    getAuthOptions: vi.fn().mockResolvedValue({}),
    revalidatePath: vi.fn(),
    revalidateTag: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: spies.loggerLog, setLevel: spies.loggerSetLevel } }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: spies.auditLog } }));
vi.mock('@/lib/notifications', () => ({ SystemNotifier: { sendAlert: spies.notifierSendAlert } }));
vi.mock('@/lib/discord', () => ({
    DiscordNotifier: { sendAlert: spies.discordSendAlert },
    resolveDiscordThumbnail: vi.fn(() => null),
}));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: spies.getAuthOptions }));
vi.mock('next/cache', () => ({ revalidatePath: spies.revalidatePath, revalidateTag: spies.revalidateTag }));

export const loggerLog = spies.loggerLog;
export const loggerSetLevel = spies.loggerSetLevel;
export const auditLog = spies.auditLog;
export const notifierSendAlert = spies.notifierSendAlert;
export const discordSendAlert = spies.discordSendAlert;
export const getAuthOptionsMock = spies.getAuthOptions;
