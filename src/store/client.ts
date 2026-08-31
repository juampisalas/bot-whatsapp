// src/store/client.ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.ts'

// DDL idempotente emite 42710/42P06/42P07 sin indicar error; filtrarlos mantiene tests y migraciones limpios.
const BENIGN_NOTICE_CODES = new Set(['42710', '42P06', '42P07'])

export function handlePostgresNotice(notice: postgres.Notice): void {
  if (BENIGN_NOTICE_CODES.has(notice.code ?? '')) {
    return
  }
  console.warn(notice)
}

export function createDb(connectionString: string) {
  const sql = postgres(connectionString, {
    max: 10,
    // Abort hung statements so shutdown / buffer flush cannot wait forever on a black-holed DB.
    connection: { statement_timeout: 15_000 },
    onnotice: handlePostgresNotice,
  })
  const db = drizzle(sql, { schema })
  return {
    db,
    sql,
    close: () => sql.end({ timeout: 5 }),
  }
}

export type Db = ReturnType<typeof createDb>['db']
