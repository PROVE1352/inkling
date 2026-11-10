import { defineConfig } from 'drizzle-kit'
import { config } from 'dotenv'

config({ path: ['.env', '../../.env'] })

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://inkling:inkling@localhost:55432/inkling',
  },
})
