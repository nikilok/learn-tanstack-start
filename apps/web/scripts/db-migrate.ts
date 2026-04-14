import { runMigrations } from '@ss/db';
import dotenv from 'dotenv';

dotenv.config({ path: '../../.env.local' });

await runMigrations(process.env.POSTGRES_URL as string);
