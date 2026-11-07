import { defineConfig } from 'drizzle-kit'
import { config } from 'dotenv'

config({ path: ['.env', '../../.env'] })

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://nodian:nodian@localhost:55432/nodian',
  },
})
