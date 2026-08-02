// __tests__/helpers/session.ts
//
// Canonical session/token fixtures for NEW tests (beta.014). Existing files keep their local id
// spellings — retrofitting would change asserted user ids for zero behavioral gain. Prefer these
// in new tests so the suite converges on two shapes instead of eleven.
export const adminSession = (overrides: Record<string, any> = {}) =>
    ({ user: { id: 'admin_1', role: 'ADMIN', ...overrides } });

export const userSession = (overrides: Record<string, any> = {}) =>
    ({ user: { id: 'user_1', role: 'USER', ...overrides } });

/** JWT-shaped fixture for routes read via next-auth/jwt getToken. */
export const adminToken = (overrides: Record<string, any> = {}) =>
    ({ id: 'admin_1', role: 'ADMIN', ...overrides });
