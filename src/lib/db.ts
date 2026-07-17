import { PrismaClient } from '@prisma/client'
import { SECRET_SETTING_KEYS } from './secret-keys'
import { tunedSqliteUrl } from './sqlite-url'

// Transparently decrypt SystemSetting credential values on read, so every consumer across the app
// (~35 call sites) gets plaintext without per-site changes. Values are encrypted at rest by the
// admin config route + db-init. Both encryption formats are handled — enc:v1: (legacy AES-256-CBC)
// and enc:v2: (current AES-256-GCM) — so any enc:-prefixed secret-key value is decrypted while
// plaintext/legacy data passes straight through. (DATABASE_ENCRYPTION_KEY, not being a secret key,
// is never decrypted — so no recursion when decryptSecret looks it up.)
export async function decryptSettingRow(row: any, keyHint?: string): Promise<any> {
  if (!row) return row
  const key = row.key ?? keyHint
  const value = row.value
  if (typeof value === 'string' && key && SECRET_SETTING_KEYS.has(key) && value.startsWith('enc:')) {
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
  const sqliteUrl = tunedSqliteUrl()
  const base = sqliteUrl
    ? new PrismaClient({ datasources: { db: { url: sqliteUrl } } })
    : new PrismaClient()
  if (sqliteUrl) {
    // busy_timeout isn't a Prisma URL param. With connection_limit=1 this PRAGMA lands on the
    // single pooled connection and sticks for the process lifetime. Fire-and-forget: a failure
    // (e.g. during build-time import) just leaves Prisma's default behavior.
    base.$executeRawUnsafe('PRAGMA busy_timeout = 10000').catch(() => {})
  }
  return base.$extends({
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
