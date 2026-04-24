import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);

const g = typeof globalThis !== 'undefined' ? globalThis : global;
if (!g.__prisma) {
  g.__prisma = new PrismaClient({ adapter });
}

export const prisma = g.__prisma;
