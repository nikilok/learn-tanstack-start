import dotenv from 'dotenv';
import { defineConfig } from 'drizzle-kit';

dotenv.config({ path: '../../.env.local' });

export default defineConfig({
  schema: '../../packages/db/src/schema.ts',
  out: '../../packages/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.POSTGRES_URL as string,
  },
});
