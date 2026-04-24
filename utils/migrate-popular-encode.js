#!/usr/bin/env node
/**
 * Migrate script for PopularEncodeProgress table
 * Run: node utils/migrate-popular-encode.js
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');

console.log('='.repeat(60));
console.log('Popular Encode Progress Migration');
console.log('='.repeat(60));

const isWindows = process.platform === 'win32';
const npxCmd = isWindows ? 'npx.cmd' : 'npx';

function runCommand(cmd, args, description) {
  console.log(`\n> ${description}...`);
  console.log(`  Command: ${cmd} ${args.join(' ')}`);
  try {
    const result = execSync(`${cmd} ${args.join(' ')}`, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      encoding: 'utf-8',
    });
    console.log(`  ✓ ${description} completed`);
    return result;
  } catch (err) {
    console.error(`  ✗ ${description} failed:`, err.message);
    throw err;
  }
}

try {
  // Check if migrations folder exists
  const migrationsDir = path.join(PROJECT_ROOT, 'prisma', 'migrations');
  if (!existsSync(migrationsDir)) {
    console.log('\nCreating migrations directory...');
    runCommand('mkdir', ['-p', 'prisma/migrations'], 'Create migrations directory');
  }

  // Generate Prisma client first
  console.log('\n1. Generating Prisma Client...');
  runCommand(npxCmd, ['prisma', 'generate'], 'Generate Prisma Client');

  // Push database schema (quick sync for dev)
  console.log('\n2. Pushing schema to database (db push)...');
  runCommand(npxCmd, ['prisma', 'db', 'push'], 'Push schema to database');

  // Create a proper migration
  console.log('\n3. Creating migration...');
  runCommand(npxCmd, ['prisma', 'migrate', 'dev', '--name', 'add_popular_encode_progress'], 'Create migration');

  console.log('\n' + '='.repeat(60));
  console.log('✓ Migration completed successfully!');
  console.log('='.repeat(60));
  console.log('\nTable "popular_encode_progress" is now ready.');
  console.log('You can verify with:');
  console.log('  npm run db:studio');
  process.exit(0);
} catch (err) {
  console.error('\n' + '='.repeat(60));
  console.error('✗ Migration failed');
  console.error('='.repeat(60));
  console.error('\nTroubleshooting:');
  console.error('1. Ensure DATABASE_URL is set in .env');
  console.error('2. Ensure PostgreSQL is running');
  console.error('3. Check prisma/schema.prisma is valid');
  console.error('\nAlternative quick fix:');
  console.error('  npx prisma db push --accept-data-loss');
  process.exit(1);
}
