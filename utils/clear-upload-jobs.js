import { db, dbPath } from '../lib/uploadJobsDb.js';

function parseArgs(argv) {
  const out = { yes: false, vacuum: false };
  for (const a of argv) {
    if (a === '--yes' || a === '-y') out.yes = true;
    if (a === '--vacuum') out.vacuum = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.yes) {
    console.error('Refusing to clear upload_jobs without confirmation flag.');
    console.error('Run: node utils/clear-upload-jobs.js --yes');
    process.exitCode = 2;
    return;
  }

  const before = db.prepare('SELECT COUNT(1) AS c FROM upload_jobs').get()?.c ?? 0;

  const tx = db.transaction(() => {
    db.exec('DELETE FROM upload_jobs;');
  });
  tx();

  const after = db.prepare('SELECT COUNT(1) AS c FROM upload_jobs').get()?.c ?? 0;

  if (args.vacuum) {
    try {
      db.exec('VACUUM;');
    } catch {
      // ignore
    }
  }

  console.log('upload_jobs cleared', {
    dbPath,
    deleted: Math.max(0, before - after),
    before,
    after,
    vacuum: Boolean(args.vacuum),
  });
}

main().catch((err) => {
  console.error('Failed to clear upload_jobs', {
    message: err?.message,
    stack: err?.stack,
  });
  process.exitCode = 1;
});
