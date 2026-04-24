import { prisma } from '../lib/uploadJobsDb.js';

function parseArgs(argv) {
  const out = { yes: false };
  for (const a of argv) {
    if (a === '--yes' || a === '-y') out.yes = true;
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

  const before = await prisma.uploadJob.count();
  const { count: deleted } = await prisma.uploadJob.deleteMany({});
  const after = await prisma.uploadJob.count();

  console.log('upload_jobs cleared', {
    deleted,
    before,
    after,
  });
}

main().catch((err) => {
  console.error('Failed to clear upload_jobs', {
    message: err?.message,
    stack: err?.stack,
  });
  process.exitCode = 1;
});
