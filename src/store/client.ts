// src/store/client.ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.ts'

interface PostgresNotice {
  severity: string
  code: string
  message: string
}

// DDL idempotente emite 42710/42P06/42P07 sin indicar error; filtrarlos mantiene tests y migraciones limpios.
const BENIGN_NOTICE_CODES = new Set(['42710', '42P06', '42P07'])

function handlePostgresNotice(raw: postgres.Notice): void {
  const notice: PostgresNotice = {
    severity: raw.severity ?? '',
    code: raw.code ?? '',
    message: raw.message ?? '',
  }
  if (BENIGN_NOTICE_CODES.has(notice.code)) {
    return
  }
  console.warn(notice.message)
}

export function createDb(connectionString: string) {
  const sql = postgres(connectionString, {
    max: 10,
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
