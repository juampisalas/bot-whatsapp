import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './client.ts'

export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDb(connectionString)
  try {
    await migrate(handle.db, { migrationsFolder: './drizzle' })
  } finally {
    await handle.close()
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  await runMigrations(url)
  console.log('Migrations applied')
}
