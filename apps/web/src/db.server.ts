import { createClient } from '@ss/db';

export const db = createClient(process.env.POSTGRES_URL as string);
