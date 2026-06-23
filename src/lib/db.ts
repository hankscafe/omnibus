import { PrismaClient } from '@prisma/client'
import { SECRET_SETTING_KEYS } from './secret-keys'

// Transparently decrypt SystemSetting credential values on read, so every consumer across the app
// (~35 call sites) gets plaintext without per-site changes. Values are encrypted at rest by the
// admin config route + db-init; the Rust engine has a matching decrypt (secret_crypto.rs). Only
// enc:v1:-prefixed secret-key values are touched, so plaintext/legacy data passes straight through
// (and DATABASE_ENCRYPTION_KEY, not being a secret key, is never decrypted — so no recursion when
// decryptSecret looks it up).
async function decryptSettingRow(row: any, keyHint?: string): Promise<any> {
  if (!row) return row
  const key = row.key ?? keyHint
  const value = row.value
  if (typeof value === 'string' && key && SECRET_SETTING_KEYS.has(key) && value.startsWith('enc:v1:')) {
    try {
      const { decryptSecret } = await import('./encryption')
      return { ...row, value: await decryptSecret(value) }
    } catch {
      // Undecryptable (e.g. NEXTAUTH_SECRET changed) — return as-is rather than breaking reads.
      return row
    }
  }
  return row
}

function createPrismaClient() {
  return new PrismaClient().$extends({
    query: {
      systemSetting: {
        async findMany({ args, query }) {
          const rows = await query(args)
          return Promise.all((rows as any[]).map((r) => decryptSettingRow(r)))
        },
        async findUnique({ args, query }) {
          return decryptSettingRow(await query(args), (args as any)?.where?.key)
        },
        async findFirst({ args, query }) {
          return decryptSettingRow(await query(args), (args as any)?.where?.key)
        },
      },
    },
  }) as unknown as PrismaClient
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
